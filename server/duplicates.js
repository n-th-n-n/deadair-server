// Titles with more than one file: the same movie, or the same episode, found twice anywhere in any
// library (matched by title key, so different folders and file names still count). Each copy says
// where it is on disk and what it is, so you can see 4K-vs-1080p pairs apart from plain repeats.
const path = require('node:path');
const db = require('./db');
const metadata = require('./metadata');
const { mediaKey } = require('./keys');
const { resolution, hdr, RANK } = require('./quality');

// Where a file is and what's in it. Paths are relative to the library, like the Folders view.
function fileView(item) {
  const lib = db.state.libraries.find((l) => l.id === item.libraryId);
  const rel = lib ? path.relative(lib.path, item.path).split(path.sep) : [path.basename(item.path)];
  const v = item.video || {};
  return {
    id: item.id,
    libraryId: item.libraryId,
    library: lib?.name || 'Unknown library',
    folder: rel.slice(0, -1).join('/'),
    fileName: rel[rel.length - 1],
    quality: resolution(v),
    hdr: hdr(v),
    codec: v.codec || null,
    width: v.width || null,
    height: v.height || null,
    size: item.size || 0,
    bitrate: item.bitrate || 0,
    duration: item.duration || 0,
  };
}

// Best first: resolution, then HDR, then bitrate, then size.
const best = (a, b) => (RANK[b.quality] || 0) - (RANK[a.quality] || 0)
  || !!b.hdr - !!a.hdr || b.bitrate - a.bitrate || b.size - a.size;

// Every file grouped by title key.
function byKey() {
  const groups = new Map();
  for (const item of Object.values(db.state.items)) {
    const key = mediaKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// The other files of the same title as `item` (for its details page).
function copiesOf(item) {
  const key = mediaKey(item);
  return Object.values(db.state.items).filter((i) => i.id !== item.id && mediaKey(i) === key).map(fileView).sort(best);
}

// How many files each title key has (for badges in the Folders view).
function counts() {
  const n = new Map();
  for (const item of Object.values(db.state.items)) n.set(mediaKey(item), (n.get(mediaKey(item)) || 0) + 1);
  return n;
}

function group(items) {
  const files = items.map(fileView).sort(best);
  // Same size to the byte is almost certainly the same file copied twice.
  for (const f of files) f.identical = files.some((o) => o !== f && o.size === f.size && f.size > 0);
  // No point picking a "best" between two identical files.
  files[0].best = !(files[1].identical && files[1].size === files[0].size);
  const label = (f) => [f.quality || '?', f.hdr].filter(Boolean).join(' ');
  const qualities = [...new Set(files.map(label))];
  return {
    // "quality": different versions (e.g. 4K + 1080p); "same": the same quality more than once.
    type: new Set(files.map((f) => f.quality)).size > 1 ? 'quality' : 'same',
    qualities,
    files,
    // Space freed by keeping only the best copy.
    extraBytes: files.slice(1).reduce((n, f) => n + f.size, 0),
  };
}

function list() {
  const movies = [];
  const shows = new Map();
  for (const items of byKey().values()) {
    if (items.length < 2) continue;
    const first = items[0];
    const g = group(items);
    if (first.kind === 'episode') {
      const meta = metadata.showMeta(first.showKey);
      if (!shows.has(first.showKey)) {
        shows.set(first.showKey, { showKey: first.showKey, libraryId: first.libraryId, title: meta?.title || first.show, year: meta?.year ?? first.showYear ?? null, poster: meta?.poster || null, episodes: [] });
      }
      const ep = metadata.episodeMeta(first);
      shows.get(first.showKey).episodes.push({ ...g, season: first.season, episode: first.episode, episodeEnd: first.episodeEnd, title: ep?.name || first.title });
    } else {
      const meta = metadata.movieMeta(first);
      movies.push({ ...g, title: meta?.title || first.title, year: meta?.year ?? first.year ?? null, poster: meta?.poster || null });
    }
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.year || 0) - (b.year || 0);
  const showList = [...shows.values()].sort(byTitle).map((s) => {
    s.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 1e9) - (b.episode ?? 1e9));
    return {
      ...s,
      type: s.episodes.some((e) => e.type === 'quality') ? 'quality' : 'same',
      qualities: [...new Set(s.episodes.flatMap((e) => e.qualities))],
      extraBytes: s.episodes.reduce((n, e) => n + e.extraBytes, 0),
    };
  });
  const all = [...movies, ...showList];
  return {
    movies: movies.sort(byTitle),
    shows: showList,
    totals: {
      titles: movies.length + showList.length,
      files: movies.reduce((n, m) => n + m.files.length, 0) + showList.reduce((n, s) => n + s.episodes.reduce((k, e) => k + e.files.length, 0), 0),
      quality: all.filter((g) => g.type === 'quality').length,
      same: all.filter((g) => g.type === 'same').length,
      extraBytes: all.reduce((n, g) => n + g.extraBytes, 0),
    },
  };
}

module.exports = { list, copiesOf, counts, fileView };
