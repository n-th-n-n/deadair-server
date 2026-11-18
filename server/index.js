const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const config = require('./config');
const db = require('./db');
const { FFMPEG, FFPROBE } = require('./ffmpeg');
const scanner = require('./scanner');
const media = require('./media');
const hls = require('./hls');
const metadata = require('./metadata');
const auth = require('./auth');
const store = require('./store');
const catalog = require('./catalog');
const live = require('./live');
const channels = require('./channels');
const sources = require('./sources');
const { mediaKey } = require('./keys');
const duplicates = require('./duplicates');
const missing = require('./missing');
const extras = require('./extras');
const cast = require('./cast');
const plugins = require('./plugins');
const playlog = require('./playlog');
const { resolution, hdr } = require('./quality');
const { episodeOrder } = require('./parse');

const app = express();
// Only a proxy on this machine (e.g. `tailscale serve` for HTTPS) may set X-Forwarded-*,
// so req.secure / req.ip reflect the real client. Remote clients can't spoof them.
app.set('trust proxy', 'loopback');
// A plugin route can parse its own body instead (e.g. with a bigger size limit; see plugins.js).
const json = express.json();
app.use((req, res, next) => (plugins.parsesOwnBody(req) ? next() : json(req, res, next)));
app.use(express.static(path.join(config.ROOT, 'public')));
app.use('/plugins', plugins.assets); // each plugin's public/ folder
// Plugins' routes on this machine, such as their own relays (they check for loopback themselves).
app.use('/_plugins', plugins.local);
// Chromecasts fetch videos here with a signed link instead of a login (see cast.js).
app.get('/cast/:token/:stream', castStream);
// Everything under /api needs a session, except the login endpoints themselves.
app.use('/api/auth', auth.router);
app.use('/api', auth.requireAuth);

// ---------- helpers ----------

const { state } = db;

// Watch history is per account and per title: state.progress[userId][mediaKey] (see keys.js).
// History from before logins existed is handed to the first account that signs in.
if (Object.values(state.progress).some((p) => p && 'updatedAt' in p)) {
  state.progress = { _legacy: state.progress };
  db.save();
}
auth.onLogin((user) => {
  if (state.progress._legacy && !state.progress[user.id]) {
    state.progress[user.id] = state.progress._legacy;
    delete state.progress._legacy;
    db.save();
  }
});

// Convert data saved by older versions to title keys before anything reads it.
store.migrateLocal();

const progressOf = (req) => (state.progress[req.user.id] ||= {});

// Only admins see where things live on disk.
const libraryView = (lib, req) => (req.user.admin ? { id: lib.id, name: lib.name, path: lib.path } : { id: lib.id, name: lib.name });

// Unverified entries (e.g. from before videos were confirmed by ffprobe) are treated as missing.
function getItem(req, res) {
  const item = state.items[req.params.id];
  if (!item || !media.isServable(item)) {
    res.status(404).json({ error: 'Item not found' });
    return null;
  }
  return item;
}

function showEpisodes(libraryId, showKey) {
  return Object.values(state.items)
    .filter((i) => i.libraryId === libraryId && i.showKey === showKey)
    .sort(episodeOrder);
}

// Lightweight shape for grids/lists; TMDB data wins over filename guesses.
function summary(item, prog = {}) {
  const p = prog[mediaKey(item)];
  const base = {
    id: item.id,
    libraryId: item.libraryId,
    kind: item.kind,
    showKey: item.showKey,
    season: item.season,
    episode: item.episode,
    episodeEnd: item.episodeEnd,
    duration: item.duration || (metadata.movieMeta(item)?.runtime ? metadata.movieMeta(item).runtime * 60 : 0),
    addedAt: item.addedAt,
    quality: resolution(item.video),
    hdr: hdr(item.video),
    progress: p ? { position: p.position, watched: p.watched } : null,
  };
  if (item.kind === 'episode') {
    const show = metadata.showMeta(item.showKey);
    const ep = metadata.episodeMeta(item);
    return {
      ...base,
      show: show?.title || item.show,
      title: ep?.name || item.title,
      year: show?.year ?? item.showYear,
      still: ep?.still,
      genres: show?.genres,
      poster: show?.seasons?.[item.season]?.poster || show?.poster,
      backdrop: show?.backdrop,
    };
  }
  if (item.kind === 'video') return { ...base, title: item.title };
  if (item.kind === 'extra') return { ...base, title: item.title, group: item.extraGroup };
  const m = metadata.movieMeta(item);
  return {
    ...base,
    title: m?.title || item.title,
    year: m?.year ?? item.year,
    poster: m?.poster,
    backdrop: m?.backdrop,
    rating: m?.rating,
    genres: m?.genres,
  };
}

function showSummary(local, prog = {}) {
  const meta = metadata.showMeta(local.showKey);
  const eps = local.episodes.sort(episodeOrder);
  return {
    showKey: local.showKey,
    libraryId: local.libraryId,
    title: meta?.title || local.title,
    year: meta?.year ?? local.year,
    poster: meta?.poster,
    backdrop: meta?.backdrop,
    rating: meta?.rating,
    genres: meta?.genres,
    matched: !!meta,
    addedAt: Math.max(...eps.map((e) => e.addedAt)),
    seasonCount: new Set(eps.map((e) => e.season)).size,
    episodeCount: eps.length,
    unwatched: eps.filter((e) => !prog[mediaKey(e)]?.watched).length,
    thumbId: eps[0].id,
  };
}

const showsIn = (libraryId) => [...metadata.localShows().values()].filter((s) => s.libraryId === libraryId);

function nextEpisodeItem(item) {
  if (item.kind !== 'episode') return null;
  const eps = showEpisodes(item.libraryId, item.showKey);
  return eps[eps.findIndex((i) => i.id === item.id) + 1] || null;
}

// ---------- status / settings ----------

// Which commit is running (and when the auto-deployer last updated it), for Settings → Server.
const version = (() => {
  const git = (...args) => spawnSync('git', args, { cwd: config.ROOT, encoding: 'utf8' }).stdout?.trim() || null;
  const remote = git('config', '--get', 'remote.origin.url');
  // owner/repo from git@github.com:…, https://github.com/…, or an SSH alias like git@my-github:…
  const repo = remote?.match(/github[\w.-]*[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] || null;
  return { commit: git('rev-parse', '--short', 'HEAD'), date: git('log', '-1', '--format=%cI'), repo };
})();
const deployState = () => {
  try { return JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'deploy-state.json'), 'utf8')); } catch { return null; }
};

app.get('/api/status', auth.requireAdmin, (req, res) => {
  res.json({
    version,
    deploy: deployState(),
    ffmpeg: !!FFMPEG,
    ffprobe: !!FFPROBE,
    scan: scanner.status,
    metadata: metadata.status,
    tmdb: !!metadata.apiKey(),
    itemCount: Object.keys(state.items).length,
    platform: process.platform,
    sync: store.status,
    plugins: plugins.status(),
  });
});

const settingsView = () => ({
  tmdbConfigured: !!metadata.apiKey(),
  tmdbFromEnv: !!process.env.TMDB_API_KEY,
});

app.get('/api/settings', auth.requireAdmin, (req, res) => res.json(settingsView()));

app.put('/api/settings', auth.requireAdmin, async (req, res) => {
  if (req.body && 'tmdbKey' in req.body) {
    try {
      await metadata.setApiKey(req.body.tmdbKey);
    } catch (err) {
      return res.status(400).json({ error: err.status === 401 ? 'TMDB rejected that key' : `Could not reach TMDB: ${err.message}` });
    }
  }
  res.json(settingsView());
});

// ---------- libraries ----------

app.get('/api/libraries', (req, res) => {
  const counts = {};
  for (const i of Object.values(state.items)) {
    const c = (counts[i.libraryId] ||= { count: 0, movies: 0, shows: new Set() });
    c.count++;
    if (i.kind === 'episode') c.shows.add(i.showKey);
    else if (i.kind === 'movie') c.movies++;
  }
  res.json(state.libraries.map((l) => {
    const c = counts[l.id] || { count: 0, movies: 0, shows: new Set() };
    return { ...libraryView(l, req), count: c.count, movies: c.movies, shows: c.shows.size, missing: req.user.admin ? !scanner.isDir(l.path) : undefined };
  }));
});

app.post('/api/libraries', auth.requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  const libPath = req.body?.path && path.resolve(String(req.body.path).trim());
  if (!name || !libPath) return res.status(400).json({ error: 'Name and folder are required' });
  const st = await fsp.stat(libPath).catch(() => null);
  if (!st?.isDirectory()) return res.status(400).json({ error: `Folder not found: ${libPath}` });

  const lib = { id: crypto.randomUUID().slice(0, 8), name: String(name).trim(), path: libPath };
  state.libraries.push(lib);
  db.save();
  scanner.scan([lib.id]);
  res.status(201).json(lib);
});

// Rename a library or point it at a new folder (e.g. after moving to another machine).
// Same library id, so nothing else changes; the next scan picks up the files there.
app.patch('/api/libraries/:id', auth.requireAdmin, async (req, res) => {
  const lib = state.libraries.find((l) => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'Library not found' });
  if (req.body?.name != null) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name can’t be empty' });
    lib.name = name;
  }
  if (req.body?.path != null) {
    const libPath = path.resolve(String(req.body.path).trim());
    if (!scanner.isDir(libPath)) return res.status(400).json({ error: `Folder not found: ${libPath}` });
    lib.path = libPath;
  }
  db.save();
  if (req.body?.path != null) scanner.scan([lib.id]);
  res.json(lib);
});

app.delete('/api/libraries/:id', auth.requireAdmin, (req, res) => {
  const idx = state.libraries.findIndex((l) => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Library not found' });
  state.libraries.splice(idx, 1);
  // Only the file index goes. Watch history and TMDB matches belong to the titles, not the folder,
  // so they come back if the same videos are added again (e.g. from a new path).
  for (const [id, item] of Object.entries(state.items)) {
    if (item.libraryId === req.params.id) delete state.items[id];
  }
  db.save();
  res.json({ ok: true });
});

app.post('/api/scan', auth.requireAdmin, (req, res) => {
  scanner.scan(req.body?.libraryId ? [req.body.libraryId] : undefined);
  res.json(scanner.status);
});

// Folder view of a library: its folders and files as they are on disk, with the same artwork
// and TMDB details as everywhere else. Paths are relative to the library root, never full paths.
app.get('/api/libraries/:id/browse', (req, res) => {
  const lib = state.libraries.find((l) => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'Library not found' });
  const want = String(req.query.path || '').split('/').filter(Boolean);
  if (want.some((p) => p === '.' || p === '..')) return res.status(400).json({ error: 'Bad path' });
  const prog = progressOf(req);

  const folders = new Map(); // name -> items anywhere below it
  const files = [];
  const copies = duplicates.counts();
  for (const item of Object.values(state.items)) {
    if (item.libraryId !== lib.id) continue;
    const parts = path.relative(lib.path, item.path).split(path.sep);
    if (parts.length <= want.length || !want.every((p, i) => parts[i] === p)) continue;
    if (parts.length === want.length + 1) {
      files.push({ ...summary(item, prog), fileName: parts[parts.length - 1], copies: copies.get(mediaKey(item)) || 1 });
    } else {
      const name = parts[want.length];
      if (!folders.has(name)) folders.set(name, []);
      folders.get(name).push(item);
    }
  }
  if (want.length && !files.length && !folders.size) return res.status(404).json({ error: 'Folder not found' });

  const folderViews = [...folders].map(([name, items]) => {
    const episodes = items.filter((i) => i.kind === 'episode');
    const movies = items.filter((i) => i.kind === 'movie' || i.kind === 'video');
    const showKeys = [...new Set(episodes.map((e) => e.showKey))];
    const seasons = [...new Set(episodes.map((e) => e.season))];
    // One show inside -> that show (or that season's) artwork and details; else its first matched movie.
    const show = showKeys.length === 1 && !movies.length ? metadata.showMeta(showKeys[0]) : null;
    const movie = !show && movies.length === 1 && !episodes.length ? metadata.movieMeta(movies[0]) : null;
    const firstPoster = () => {
      for (const m of movies) { const p = metadata.movieMeta(m)?.poster; if (p) return p; }
      for (const k of showKeys) { const p = metadata.showMeta(k)?.poster; if (p) return p; }
      return null;
    };
    const genres = new Set();
    for (const k of showKeys) for (const g of metadata.showMeta(k)?.genres || []) genres.add(g);
    for (const m of movies) for (const g of metadata.movieMeta(m)?.genres || []) genres.add(g);
    return {
      name,
      path: [...want, name].join('/'),
      count: items.length,
      unwatched: items.filter((i) => !prog[mediaKey(i)]?.watched).length,
      addedAt: Math.max(...items.map((i) => i.addedAt || 0)),
      title: show?.title || movie?.title || null,
      year: show?.year ?? movie?.year ?? null,
      rating: show?.rating ?? movie?.rating ?? null,
      genres: [...genres],
      poster: (show && seasons.length === 1 && show.seasons?.[seasons[0]]?.poster) || show?.poster || movie?.poster || firstPoster(),
      thumbId: items[0].id,
    };
  });
  res.json({ library: libraryView(lib, req), path: want.join('/'), folders: folderViews, files });
});

// A library holds whatever the scanner found: movies as a flat list, episodes grouped by show.
app.get('/api/libraries/:id/items', (req, res) => {
  const lib = state.libraries.find((l) => l.id === req.params.id);
  if (!lib) return res.status(404).json({ error: 'Library not found' });
  const prog = progressOf(req);
  const here = Object.values(state.items).filter((i) => i.libraryId === lib.id);
  res.json({
    library: libraryView(lib, req),
    movies: here.filter((i) => i.kind === 'movie').map((i) => summary(i, prog)),
    // Extras whose show or movie isn't in the library.
    videos: [...here.filter((i) => i.kind === 'video'), ...extras.orphans(lib.id)].map((i) => summary(i, prog)),
    shows: showsIn(lib.id).map((s) => showSummary(s, prog)),
  });
});

app.get('/api/libraries/:id/shows/:showKey', (req, res) => {
  const { id: libraryId, showKey } = req.params;
  const eps = showEpisodes(libraryId, showKey);
  if (!eps.length) return res.status(404).json({ error: 'Show not found' });
  const meta = metadata.showMeta(showKey);
  // "On deck": first episode that isn't finished.
  const prog = progressOf(req);
  const onDeck = eps.find((e) => !prog[mediaKey(e)]?.watched) || eps[0];
  const seasons = {};
  for (const n of new Set(eps.map((e) => e.season))) {
    const s = meta?.seasons?.[n];
    seasons[n] = { name: s?.name, overview: s?.overview, poster: s?.poster };
  }
  res.json({
    libraryId,
    showKey,
    title: meta?.title || eps[0].show,
    year: meta?.year ?? eps[0].showYear,
    localTitle: eps[0].show,
    localYear: eps[0].showYear,
    meta: meta && { ...meta, seasons: undefined },
    seasons,
    onDeck: onDeck.id,
    episodes: eps.map((e) => ({ ...summary(e, prog), overview: metadata.episodeMeta(e)?.overview })),
    missing: req.user.admin ? missing.forShow(showKey) : null,
    extras: extras.forShow(libraryId, showKey).map((e) => summary(e, prog)),
  });
});

app.post('/api/libraries/:id/shows/:showKey/match', auth.requireAdmin, async (req, res) => {
  const local = metadata.localShows().get(metadata.showId(req.params.id, req.params.showKey));
  if (!local) return res.status(404).json({ error: 'Show not found' });
  const tmdbId = Number(req.body?.tmdbId) || metadata.showMeta(local.showKey)?.tmdbId;
  const meta = await metadata.matchShow(local, tmdbId);
  db.save();
  if (!meta) return res.status(404).json({ error: 'No match found on TMDB' });
  res.json({ ok: true, title: meta.title });
});

// ---------- home / search ----------

app.get('/api/home', (req, res) => {
  // Continue watching = in-progress items + the next episode of shows you're watching.
  const continueWatching = [];
  const seenShows = new Set();
  const seenItems = new Set();
  const prog = progressOf(req);
  const byKey = new Map();
  for (const i of Object.values(state.items)) if (!byKey.has(mediaKey(i))) byKey.set(mediaKey(i), i);
  const recentProgress = Object.entries(prog).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key, p] of recentProgress) {
    const item = byKey.get(key);
    if (!item || continueWatching.length >= 20) continue;
    const showId = item.kind === 'episode' ? metadata.showId(item.libraryId, item.showKey) : null;
    if (showId && seenShows.has(showId)) continue;
    if (showId) seenShows.add(showId);
    let pick = null;
    if (!p.watched && p.position > 30) pick = item;
    else if (p.watched && showId) {
      const next = nextEpisodeItem(item);
      if (next && !prog[mediaKey(next)]?.watched) pick = next;
    }
    if (pick && !seenItems.has(pick.id)) {
      seenItems.add(pick.id);
      continueWatching.push(summary(pick, prog));
    }
  }

  // Recently watched = this account's latest viewing, finished titles included, one entry per
  // show (its latest episode). Anything already in Continue watching isn't repeated.
  const recentlyWatched = [];
  const cwShows = new Set(continueWatching.filter((i) => i.kind === 'episode').map((i) => i.showKey));
  const cwItems = new Set(continueWatching.map((i) => i.id));
  const rwShows = new Set();
  for (const [key, p] of recentProgress) {
    if (recentlyWatched.length >= 20) break;
    const item = byKey.get(key);
    if (!item || (!p.watched && p.position < 60)) continue; // gone, or barely started
    if (item.kind === 'episode') {
      if (rwShows.has(item.showKey) || cwShows.has(item.showKey)) continue;
      rwShows.add(item.showKey);
    } else if (cwItems.has(item.id)) continue;
    recentlyWatched.push({ ...summary(item, prog), watchedAt: p.updatedAt });
  }

  const recentMovies = Object.values(state.items)
    .filter((i) => i.kind !== 'episode' && i.kind !== 'extra')
    .sort((a, b) => b.addedAt - a.addedAt).slice(0, 24)
    .map((i) => summary(i, prog));
  const recentShows = [...metadata.localShows().values()]
    .map((s) => showSummary(s, prog))
    .sort((a, b) => b.addedAt - a.addedAt).slice(0, 24);

  res.json({ continueWatching, recentlyWatched, recentMovies, recentShows });
});

app.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ items: [], shows: [] });
  const prog = progressOf(req);
  const shows = [...metadata.localShows().values()]
    .map((s) => showSummary(s, prog))
    .filter((s) => s.title.toLowerCase().includes(q));
  const items = Object.values(state.items).map((i) => summary(i, prog))
    .filter((i) => i.title.toLowerCase().includes(q))
    .slice(0, 100);
  res.json({ shows: shows.slice(0, 50), items });
});

// ---------- items ----------

app.get('/api/items/:id', async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const prog = progressOf(req);
  const next = nextEpisodeItem(item);
  let meta = null;
  if (item.kind === 'movie') meta = metadata.movieMeta(item);
  if (item.kind === 'episode') {
    const show = metadata.showMeta(item.showKey);
    const ep = metadata.episodeMeta(item);
    meta = { overview: ep?.overview, airDate: ep?.airDate, rating: ep?.rating, contentRating: show?.contentRating, genres: show?.genres };
  }
  res.json({
    ...summary(item, prog),
    localTitle: item.title,
    localYear: item.year,
    path: req.user.admin ? item.path : undefined,
    size: item.size,
    container: item.container,
    video: item.video,
    audio: item.audio || [],
    probeError: req.user.admin ? item.probeError : undefined,
    meta,
    progress: prog[mediaKey(item)] || null,
    subtitles: await media.listSubtitles(item),
    directPlay: media.canDirectPlay(item),
    canTranscode: !!FFMPEG,
    bitrate: item.bitrate || null,
    qualities: hls.describe(hls.levelsFor(item)), // smaller sizes for slow connections
    next: next ? summary(next, prog) : null,
    copies: duplicates.copiesOf(item),
    extras: item.kind === 'movie' ? extras.forMovie(item).map((e) => summary(e, prog)) : undefined,
    of: ownerView(extras.ownerOf(item)),
  });
});

// The show or movie an extra belongs to, for the link back to it.
function ownerView(o) {
  if (o?.kind === 'show') return { kind: 'show', libraryId: o.libraryId, showKey: o.showKey, title: metadata.showMeta(o.showKey)?.title || o.title };
  if (o?.kind === 'movie') return { kind: 'movie', id: o.item.id, title: metadata.movieMeta(o.item)?.title || o.item.title };
  return null;
}

app.post('/api/items/:id/match', auth.requireAdmin, async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  if (item.kind !== 'movie') return res.status(400).json({ error: 'Only movies can be matched individually' });
  const meta = await metadata.matchMovie(item, Number(req.body?.tmdbId) || metadata.movieMeta(item)?.tmdbId);
  db.save();
  if (!meta) return res.status(404).json({ error: 'No match found on TMDB' });
  res.json({ ok: true, title: meta.title });
});

app.get('/api/items/:id/thumb', async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const file = await media.getThumb(item);
  if (!file) return res.status(404).end();
  res.sendFile(file, { maxAge: '1d' });
});

app.get('/api/items/:id/direct', async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  if (!(await media.verifyCurrent(item))) return res.status(404).json({ error: 'Not a playable video' });
  // sendFile handles Range requests, which is what makes seeking work.
  res.sendFile(item.path, { dotfiles: 'allow', acceptRanges: true });
});

app.get('/api/items/:id/transcode', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  if (!FFMPEG) return res.status(501).json({ error: 'ffmpeg is not installed' });
  media.transcode(item, {
    start: Math.max(0, Number(req.query.t) || 0),
    audio: Math.max(0, parseInt(req.query.audio, 10) || 0),
  }, res);
});

// Adaptive streaming (server/hls.js): the playlist of sizes, each size's playlist, and its pieces.
app.get('/api/items/:id/hls/main.m3u8', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
    .send(hls.masterPlaylist(item, Math.max(0, parseInt(req.query.audio, 10) || 0)));
});

app.get('/api/items/:id/hls/:height/index.m3u8', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  if (!hls.levelsFor(item).some((l) => l.height === Number(req.params.height))) return res.status(404).end();
  res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
    .send(hls.mediaPlaylist(item, Math.max(0, parseInt(req.query.audio, 10) || 0)));
});

app.get('/api/items/:id/hls/:height/:n.ts', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  hls.sendSegment(item, Number(req.params.height), Number(req.params.n), Math.max(0, parseInt(req.query.audio, 10) || 0), res);
});

app.get('/api/items/:id/subtitles/:key', async (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const text = await media.getSubtitle(item, req.params.key);
  if (text == null) return res.status(404).end();
  res.type('text/plain; charset=utf-8').send(text);
});

app.post('/api/items/:id/progress', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const position = Number(req.body?.position) || 0;
  const duration = Number(req.body?.duration) || item.duration || 0;
  const watched = duration > 0 && position / duration > 0.92;
  const prog = progressOf(req);
  const key = mediaKey(item);
  prog[key] = { position: watched ? 0 : position, duration, watched, updatedAt: Date.now() };
  db.save();
  res.json(prog[key]);
});

app.post('/api/items/:id/watched', (req, res) => {
  const item = getItem(req, res);
  if (!item) return;
  const prog = progressOf(req);
  if (req.body?.watched) prog[mediaKey(item)] = { position: 0, duration: item.duration, watched: true, updatedAt: Date.now() };
  else delete prog[mediaKey(item)];
  db.save();
  res.json({ ok: true });
});

// ---------- title catalog ----------
// Every title ever found, kept even when files vanish, to rebuild after a drive failure.

// ---------- plugins ----------
// Optional features from plugins/ (see plugins.js): their API is under /api with the rest, behind
// login. The browser asks which plugins to load.

plugins.load({
  config,
  requireAdmin: auth.requireAdmin,
  progressOf,
  roam: store.roam,
  modules: { config, db, ffmpeg: require('./ffmpeg'), media, playlog, scanner, parse: require('./parse'), keys: require('./keys') },
}, path.join(config.ROOT, 'plugins'));
// Which plugins loaded with this start: auto-deploy checks it after a restart, so a plugin update
// that stops a plugin loading is rolled back (scripts/autodeploy.mjs).
fs.writeFileSync(path.join(config.DATA_DIR, 'plugins-status.json'), `${JSON.stringify(plugins.status())}\n`);

app.get('/api/plugins', (req, res) => res.json(plugins.list()));
app.use('/api', plugins.api);

// ---------- playback problems ----------
// Players report dropouts (and whether reconnecting fixed them); see playlog.js.

const clip = (v, n = 300) => (v == null ? undefined : String(v).slice(0, n));
const PROBLEMS = new Set(['error', 'dropped', 'stalled']);
const OUTCOMES = new Set(['recovered', 'failed', 'left']);

app.post('/api/playback/problems', (req, res) => {
  const b = req.body || {};
  if (!PROBLEMS.has(b.what) || !OUTCOMES.has(b.outcome)) return res.status(400).json({ error: 'Unknown problem' });
  playlog.add({
    source: 'player', what: b.what, outcome: b.outcome, user: req.user.username,
    title: clip(b.title, 200), ref: clip(b.ref, 200), mode: b.mode === 'direct' ? 'direct' : 'transcode',
    position: Math.round(Number(b.position) || 0), attempts: Math.min(99, Number(b.attempts) || 0),
    downFor: Math.round(Number(b.downFor) || 0), message: clip(b.message),
    device: clip(req.headers['user-agent'], 160),
  });
  res.json({ ok: true });
});

app.get('/api/playback/problems', auth.requireAdmin, (req, res) => res.json(playlog.list()));

app.delete('/api/playback/problems', auth.requireAdmin, (req, res) => {
  playlog.clear();
  res.json({ ok: true });
});

app.get('/api/duplicates', auth.requireAdmin, (req, res) => res.json(duplicates.list()));

app.get('/api/missing', auth.requireAdmin, (req, res) => res.json(missing.list()));

app.get('/api/missing/export', auth.requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="deadair-missing-${new Date().toISOString().slice(0, 10)}.txt"`);
  res.type('text/plain; charset=utf-8').send(missing.toText());
});

// Shows you don't mean to collect in full stay off the Missing episodes list.
app.post('/api/missing/ignore', auth.requireAdmin, (req, res) => {
  const showKey = String(req.body?.showKey || '');
  if (!showKey) return res.status(400).json({ error: 'showKey is required' });
  missing.setIgnored(showKey, req.body.ignored !== false);
  res.json({ ok: true });
});

app.get('/api/catalog', auth.requireAdmin, (req, res) => res.json(catalog.summary()));

app.get('/api/catalog/export', auth.requireAdmin, (req, res) => {
  const csv = req.query.format !== 'txt';
  res.setHeader('Content-Disposition', `attachment; filename="deadair-catalog-${new Date().toISOString().slice(0, 10)}.${csv ? 'csv' : 'txt'}"`);
  // The byte-order mark makes Excel/Numbers read the CSV as UTF-8 (accents, non-Latin titles).
  res.type(csv ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8').send(csv ? `\ufeff${catalog.toCsv()}` : catalog.toText());
});

// ---------- improvement notes ----------
// A shared list of ideas, bugs and wishes, jotted down while using Deadair and later fed back
// into development. Everyone signed in can add notes and tick them off; only a note's author
// or an admin can edit or delete it.

const notes = () => (state.notes ||= []);
const MAX_NOTE = 5000;
const noteView = (n, req) => ({
  ...n, mine: n.authorId === req.user.id, canEdit: n.authorId === req.user.id || req.user.admin,
  commitUrl: n.commit && version.repo ? `https://github.com/${version.repo}/commit/${n.commit}` : undefined,
});
const noteText = (body) => String(body?.text ?? '').trim();

app.get('/api/notes', (req, res) => res.json(notes().map((n) => noteView(n, req))));

app.post('/api/notes', (req, res) => {
  const text = noteText(req.body);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  if (text.length > MAX_NOTE) return res.status(400).json({ error: `Keep notes under ${MAX_NOTE} characters` });
  const note = { id: crypto.randomUUID().slice(0, 8), text, author: req.user.username, authorId: req.user.id, createdAt: Date.now(), done: false };
  notes().unshift(note);
  db.save();
  res.status(201).json(noteView(note, req));
});

app.patch('/api/notes/:id', (req, res) => {
  const note = notes().find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  if ('text' in (req.body || {})) {
    if (!(note.authorId === req.user.id || req.user.admin)) return res.status(403).json({ error: 'Only the author or an admin can edit this note' });
    const text = noteText(req.body);
    if (!text) return res.status(400).json({ error: 'A note can’t be empty' });
    if (text.length > MAX_NOTE) return res.status(400).json({ error: `Keep notes under ${MAX_NOTE} characters` });
    note.text = text;
    note.editedAt = Date.now();
  }
  if ('done' in (req.body || {})) {
    note.done = !!req.body.done;
    if (note.done) Object.assign(note, { doneAt: Date.now(), doneBy: req.user.username });
    else { delete note.doneAt; delete note.doneBy; }
  }
  db.save();
  res.json(noteView(note, req));
});

app.delete('/api/notes/:id', (req, res) => {
  const i = notes().findIndex((n) => n.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Note not found' });
  const note = notes()[i];
  if (!(note.authorId === req.user.id || req.user.admin)) return res.status(403).json({ error: 'Only the author or an admin can delete this note' });
  notes().splice(i, 1);
  db.save();
  res.json({ ok: true });
});

// ---------- Chromecast ----------
// The player asks for a link for what it's playing; the Chromecast then fetches /cast/<token>/…
// (through CAST_DOMAIN, which only home-network devices can reach).

// Which video a player base URL means: a library item or a plugin's.
function castTarget(base) {
  let m;
  if ((m = /^\/api\/items\/([\w-]+)$/.exec(base)) && state.items[m[1]] && media.isServable(state.items[m[1]])) return { kind: 'item', id: m[1] };
  return plugins.castTarget(base);
}

app.post('/api/cast/link', (req, res) => {
  const target = castTarget(String(req.body?.base || ''));
  if (!target) return res.status(404).json({ error: 'Nothing castable there' });
  res.json({ url: cast.linkFor({ ...target, userId: req.user.id }), domain: cast.DOMAIN });
});

function castStream(req, res) {
  const t = cast.verify(req.params.token);
  // Expired or forged, or the account was removed since.
  if (!t || (!auth.DISABLED && !state.accounts?.[t.userId])) return res.status(404).end();
  const start = Math.max(0, Number(req.query.t) || 0);
  const audio = Math.max(0, parseInt(req.query.audio, 10) || 0);
  const what = req.params.stream;
  if (what !== 'direct' && what !== 'transcode') return res.status(404).end();
  if (what === 'transcode' && !FFMPEG) return res.status(501).end();

  if (t.kind === 'item') {
    const item = state.items[t.id];
    if (!item || !media.isServable(item)) return res.status(404).end();
    if (what === 'direct') return res.sendFile(item.path, { dotfiles: 'allow', acceptRanges: true });
    return media.transcode(item, { start, audio }, res);
  }
  const kind = plugins.castKind(t.kind);
  if (kind) return kind.stream(t.id, what, { start, audio }, req, res);
  res.status(404).end();
}

// ---------- TMDB ----------

app.get('/api/tmdb/search', auth.requireAdmin, async (req, res) => {
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const results = await metadata.search(type, q, Number(req.query.year) || undefined);
    res.json({
      results: results.slice(0, 20).map((r) => ({
        id: r.id,
        title: r.title || r.name,
        year: metadata.yearOf(r.release_date || r.first_air_date),
        overview: r.overview,
        poster: r.poster_path,
      })),
    });
  } catch (err) {
    res.status(err.status === 401 ? 400 : 502).json({ error: err.status === 401 ? 'TMDB API key missing or invalid' : err.message });
  }
});

app.post('/api/metadata/refresh', auth.requireAdmin, (req, res) => {
  if (!metadata.apiKey()) return res.status(400).json({ error: 'Add a TMDB API key first' });
  metadata.refresh({ force: !!req.body?.force });
  res.json(metadata.status);
});

// TMDB images, cached on disk after first request.
app.get('/api/img/:size/:file', async (req, res) => {
  const file = await metadata.getImage(req.params.size, req.params.file);
  if (!file) return res.status(404).end();
  res.sendFile(file, { maxAge: '30d', immutable: true });
});

// ---------- Live TV ----------

app.get('/api/live/guide', (req, res) => {
  const from = Number(req.query.from) || Date.now() - 30 * 60 * 1000;
  const to = Math.min(Number(req.query.to) || from + 12 * 3600e3, from + 3 * 24 * 3600e3);
  res.json(live.guide(from, to));
});

// What's on a channel now and next, and how to play it. Library channels play through the normal
// item endpoints, from the scheduled offset.
app.get('/api/live/channels/:id', (req, res) => {
  const entry = live.find(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Channel not found' });
  const tuned = live.tune(entry);
  if (tuned.play?.itemId) {
    const item = state.items[tuned.play.itemId];
    Object.assign(tuned.play, { directPlay: media.canDirectPlay(item), canTranscode: !!FFMPEG });
  }
  res.json({ ...tuned, lineup: live.lineup().map(({ id, number, name }) => ({ id, number, name })) });
});

app.get('/api/live/channels/:id/stream', (req, res) => {
  const entry = live.find(req.params.id);
  if (!entry || entry.kind !== 'external') return res.status(404).json({ error: 'Channel not found' });
  if (!FFMPEG) return res.status(501).json({ error: 'ffmpeg is not installed' });
  live.streamBrowser(entry, res);
});

// Each account's secret link for IPTV apps. The token is shown once, when it's made.
const iptvLinks = (req, token) => {
  const base = `${req.protocol}://${req.get('host')}/iptv/${token}`;
  return { playlist: `${base}/playlist.m3u`, guide: `${base}/epg.xml` };
};
app.get('/api/live/iptv', (req, res) => res.json({ createdAt: auth.iptvCreatedAt(req.user) }));
app.post('/api/live/iptv', (req, res) => {
  const token = auth.createIptvToken(req.user);
  res.json({ createdAt: auth.iptvCreatedAt(req.user), ...iptvLinks(req, token) });
});
app.delete('/api/live/iptv', (req, res) => {
  auth.revokeIptvToken(req.user);
  res.json({ createdAt: null });
});

// Setting up channels (admins).
app.get('/api/live/setup', auth.requireAdmin, (req, res) => {
  res.json({ channels: channels.list().map(channels.overview), sources: sources.list().map(sources.status), ffmpeg: !!FFMPEG });
});
app.get('/api/live/catalog', auth.requireAdmin, (req, res) => res.json(channels.catalog()));

const badRequest = (res, fn) => {
  try {
    return fn();
  } catch (err) {
    res.status(400).json({ error: err.message });
    return null;
  }
};

app.post('/api/live/library-channels', auth.requireAdmin, (req, res) => {
  const ch = badRequest(res, () => channels.create(req.body));
  if (ch) res.status(201).json(ch);
});
app.put('/api/live/library-channels/:id', auth.requireAdmin, (req, res) => {
  if (!channels.find(req.params.id)) return res.status(404).json({ error: 'Channel not found' });
  const ch = badRequest(res, () => channels.update(req.params.id, req.body));
  if (ch) res.json(ch);
});
app.delete('/api/live/library-channels/:id', auth.requireAdmin, (req, res) => {
  if (!channels.remove(req.params.id)) return res.status(404).json({ error: 'Channel not found' });
  res.json({ ok: true });
});

app.post('/api/live/sources', auth.requireAdmin, async (req, res) => {
  try {
    res.status(201).json(sources.status(await sources.create(req.body)));
  } catch (err) {
    res.status(400).json({ error: `Couldn’t add it: ${err.message}` });
  }
});
app.put('/api/live/sources/:id', auth.requireAdmin, (req, res) => {
  if (!sources.find(req.params.id)) return res.status(404).json({ error: 'Source not found' });
  const src = badRequest(res, () => sources.update(req.params.id, req.body));
  if (src) res.json(sources.status(src));
});
app.delete('/api/live/sources/:id', auth.requireAdmin, (req, res) => {
  if (!sources.remove(req.params.id)) return res.status(404).json({ error: 'Source not found' });
  res.json({ ok: true });
});
app.post('/api/live/sources/:id/refresh', auth.requireAdmin, (req, res) => {
  const src = sources.find(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  sources.refresh(src);
  res.json(sources.status(src));
});
app.get('/api/live/sources/:id/channels', auth.requireAdmin, (req, res) => {
  const src = sources.find(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  res.json({ source: sources.status(src), channels: sources.channelsOf(src) });
});

// IPTV apps: /iptv/<token>/playlist.m3u, epg.xml, and the streams and artwork they point to.
const iptv = express.Router({ mergeParams: true });
app.use('/iptv/:token', auth.requireIptv, iptv);
const iptvBase = (req) => `${req.protocol}://${req.get('host')}/iptv/${encodeURIComponent(req.params.token)}`;

iptv.get('/playlist.m3u', (req, res) => res.type('audio/x-mpegurl').send(live.m3u(iptvBase(req))));
iptv.get('/epg.xml', (req, res) => res.type('application/xml').send(live.xmltv(iptvBase(req))));
iptv.get('/stream/:id.ts', (req, res) => {
  const entry = live.find(req.params.id);
  if (!entry) return res.status(404).end();
  if (!FFMPEG) return res.status(501).end();
  // Apps sometimes check a link with HEAD first; don't start a stream for that.
  if (req.method === 'HEAD') return res.type('video/mp2t').end();
  if (entry.kind === 'library') live.streamLibraryTs(entry, res);
  else live.streamExternalTs(entry, res);
});
iptv.get('/img/:size/:file', async (req, res) => {
  const file = await metadata.getImage(req.params.size, req.params.file);
  if (!file) return res.status(404).end();
  res.sendFile(file, { maxAge: '30d', immutable: true });
});
iptv.get('/thumb/:id', async (req, res) => {
  const item = state.items[req.params.id];
  const file = item && media.isServable(item) && await media.getThumb(item);
  if (!file) return res.status(404).end();
  res.sendFile(file, { maxAge: '1d' });
});

// ---------- folder browser (for adding libraries) ----------

app.get('/api/fs', auth.requireAdmin, async (req, res) => {
  const p = req.query.path ? path.resolve(String(req.query.path)) : null;
  if (!p) {
    let roots;
    if (process.platform === 'win32') {
      roots = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => fs.existsSync(d));
    } else {
      roots = [os.homedir(), process.platform === 'darwin' ? '/Volumes' : '/mnt', '/'].filter((d) => fs.existsSync(d));
    }
    return res.json({ path: null, parent: null, dirs: roots.map((r) => ({ name: r, path: r })) });
  }
  let entries;
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Cannot open ${p}: ${err.code || err.message}` });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !/^[.$]/.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(p);
  res.json({ path: p, parent: parent === p ? '' : parent, dirs });
});

// ---------- errors / startup ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // A restart while people are watching is the usual cause of a dropout; note it.
    if (playlog.active()) playlog.add({ source: 'server', what: 'stop', message: `${sig} with ${playlog.active()} stream${playlog.active() === 1 ? '' : 's'} playing` });
    db.flush();
    process.exit(0);
  });
}

app.listen(config.PORT, config.HOST, () => {
  playlog.add({ source: 'server', what: 'start', message: `pid ${process.pid}` });
  console.log(`Deadair running:`);
  console.log(`  http://localhost:${config.PORT}  (this machine)`);
  if (['127.0.0.1', 'localhost', '::1'].includes(config.HOST)) {
    console.log(`  other devices: https://${process.env.DEADAIR_DOMAIN || 'deadair.example.com'} over Tailscale (\`npm run up\` starts this with HTTPS)`);
  } else {
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
    for (const ip of addrs) console.log(`  http://${ip}:${config.PORT}`);
  }
  console.log(`ffmpeg: ${FFMPEG || 'NOT FOUND (only browser-compatible files will play)'}`);
  console.log(`login: ${auth.DISABLED ? 'DISABLED (AUTH_DISABLED=1)' : auth.loginConfigured() ? 'users-db accounts via auth-gateway' : 'NOT CONFIGURED - set AUTH_GATEWAY_URL and AUTH_GATEWAY_SECRET in .env'}`);
  if (!auth.DISABLED) {
    const { admins, viewers } = auth.access();
    console.log(`  admins: ${admins.join(', ') || 'NONE - add your username to ADMIN_USERS in .env'}`);
    console.log(`  viewers: ${viewers.join(', ') || '(none)'}`);
  }
  console.log(`D1 sync: ${store.status.enabled ? 'on (deadair-api)' : 'off - set DEADAIR_API_URL and DEADAIR_API_SECRET in .env to keep data in D1'}`);
  console.log(`data dir: ${config.DATA_DIR}`);

  // Load libraries & history from D1 first, so a fresh machine knows what to scan.
  store.start().finally(() => {
    console.log(`TMDB: ${metadata.apiKey() ? 'configured' : 'no API key (add one in Settings for posters & metadata)'}`);
    if (state.libraries.length) scanner.scan();
    sources.start();
    plugins.start();
  });
  if (config.SCAN_INTERVAL_MIN > 0) {
    setInterval(() => scanner.scan(), config.SCAN_INTERVAL_MIN * 60 * 1000).unref();
  }
});
