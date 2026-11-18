const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { FFPROBE, PROBE_VERSION, probe, limiter } = require('./ffmpeg');
const { parseMedia } = require('./parse');
const metadata = require('./metadata');
const catalog = require('./catalog');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg', '.flv', '.3gp', '.ogv']);

// Fields produced by parseMedia (a file can switch between movie and episode between scans).
const PARSED_FIELDS = ['kind', 'title', 'year', 'show', 'showKey', 'showYear', 'season', 'episode', 'episodeEnd', 'extraOf', 'extraGroup', 'extraPath', 'numbered'];

const status = { running: false, library: null, libraryId: null, queued: [], found: 0, done: 0, total: 0, lastScan: null };

const idFor = (file) => crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // Skip hidden folders, $RECYCLE.BIN, System Volume Information, macOS metadata.
    if (/^[.$]|^System Volume Information$|^@eaDir$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// A library folder that doesn't exist here probably came from another machine (via D1 or a
// copied data/ folder). Look for it: the same path under this machine's home folder
// (/Users/alice/Downloads/x -> /Users/media/Downloads/x, or C:\Users\…), then a
// folder with the same name in the usual places and on other drives.
function findMovedFolder(oldPath) {
  const home = os.homedir();
  const parts = oldPath.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1];
  const candidates = [];
  const inHome = oldPath.match(/^(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\\/]+[\\/](.+)$/i);
  if (inHome) candidates.push(path.join(home, ...inHome[1].split(/[\\/]+/)));
  for (const dir of ['', 'Downloads', 'Movies', 'Videos', 'Desktop', 'Documents', 'Media']) candidates.push(path.join(home, dir, name));
  const roots = process.platform === 'win32'
    ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`)
    : process.platform === 'darwin'
      ? safeList('/Volumes').map((v) => path.join('/Volumes', v))
      : [...safeList('/mnt').map((v) => path.join('/mnt', v)), ...safeList(path.join('/media', os.userInfo().username)).map((v) => path.join('/media', os.userInfo().username, v))];
  for (const root of roots) candidates.push(path.join(root, name), path.join(root, 'Media', name));
  return [...new Set(candidates)].find(isDir) || null;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Point libraries whose folder moved at their new location; leave the rest flagged as missing.
function relocateLibraries() {
  for (const lib of db.state.libraries) {
    if (isDir(lib.path)) continue;
    const found = findMovedFolder(lib.path);
    if (found) {
      console.log(`[scan] ${lib.name}: folder moved, using ${found} (was ${lib.path})`);
      lib.path = found;
      db.save();
    } else {
      console.warn(`[scan] ${lib.name}: folder not found on this machine: ${lib.path} (change it in Settings)`);
    }
  }
}

async function scanLibrary(lib) {
  // An unplugged drive or unmoved folder: keep what we knew rather than emptying the library.
  if (!isDir(lib.path)) return;
  status.library = lib.name;
  status.libraryId = lib.id;
  status.found = 0;
  const files = [];
  await walk(lib.path, files);
  status.found = files.length;

  const seen = new Set();
  const toProbe = [];
  for (const file of files) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st) continue;
    // Skip release "sample" clips.
    if (/\bsample\b/i.test(path.basename(file)) && st.size < 200 * 1024 * 1024) continue;
    // .ts is also TypeScript; without ffprobe there's no way to tell a video from source code.
    if (!FFPROBE && path.extname(file).toLowerCase() === '.ts') continue;

    const id = idFor(file);
    seen.add(id);
    const existing = db.state.items[id];
    const parsed = parseMedia(file, lib);
    // Re-parse from scratch each scan; drop what no longer applies if the guess changed.
    const kept = { ...existing };
    for (const key of PARSED_FIELDS) delete kept[key];
    const item = {
      ...kept,
      ...parsed,
      id,
      libraryId: lib.id,
      path: file,
      size: st.size,
      mtime: st.mtimeMs,
      addedAt: existing?.addedAt ?? Math.round(Math.max(st.birthtimeMs || 0, st.mtimeMs)),
    };
    // Anything new or changed must be confirmed as video by ffprobe before it's listed or served.
    const needsProbe = !existing || existing.mtime !== st.mtimeMs || !existing.probed || !existing.video || existing.probeVersion !== PROBE_VERSION;
    // Only re-probing for newer details (same file, already confirmed as video): keep it if that fails.
    if (FFPROBE && needsProbe) toProbe.push(Object.assign(item, { _refresh: !!(existing?.probed && existing.video && existing.mtime === st.mtimeMs) }));
    if (existing || !FFPROBE) db.state.items[id] = item;
  }

  for (const [id, item] of Object.entries(db.state.items)) {
    if (item.libraryId === lib.id && !seen.has(id)) delete db.state.items[id];
  }

  status.total += toProbe.length;
  const limit = limiter(4);
  let rejected = 0;
  await Promise.all(toProbe.map((item) => limit(async () => {
    const info = await probe(item.path).catch(() => null);
    const refresh = item._refresh;
    delete item._refresh;
    if (info?.video) {
      Object.assign(item, info, { probed: true, probeVersion: PROBE_VERSION, probeError: undefined });
      db.state.items[item.id] = item;
    } else if (refresh) {
      // Keep what we knew; it's tried again next scan.
    } else {
      // Not a video (audio-only, unreadable, still downloading, or not media at all).
      delete db.state.items[item.id];
      rejected++;
    }
    status.done++;
  })));
  if (rejected) console.log(`[scan] ${lib.name}: skipped ${rejected} file(s) that ffprobe couldn't confirm as video`);
  metadata.placeNumbered(); // parsing just reset season/episode to what the file names say
  db.save();
}

// Library ids waiting to be scanned; null entry in the set means "all".
const queued = new Set();

async function scan(libraryIds) {
  for (const id of libraryIds || [null]) queued.add(id);
  if (status.running) return;
  status.running = true;
  status.done = 0;
  status.total = 0;
  try {
    while (queued.size) {
      const ids = queued.has(null) ? null : [...queued];
      queued.clear();
      const libs = db.state.libraries.filter((l) => !ids || ids.includes(l.id));
      relocateLibraries();
      for (const [i, lib] of libs.entries()) {
        status.queued = libs.slice(i + 1).map((l) => l.id);
        await scanLibrary(lib);
      }
    }
  } finally {
    status.running = false;
    status.library = null;
    status.libraryId = null;
    status.queued = [];
    status.lastScan = Date.now();
    db.save();
  }
  catalog.update();
  metadata.refresh();
}

module.exports = { scan, status, VIDEO_EXT, isDir, findMovedFolder };
