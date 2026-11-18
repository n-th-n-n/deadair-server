// deadair-api: stores Deadair's own data (libraries, watch history, TMDB matches, account
// records, a few settings, Live TV channels and sources) in the deadair-db D1 database for the home server, which can't bind D1 itself.
//
// Every request needs `Authorization: Bearer <API_SECRET>`.
//   POST /data/load   {}                 -> every row of every table
//   POST /data/write  { ops: [...] }     -> upserts/deletes, applied as one transaction
// File lists of the library drives (`npm run inventory`), kept apart from the data above:
//   POST /inventory/put      { drive, snapshot, files: [{ path, size, mtime }] } -> upserts
//   POST /inventory/prune    { drive, snapshot } -> removes that drive's files not seen in `snapshot`
//   POST /inventory/summary  { drive }           -> { files, bytes, snapshot }
// This Worker has no access to users-db or any other database.

interface Env {
  DATA_DB: D1Database;
  API_SECRET: string;
}

type Table = 'libraries' | 'progress' | 'matches' | 'accounts' | 'settings' | 'channels' | 'sources';
type Op = { t: Table; op: 'put'; row: Record<string, unknown> } | { t: Table; op: 'del'; key: unknown[] };

// Column types per table; `updated_at` is stamped here except for progress, which carries its own.
const TABLES: Record<Table, { cols: Record<string, 'text' | 'real' | 'int' | 'real?'>; pk: string[] }> = {
  libraries: { cols: { id: 'text', name: 'text', path: 'text' }, pk: ['id'] },
  progress: { cols: { user_id: 'text', media_key: 'text', position: 'real', duration: 'real?', watched: 'int', updated_at: 'int' }, pk: ['user_id', 'media_key'] },
  matches: { cols: { key: 'text', data: 'text' }, pk: ['key'] },
  accounts: { cols: { user_id: 'text', data: 'text' }, pk: ['user_id'] },
  settings: { cols: { key: 'text', value: 'text' }, pk: ['key'] },
  channels: { cols: { id: 'text', data: 'text' }, pk: ['id'] },
  sources: { cols: { id: 'text', data: 'text' }, pk: ['id'] },
};

const MAX_OPS = 40; // stays under D1's per-invocation query limit on the free plan
const MAX_TEXT = 1_000_000;
const enc = new TextEncoder();

const json = (body: unknown, status = 200) => Response.json(body, { status });

// Constant-time secret check: compare fixed-length digests, never the raw strings.
async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function check(type: string, value: unknown): boolean {
  switch (type) {
    case 'text': return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;
    case 'real': return typeof value === 'number' && Number.isFinite(value);
    case 'real?': return value === null || (typeof value === 'number' && Number.isFinite(value));
    case 'int': return Number.isInteger(value);
    default: return false;
  }
}

// Turns one op into a parameterized statement, or throws on anything unexpected.
function statement(db: D1Database, op: Op): D1PreparedStatement {
  const spec = TABLES[op.t];
  if (!spec) throw new Error(`unknown table ${String(op.t)}`);
  if (op.op === 'del') {
    if (!Array.isArray(op.key) || op.key.length !== spec.pk.length || !op.key.every((v) => check('text', v))) throw new Error(`bad key for ${op.t}`);
    return db.prepare(`DELETE FROM ${op.t} WHERE ${spec.pk.map((c) => `${c} = ?`).join(' AND ')}`).bind(...op.key);
  }
  if (op.op !== 'put' || !op.row || typeof op.row !== 'object') throw new Error('bad op');
  const cols = Object.keys(spec.cols);
  for (const c of cols) if (!check(spec.cols[c], op.row[c])) throw new Error(`bad ${op.t}.${c}`);
  const values = cols.map((c) => op.row[c]);
  if (!('updated_at' in spec.cols)) {
    cols.push('updated_at');
    values.push(Date.now());
  }
  const updates = cols.filter((c) => !spec.pk.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ');
  return db
    .prepare(`INSERT INTO ${op.t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT (${spec.pk.join(', ')}) DO UPDATE SET ${updates}`)
    .bind(...values);
}

type InventoryFile = { path: string; size: number; mtime: number };
const MAX_PATH = 4096;
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isFile = (f: InventoryFile) => typeof f?.path === 'string' && f.path.length > 0 && f.path.length <= MAX_PATH
  && Number.isSafeInteger(f.size) && f.size >= 0 && Number.isSafeInteger(f.mtime);

async function inventory(route: string, body: Record<string, unknown>, db: D1Database): Promise<Response> {
  const { drive, snapshot } = body;
  if (!isName(drive)) return json({ error: 'drive required' }, 400);
  if (route === '/inventory/summary') {
    const row = await db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, MAX(snapshot) AS snapshot FROM inventory WHERE drive = ?')
      .bind(drive).first();
    return json(row);
  }
  if (!isName(snapshot)) return json({ error: 'snapshot required' }, 400);
  if (route === '/inventory/prune') {
    const res = await db.prepare('DELETE FROM inventory WHERE drive = ? AND snapshot <> ?').bind(drive, snapshot).run();
    return json({ ok: true, removed: res.meta.changes ?? 0 });
  }
  if (route === '/inventory/put') {
    const files = body.files as InventoryFile[];
    if (!Array.isArray(files) || !files.length) return json({ error: 'files required' }, 400);
    if (files.length > MAX_OPS) return json({ error: `at most ${MAX_OPS} files per request` }, 400);
    if (!files.every(isFile)) return json({ error: 'bad file entry' }, 400);
    const put = db.prepare('INSERT INTO inventory (drive, path, size, mtime, snapshot) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (drive, path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, snapshot = excluded.snapshot');
    await db.batch(files.map((f) => put.bind(drive, f.path, f.size, f.mtime, snapshot))); // all-or-nothing
    return json({ ok: true, applied: files.length });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (!(await authorized(request, env.API_SECRET))) return json({ error: 'Unauthorized' }, 401);

    if (pathname === '/data/load') {
      const [libraries, progress, matches, accounts, settings, channels, sources] = await env.DATA_DB.batch([
        env.DATA_DB.prepare('SELECT id, name, path FROM libraries'),
        env.DATA_DB.prepare('SELECT user_id, media_key, position, duration, watched, updated_at FROM progress'),
        env.DATA_DB.prepare('SELECT key, data FROM matches'),
        env.DATA_DB.prepare('SELECT user_id, data FROM accounts'),
        env.DATA_DB.prepare('SELECT key, value FROM settings'),
        env.DATA_DB.prepare('SELECT id, data FROM channels'),
        env.DATA_DB.prepare('SELECT id, data FROM sources'),
      ]);
      return json({
        libraries: libraries.results, progress: progress.results, matches: matches.results, accounts: accounts.results,
        settings: settings.results, channels: channels.results, sources: sources.results,
      });
    }

    if (pathname === '/data/write') {
      let body: { ops?: Op[] };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const ops = body?.ops;
      if (!Array.isArray(ops) || !ops.length) return json({ error: 'ops required' }, 400);
      if (ops.length > MAX_OPS) return json({ error: `at most ${MAX_OPS} ops per request` }, 400);
      let statements: D1PreparedStatement[];
      try {
        statements = ops.map((op) => statement(env.DATA_DB, op));
      } catch (err) {
        return json({ error: (err as Error).message }, 400);
      }
      await env.DATA_DB.batch(statements); // all-or-nothing
      return json({ ok: true, applied: statements.length });
    }

    if (pathname.startsWith('/inventory/')) {
      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      return inventory(pathname, body ?? {}, env.DATA_DB);
    }

    return json({ error: 'Not found' }, 404);
  },
};
