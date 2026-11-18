// Channels from outside Deadair: M3U playlists with an optional XMLTV guide. That covers an
// HDHomeRun antenna tuner (http://<tuner-ip>/lineup.m3u), free ad-supported channel lists, or a
// service you subscribe to that gives you an M3U link.
//
// Only each source's settings are kept in db.json (and D1). Its channel list and guide are
// downloaded every few hours and cached in data/live/, so a restart doesn't wait on them.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const db = require('./db');
const { DATA_DIR } = require('./config');

const CACHE_DIR = path.join(DATA_DIR, 'live');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const HOUR = 60 * 60 * 1000;
const REFRESH_MS = 6 * HOUR;
const GUIDE_BEHIND = 2 * HOUR; // guide entries kept from before now
const GUIDE_AHEAD = 4 * 24 * HOUR;
const MAX_PLAYLIST = 50 * 1024 * 1024;
const UA = 'Deadair/1.0';

const { state } = db;
const sources = () => (state.sources ||= []);
const cache = new Map(); // source id -> { channels, guideUrl, programs, fetchedAt, error, guideAt, guideError, refreshing }
const entry = (id) => cache.get(id) || cache.set(id, {}).get(id);
const cacheFile = (id) => path.join(CACHE_DIR, `${id.replace(/[^\w-]/g, '')}.json`);

const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
// For matching guide channels by name: "2.1 KCBS-HD" and "KCBS" are the same channel.
const norm = (s) => String(s || '').toLowerCase().replace(/^\s*\d+([.-]\d+)?\s+/, '').replace(/\b(hd|sd|fhd|uhd|4k)\b/g, '').replace(/[^a-z0-9]+/g, '');

// ---------- reading ----------

// A URL, or a file on this machine (admins only get here).
async function open(url, timeout) {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'} from ${new URL(url).host}`);
    return Readable.fromWeb(res.body);
  }
  const file = url.replace(/^file:\/\//i, '');
  await fsp.access(file).catch(() => { throw new Error(`File not found: ${file}`); });
  return fs.createReadStream(file);
}

// Text from a stream, un-gzipping it first if it's a .gz file (common for XMLTV guides).
async function* textOf(stream) {
  const it = stream[Symbol.asyncIterator]();
  const head = await it.next();
  if (head.done) return;
  const rest = Readable.from((async function* () {
    yield head.value;
    for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
  })(), { objectMode: false });
  let body = rest;
  if (head.value[0] === 0x1f && head.value[1] === 0x8b) {
    body = zlib.createGunzip();
    rest.on('error', (err) => body.destroy(err));
    rest.pipe(body);
  }
  const decoder = new TextDecoder();
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  yield decoder.decode();
}

// ---------- M3U ----------

const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2].trim()]));

// #EXTINF:-1 tvg-id="…" tvg-logo="…" group-title="…",Channel name
function parseExtinf(line) {
  let quoted = false;
  let comma = -1;
  for (let i = 8; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ',' && !quoted) {
      comma = i;
      break;
    }
  }
  const a = attrs(comma < 0 ? line : line.slice(0, comma));
  return {
    name: (comma < 0 ? '' : line.slice(comma + 1)).trim() || a['tvg-name'] || '',
    tvgId: a['tvg-id'] || '',
    logo: a['tvg-logo'] || '',
    group: a['group-title'] || '',
    number: a['tvg-chno'] || a['channel-number'] || a['tvg-num'] || '',
  };
}

function parseM3u(text) {
  const header = {};
  const channels = [];
  const seen = new Map();
  let cur = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) Object.assign(header, attrs(line));
    else if (line.startsWith('#EXTINF')) cur = parseExtinf(line);
    else if (line.startsWith('#EXTGRP:')) { if (cur && !cur.group) cur.group = line.slice(8).trim(); }
    else if (line.startsWith('#EXTVLCOPT:')) {
      // Some lists need a particular user agent or referrer to play.
      const [k, ...v] = line.slice(11).split('=');
      if (cur && k.trim() === 'http-user-agent') cur.userAgent = v.join('=').trim();
      if (cur && /^http-referr?er$/.test(k.trim())) cur.referer = v.join('=').trim();
    } else if (!line.startsWith('#')) {
      const ch = cur || { name: line, tvgId: '', logo: '', group: '', number: '' };
      ch.url = line;
      ch.name ||= ch.tvgId || line;
      // Stable key within the source, so selections and guide data survive a refresh.
      const base = shortHash(ch.tvgId ? `id:${ch.tvgId}:${ch.name}` : `name:${ch.name}`);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      ch.key = n ? shortHash(`${base}#${n}`) : base;
      channels.push(ch);
      cur = null;
    }
  }
  if (!channels.length) throw new Error('No channels found. Is this an M3U playlist?');
  return { channels, guideUrl: header['x-tvg-url'] || header['url-tvg'] || header['tvg-url'] || '' };
}

async function loadPlaylist(url) {
  let text = '';
  for await (const chunk of textOf(await open(url, 60000))) {
    text += chunk;
    if (text.length > MAX_PLAYLIST) throw new Error('Playlist is too large');
  }
  return parseM3u(text);
}

// ---------- XMLTV ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ENTITIES[e.toLowerCase()]))
  .trim();

const TAGS = Object.fromEntries(['title', 'sub-title', 'desc', 'date', 'display-name'].map((t) => [t, new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`)]));
const CATEGORY = /<category\b[^>]*>([\s\S]*?)<\/category>/g;
const ICON = /<icon\b[^>]*\bsrc="([^"]+)"/;
const EPISODE = /<episode-num\b[^>]*system="(onscreen|xmltv_ns)"[^>]*>([\s\S]*?)<\/episode-num>/g;
const tag = (el, name) => {
  const m = el.match(TAGS[name]);
  return m ? unxml(m[1]) : '';
};

// "20260930200000 +0100" -> ms
function xmltvTime(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/);
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const offset = m[7] ? (m[7] === '-' ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * 60000 : 0;
  return utc - offset;
}

// "S2 E5" from onscreen, or from xmltv_ns ("1.4.0/1": zero-based season.episode.part).
function episodeOf(el) {
  let onscreen = '';
  let ns = '';
  for (const m of el.matchAll(EPISODE)) (m[1] === 'onscreen' ? (onscreen = unxml(m[2])) : (ns = unxml(m[2])));
  if (onscreen) return onscreen;
  const [s, e] = ns.split('.').map((p) => parseInt(p, 10));
  return Number.isFinite(e) ? `${Number.isFinite(s) ? `S${s + 1} ` : ''}E${e + 1}` : '';
}

// Streams through the guide file (they can be hundreds of MB) keeping only programs for
// `channels`, from a little before now to a few days ahead. Returns { channel key: [programs] }.
async function readGuide(url, channels) {
  const push = (map, k, v) => (map.get(k) || map.set(k, []).get(k)).push(v);
  const byId = new Map();
  const byName = new Map();
  const byNumber = new Map();
  for (const ch of channels) {
    if (ch.tvgId) push(byId, ch.tvgId.toLowerCase(), ch.key);
    push(byName, norm(ch.name), ch.key);
    if (ch.number) push(byNumber, ch.number, ch.key);
  }
  const route = new Map(); // guide's channel id -> our channel keys
  const target = (id) => route.get(id) || byId.get(id.toLowerCase());
  const programs = {};
  const from = Date.now() - GUIDE_BEHIND;
  const to = Date.now() + GUIDE_AHEAD;

  const onChannel = (el) => {
    const id = unxml(el.match(/\bid="([^"]*)"/)?.[1] || '');
    if (!id || byId.has(id.toLowerCase())) return;
    // No tvg-id match: fall back to the channel's display names, then its number (tuner guides
    // often list "2.1" as one of the names).
    const names = [...el.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map((m) => unxml(m[1]));
    const keys = names.map((n) => byName.get(norm(n))).find(Boolean) || names.map((n) => byNumber.get(n)).find(Boolean);
    if (keys) route.set(id, keys);
  };
  const onProgramme = (el) => {
    const head = el.slice(0, el.indexOf('>'));
    const keys = target(unxml(head.match(/\bchannel="([^"]*)"/)?.[1] || ''));
    if (!keys) return;
    const start = xmltvTime(head.match(/\bstart="([^"]*)"/)?.[1]);
    const stop = xmltvTime(head.match(/\bstop="([^"]*)"/)?.[1]);
    if (!(start < to) || !(stop > from) || !(stop > start)) return;
    const p = { start, stop, title: tag(el, 'title') || 'Untitled' };
    const subtitle = tag(el, 'sub-title');
    const desc = tag(el, 'desc');
    const icon = el.match(ICON)?.[1];
    const episode = episodeOf(el);
    const genres = [...el.matchAll(CATEGORY)].map((m) => unxml(m[1])).filter(Boolean).slice(0, 3);
    const year = parseInt(tag(el, 'date'), 10);
    if (subtitle) p.subtitle = subtitle;
    if (desc) p.desc = desc.slice(0, 1000);
    if (icon) p.image = unxml(icon);
    if (episode) p.episodeCode = episode;
    if (genres.length) p.genres = genres;
    if (year) p.year = year;
    for (const k of keys) (programs[k] ||= []).push(p);
  };

  let buf = '';
  const opening = /<(channel|programme)[\s>]/g;
  for await (const text of textOf(await open(url, 10 * 60000))) {
    buf += text;
    let pos = 0;
    for (;;) {
      opening.lastIndex = pos;
      const hit = opening.exec(buf);
      if (!hit) {
        pos = Math.max(pos, buf.length - 16); // keep a tag that may be split across chunks
        break;
      }
      const close = `</${hit[1]}>`;
      const end = buf.indexOf(close, hit.index);
      if (end < 0) {
        pos = hit.index;
        break;
      }
      const el = buf.slice(hit.index, end + close.length);
      pos = end + close.length;
      if (hit[1] === 'channel') onChannel(el);
      else onProgramme(el);
    }
    buf = buf.slice(pos);
    if (buf.length > 20 * 1024 * 1024) throw new Error('Guide file doesn’t look like XMLTV');
  }
  for (const list of Object.values(programs)) {
    list.sort((a, b) => a.start - b.start);
    // Drop overlaps (duplicate listings from merged guides).
    for (let i = list.length - 1; i > 0; i--) if (list[i].start < list[i - 1].stop && list[i].start === list[i - 1].start) list.splice(i, 1);
  }
  return programs;
}

// ---------- sources ----------

const selections = new WeakMap();
function isIncluded(src, key) {
  if (src.include === 'all') return true;
  if (!Array.isArray(src.include)) return false;
  if (!selections.has(src.include)) selections.set(src.include, new Set(src.include));
  return selections.get(src.include).has(key);
}

const included = (src) => (entry(src.id).channels || []).filter((ch) => isIncluded(src, ch.key));
const guideUrlOf = (src) => src.guideUrl || entry(src.id).guideUrl || '';

async function writeCache(id, c) {
  const { refreshing, ...data } = c;
  const file = cacheFile(id);
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(data));
  await fsp.rename(`${file}.tmp`, file);
}

// Downloads the playlist (unless `guideOnly`), then the guide for the selected channels.
function refresh(src, { guideOnly = false } = {}) {
  const c = entry(src.id);
  if (c.refreshing) return c.refreshing;
  c.refreshing = (async () => {
    if (!guideOnly || !c.channels) {
      try {
        Object.assign(c, await loadPlaylist(src.url), { fetchedAt: Date.now(), error: null });
      } catch (err) {
        c.error = err.message;
        console.warn(`[live] ${src.name}: couldn't load the playlist: ${err.message}`);
      }
    }
    const guideUrl = guideUrlOf(src);
    if (c.channels && guideUrl) {
      try {
        c.programs = await readGuide(guideUrl, included(src));
        c.guideAt = Date.now();
        c.guideError = null;
      } catch (err) {
        c.guideError = err.message;
        console.warn(`[live] ${src.name}: couldn't load the guide: ${err.message}`);
      }
    } else if (!guideUrl) {
      c.programs = {};
      c.guideError = null;
    }
    await writeCache(src.id, c).catch((err) => console.warn(`[live] couldn't cache ${src.name}: ${err.message}`));
  })().finally(() => { c.refreshing = null; });
  return c.refreshing;
}

function refreshStale() {
  for (const src of sources()) {
    const c = entry(src.id);
    if (!c.refreshing && Date.now() - (c.fetchedAt || 0) > REFRESH_MS) refresh(src);
  }
}

function start() {
  for (const src of sources()) {
    try {
      Object.assign(entry(src.id), JSON.parse(fs.readFileSync(cacheFile(src.id), 'utf8')));
    } catch {}
  }
  refreshStale();
  setInterval(refreshStale, 15 * 60 * 1000).unref();
}

// ---------- editing ----------

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

function validate(input, existing) {
  const name = clean(input?.name ?? existing?.name, 80);
  const url = clean(input?.url ?? existing?.url, 2000);
  const guideUrl = clean(input?.guideUrl ?? existing?.guideUrl, 2000);
  if (!name) throw new Error('Give the source a name');
  if (!url) throw new Error('The playlist (M3U) address is required');
  const firstNumber = Math.max(1, Math.min(99999, parseInt(input?.firstNumber ?? existing?.firstNumber, 10) || 100));
  const proxy = input?.proxy != null ? !!input.proxy : existing?.proxy ?? true;
  let include = input?.include ?? existing?.include ?? 'all';
  if (include !== 'all') include = [...new Set((Array.isArray(include) ? include : []).map((k) => clean(k, 20)).filter(Boolean))].slice(0, 20000);
  return { name, url, guideUrl, firstNumber, proxy, include };
}

// Adds a source after checking its playlist loads. Big lists start with nothing selected.
async function create(input) {
  const fields = validate({
    ...input,
    firstNumber: input?.firstNumber || Math.max(0, ...sources().map((s) => s.firstNumber)) + 100,
  });
  const { channels, guideUrl } = await loadPlaylist(fields.url);
  const src = { id: crypto.randomUUID().slice(0, 8), ...fields, include: channels.length <= 300 ? 'all' : [], createdAt: Date.now() };
  Object.assign(entry(src.id), { channels, guideUrl, fetchedAt: Date.now(), error: null });
  sources().push(src);
  db.save();
  refresh(src, { guideOnly: true });
  return src;
}

function update(id, input) {
  const src = sources().find((s) => s.id === id);
  if (!src) return null;
  const before = JSON.stringify([src.url, src.guideUrl, src.include]);
  const urlChanged = input?.url != null && clean(input.url, 2000) !== src.url;
  Object.assign(src, validate(input, src));
  db.save();
  // New selection or guide address: fetch the guide for it. New playlist address: fetch everything.
  if (JSON.stringify([src.url, src.guideUrl, src.include]) !== before) refresh(src, { guideOnly: !urlChanged });
  return src;
}

function remove(id) {
  const before = sources().length;
  state.sources = sources().filter((s) => s.id !== id);
  cache.delete(id);
  fsp.rm(cacheFile(id), { force: true }).catch(() => {});
  db.save();
  return state.sources.length < before;
}

// ---------- views ----------

function status(src) {
  const c = entry(src.id);
  return {
    ...src,
    channelCount: c.channels?.length || 0,
    includedCount: included(src).length,
    guideChannels: Object.keys(c.programs || {}).length,
    hasGuide: !!guideUrlOf(src),
    fetchedAt: c.fetchedAt || null,
    guideAt: c.guideAt || null,
    error: c.error || null,
    guideError: c.guideError || null,
    refreshing: !!c.refreshing,
  };
}

// Every channel in a source's playlist, for choosing which to show.
function channelsOf(src) {
  return (entry(src.id).channels || []).map((ch) => ({
    key: ch.key, name: ch.name, number: ch.number, group: ch.group, logo: ch.logo, included: isIncluded(src, ch.key),
  }));
}

// The selected channels of every source, numbered: the playlist's own numbers where it has
// them, otherwise counting up from the source's first channel number.
function lineup() {
  const out = [];
  for (const src of sources()) {
    let next = src.firstNumber;
    for (const ch of included(src)) {
      out.push({
        id: `${src.id}-${ch.key}`,
        kind: 'external',
        number: ch.number || String(next++),
        name: ch.name,
        logo: ch.logo || null,
        group: ch.group || src.name,
        src,
        ch,
      });
    }
  }
  return out;
}

function programs(srcId, key, from, to) {
  return (entry(srcId).programs?.[key] || []).filter((p) => p.stop > from && p.start < to);
}

module.exports = {
  list: () => sources(),
  find: (id) => sources().find((s) => s.id === id),
  start, refresh, create, update, remove, status, channelsOf, lineup, programs,
  parseM3u, readGuide, // for tests
};
