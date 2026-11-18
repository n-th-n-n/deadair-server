// Keeps Deadair's own data in D1 (deadair-db) through the deadair-api Worker:
// libraries, watch history, TMDB matches, account records, the TMDB key, and Live TV channels and
// sources. The file index, channel schedules and downloaded guides stay local.
//
// The server always works from its local copy (data/db.json), so pages stay fast and keep
// working if Cloudflare is unreachable. After any change, rows that differ from what D1
// last confirmed are written through in small batches. At startup D1 is loaded and merged:
// rows changed locally since the last sync win, everything else comes from D1.
const crypto = require('node:crypto');
const db = require('./db');
const { api } = require('./worker');
const { movieKey, mediaKey } = require('./keys');

const { state } = db;
const status = { enabled: api.configured(), state: api.configured() ? 'starting' : 'off', lastSync: null, pending: 0, error: null };

const MAX_OPS = 40;
const MAX_BYTES = 4 * 1024 * 1024;
const PK = { libraries: ['id'], progress: ['user_id', 'media_key'], matches: ['key'], accounts: ['user_id'], settings: ['key'], channels: ['id'], sources: ['id'] };
// Tables added after the first release. They're only synced once D1 confirms it has them, since an
// older deadair-api would reject the whole batch (`npm run setup:cloud` updates it).
const LATER_TABLES = ['channels', 'sources'];
let laterTables = false;
const syncs = (t) => laterTables || !LATER_TABLES.includes(t);
// Settings that follow Deadair to a new machine. Plugins add their own with roam() (they register
// before start() loads from D1).
const ROAMING_SETTINGS = ['tmdbKey'];
function roam(keys) {
  for (const key of keys) if (!ROAMING_SETTINGS.includes(key)) ROAMING_SETTINGS.push(key);
}

const rowId = (t, key) => JSON.stringify([t, ...key]);
const hash = (row) => crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex');
const synced = () => (state.synced ||= {}); // rowId -> hash of the row as D1 last confirmed it

// Everything that lives in D1, as rows keyed by table + primary key.
function rows() {
  const out = new Map();
  const add = (t, row) => {
    if (!syncs(t)) return;
    const key = PK[t].map((c) => row[c]);
    out.set(rowId(t, key), { t, key, row });
  };
  for (const lib of state.libraries) add('libraries', { id: lib.id, name: lib.name, path: lib.path });
  for (const [userId, bucket] of Object.entries(state.progress || {})) {
    if (userId === '_legacy') continue;
    for (const [key, p] of Object.entries(bucket)) {
      add('progress', {
        user_id: userId,
        media_key: key,
        position: Number(p.position) || 0,
        duration: Number.isFinite(p.duration) ? p.duration : null,
        watched: p.watched ? 1 : 0,
        updated_at: Math.round(p.updatedAt || 0),
      });
    }
  }
  for (const [key, m] of Object.entries(state.matches || {})) add('matches', { key, data: JSON.stringify(m) });
  for (const [userId, a] of Object.entries(state.accounts || {})) add('accounts', { user_id: userId, data: JSON.stringify(a) });
  for (const key of ROAMING_SETTINGS) if (state.settings?.[key]) add('settings', { key, value: String(state.settings[key]) });
  // Improvement notes travel as one settings row holding the whole list.
  if (state.notes?.length) add('settings', { key: 'notes', value: JSON.stringify(state.notes) });
  // The title catalog (catalog.js): one settings row per title, "catalog:<key>".
  for (const [key, entry] of Object.entries(state.catalog || {})) add('settings', { key: `catalog:${key}`, value: JSON.stringify(entry) });
  for (const ch of state.channels || []) add('channels', { id: ch.id, data: JSON.stringify(ch) });
  for (const src of state.sources || []) add('sources', { id: src.id, data: JSON.stringify(src) });
  return out;
}

function put(t, r) {
  if (t === 'libraries') {
    const lib = state.libraries.find((l) => l.id === r.id);
    if (lib) Object.assign(lib, { name: r.name, path: r.path });
    else state.libraries.push({ id: r.id, name: r.name, path: r.path });
  } else if (t === 'progress') {
    (state.progress[r.user_id] ||= {})[r.media_key] = { position: r.position, duration: r.duration, watched: !!r.watched, updatedAt: r.updated_at };
  } else if (t === 'matches') {
    (state.matches ||= {})[r.key] = JSON.parse(r.data);
  } else if (t === 'accounts') {
    (state.accounts ||= {})[r.user_id] = JSON.parse(r.data);
  } else if (t === 'settings' && r.key === 'notes') {
    state.notes = JSON.parse(r.value);
  } else if (t === 'settings' && r.key.startsWith('catalog:')) {
    (state.catalog ||= {})[r.key.slice('catalog:'.length)] = JSON.parse(r.value);
  } else if (t === 'settings' && ROAMING_SETTINGS.includes(r.key)) {
    (state.settings ||= {})[r.key] = r.value;
  } else if (t === 'channels' || t === 'sources') {
    const list = (state[t] ||= []);
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) list[i] = JSON.parse(r.data);
    else list.push(JSON.parse(r.data));
  }
}

function remove(t, key) {
  if (t === 'libraries') {
    state.libraries = state.libraries.filter((l) => l.id !== key[0]);
    for (const [id, item] of Object.entries(state.items)) if (item.libraryId === key[0]) delete state.items[id];
  } else if (t === 'progress') {
    delete state.progress[key[0]]?.[key[1]];
  } else if (t === 'matches') {
    delete state.matches?.[key[0]];
  } else if (t === 'accounts') {
    delete state.accounts?.[key[0]];
  } else if (t === 'settings' && key[0] === 'notes') {
    state.notes = [];
  } else if (t === 'settings' && key[0].startsWith('catalog:')) {
    delete state.catalog?.[key[0].slice('catalog:'.length)];
  } else if (t === 'settings') {
    delete state.settings?.[key[0]];
  } else if (t === 'channels' || t === 'sources') {
    state[t] = (state[t] || []).filter((x) => x.id !== key[0]);
  }
}

// ---------- startup ----------

// One-time conversion of data saved by older versions: watch history keyed by file,
// TMDB matches stored on files or per library -> everything keyed by title (keys.js).
function migrateLocal() {
  let changed = false;
  // A TMDB key given in .env becomes a synced setting, so other machines get it from D1.
  if (process.env.TMDB_API_KEY && !state.settings?.tmdbKey) {
    (state.settings ||= {}).tmdbKey = process.env.TMDB_API_KEY;
    changed = true;
  }
  for (const bucket of Object.values(state.progress || {})) {
    for (const [key, p] of Object.entries(bucket)) {
      if (key.includes(':')) continue; // already a title key
      const item = state.items[key];
      if (item) {
        const k = mediaKey(item);
        if (!bucket[k] || (bucket[k].updatedAt || 0) < (p.updatedAt || 0)) bucket[k] = p;
      }
      delete bucket[key];
      changed = true;
    }
  }
  const matches = (state.matches ||= {});
  for (const item of Object.values(state.items)) {
    if (!('meta' in item) && !('metaMiss' in item)) continue;
    const rec = item.meta ? { meta: item.meta } : item.metaMiss ? { miss: item.metaMiss } : null;
    if (item.kind === 'movie' && rec && !matches[movieKey(item)]) matches[movieKey(item)] = rec;
    delete item.meta;
    delete item.metaMiss;
    changed = true;
  }
  if (state.shows) {
    for (const [k, rec] of Object.entries(state.shows)) {
      const key = `show:${k.slice(k.indexOf('/') + 1)}`;
      const next = rec.meta ? { meta: rec.meta } : rec.miss ? { miss: rec.miss } : null;
      if (next && !matches[key]) matches[key] = next;
    }
    delete state.shows;
    changed = true;
  }
  if (changed) db.save();
}

async function pull() {
  const remote = await api.call('/data/load', {}, { timeout: 30000 });
  laterTables = LATER_TABLES.every((t) => Array.isArray(remote[t]));
  status.note = laterTables ? null : 'Live TV channels are only on this server until you run `npm run setup:cloud` (it updates deadair-api)';
  if (!laterTables) console.log(`[sync] ${status.note}`);
  const base = synced();
  const local = rows();
  const theirs = new Map();
  for (const t of Object.keys(PK)) {
    for (const row of remote[t] || []) {
      const key = PK[t].map((c) => row[c]);
      theirs.set(rowId(t, key), { t, key, row });
    }
  }
  const taken = [];
  for (const id of new Set([...local.keys(), ...theirs.keys(), ...Object.keys(base)])) {
    const mine = local.get(id);
    const changedHere = mine ? hash(mine.row) !== base[id] : base[id] !== undefined;
    if (changedHere) continue; // unsynced local edit or delete: push() sends it
    const other = theirs.get(id);
    if (other) put(other.t, other.row);
    else if (mine) remove(mine.t, mine.key);
    taken.push(id);
  }
  const now = rows();
  for (const id of taken) {
    const r = now.get(id);
    if (r) base[id] = hash(r.row);
    else delete base[id];
  }
  return { rows: theirs.size, applied: taken.length };
}

let ready = false;

async function start() {
  if (!api.configured()) return;
  try {
    const { rows: n } = await pull();
    console.log(`[sync] loaded ${n} rows from D1`);
  } catch (err) {
    status.error = err.message;
    console.warn(`[sync] couldn't load from D1, using the local copy: ${err.message}`);
  }
  ready = true;
  db.save(); // keep the merged result locally and send anything D1 doesn't have yet
}

// ---------- writing through ----------

let timer = null;
let pushing = false;
let again = false;
let failing = false;

function schedule(delay = 2000) {
  if (!ready) return;
  clearTimeout(timer);
  timer = setTimeout(push, delay);
}

async function push() {
  if (pushing) {
    again = true;
    return;
  }
  pushing = true;
  try {
    const base = synced();
    const current = rows();
    const ops = [];
    for (const [id, r] of current) {
      const h = hash(r.row);
      if (base[id] !== h) ops.push({ id, h, op: { t: r.t, op: 'put', row: r.row } });
    }
    for (const id of Object.keys(base)) {
      if (current.has(id)) continue;
      const [t, ...key] = JSON.parse(id);
      if (!syncs(t)) continue;
      ops.push({ id, h: null, op: { t, op: 'del', key } });
    }
    status.pending = ops.length;
    while (ops.length) {
      const batch = [];
      let bytes = 0;
      while (ops.length && batch.length < MAX_OPS) {
        const size = JSON.stringify(ops[0].op).length;
        if (batch.length && bytes + size > MAX_BYTES) break;
        batch.push(ops.shift());
        bytes += size;
      }
      await api.call('/data/write', { ops: batch.map((o) => o.op) }, { timeout: 30000 });
      for (const o of batch) {
        if (o.h) base[o.id] = o.h;
        else delete base[o.id];
      }
      status.pending = ops.length;
      status.lastSync = Date.now();
      db.save();
    }
    status.state = 'ok';
    status.error = null;
    if (failing) console.log('[sync] D1 is reachable again, caught up');
    failing = false;
  } catch (err) {
    status.state = 'error';
    status.error = err.message;
    if (!failing) console.warn(`[sync] couldn't write to D1 (will keep retrying): ${err.message}`);
    failing = true;
    schedule(30000);
  } finally {
    pushing = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

db.onSave(() => schedule());

module.exports = { status, migrateLocal, start, roam };
