// Saves a list of every file on each library drive (path, size, last modified) to D1, so if a
// drive dies you still know exactly what was on it. Also keeps a local copy in data/inventory/.
//
//   npm run inventory                  every library in data/db.json that is mounted
//   npm run inventory -- "Home Drive"  just that library
//
// Each run replaces the drive's list in D1: files no longer there are removed at the end.
// Only reads the drives. Uses DEADAIR_API_URL / DEADAIR_API_SECRET from .env, like the server.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const { api } = createRequire(import.meta.url)(path.join(ROOT, 'server', 'worker.js'));

const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', '.Spotlight-V100', '.fseventsd',
  '.Trashes', '.TemporaryItems', '.DocumentRevisions-V100']);
// Deadair's own hidden working folders on a drive (a plugin's unfinished downloads, say).
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith('.deadair-');
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const BATCH = 40; // the Worker's per-request limit
const PARALLEL = 4;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// Every regular file under `root`, skipping system folders and macOS/Windows clutter.
function walk(root) {
  const files = [];
  const pending = [''];
  while (pending.length) {
    const rel = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (err) {
      console.warn(`  ! couldn't read ${rel || '/'}: ${err.message}`);
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDir(e.name)) pending.push(child);
      } else if (e.isFile() && !SKIP_FILES.has(e.name) && !e.name.startsWith('._')) {
        try {
          const st = fs.statSync(path.join(root, child));
          files.push({ path: child, size: st.size, mtime: Math.round(st.mtimeMs) });
        } catch (err) {
          console.warn(`  ! couldn't read ${child}: ${err.message}`);
        }
      }
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function call(route, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api.call(route, body, { timeout: 30000 });
    } catch (err) {
      if (attempt >= 4 || (err.status && err.status < 500)) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function upload(drive, files) {
  const snapshot = new Date().toISOString();
  const batches = [];
  for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      await call('/inventory/put', { drive, snapshot, files: batch });
      done += batch.length;
      if (done % 2000 < BATCH || done === files.length) console.log(`  uploaded ${done}/${files.length}`);
    }
  }));
  const { removed } = await call('/inventory/prune', { drive, snapshot });
  return { snapshot, removed };
}

function saveLocal(drive, files) {
  const dir = path.join(DATA_DIR, 'inventory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${drive.replace(/[^\w.-]+/g, '-')}.tsv`);
  const lines = files.map((f) => `${f.path}\t${f.size}\t${new Date(f.mtime).toISOString()}`);
  fs.writeFileSync(file, `path\tbytes\tmodified\n${lines.join('\n')}\n`);
  return file;
}

if (!api.configured()) fail('DEADAIR_API_URL / DEADAIR_API_SECRET are not set in .env (run `npm run setup:cloud`).');
let libraries;
try {
  libraries = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8')).libraries || [];
} catch (err) {
  fail(`couldn't read the libraries from ${path.join(DATA_DIR, 'db.json')}: ${err.message}`);
}
const only = process.argv[2];
const chosen = only ? libraries.filter((l) => l.name === only) : libraries;
if (!chosen.length) fail(only ? `no library called "${only}"` : 'no libraries set up yet');

console.log(`\n=== inventory run ${new Date().toISOString()}`);
let failed = false;
for (const lib of chosen) {
  console.log(`\n▶ ${lib.name} (${lib.path})`);
  if (!fs.existsSync(lib.path)) {
    console.log('  skipped: not mounted');
    continue;
  }
  const files = walk(lib.path);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  console.log(`  ${files.length} files, ${(bytes / 1e9).toFixed(1)} GB`);
  console.log(`  local copy: ${saveLocal(lib.name, files)}`);
  try {
    const { snapshot, removed } = await upload(lib.name, files);
    const cloud = await call('/inventory/summary', { drive: lib.name });
    const match = cloud.files === files.length && cloud.bytes === bytes && cloud.snapshot === snapshot;
    console.log(`  ${match ? '✓' : '✗'} D1 has ${cloud.files} files, ${(cloud.bytes / 1e9).toFixed(1)} GB`
      + (removed ? ` (${removed} no longer on the drive were removed)` : ''));
    if (!match) failed = true;
  } catch (err) {
    console.error(`  ✗ upload failed: ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
