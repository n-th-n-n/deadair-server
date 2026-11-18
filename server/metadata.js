// TMDB (themoviedb.org) metadata: matching, fetching and local image caching.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const db = require('./db');
const { limiter } = require('./ffmpeg');
const { IMAGE_DIR } = require('./config');
const { movieKey, showMatchKey } = require('./keys');

const API = process.env.TMDB_API_URL || 'https://api.themoviedb.org/3';
const IMG = process.env.TMDB_IMAGE_URL || 'https://image.tmdb.org/t/p';
const LANG = process.env.TMDB_LANGUAGE || 'en-US';
const REGION = process.env.TMDB_REGION || 'US';

const DAY = 24 * 60 * 60 * 1000;
const status = { running: false, done: 0, total: 0, error: null, lastRun: null };
const { state } = db;

const settings = () => (state.settings ||= {});
// TMDB matches, keyed by movieKey / showMatchKey: { meta } when matched, { miss } when TMDB had nothing.
const matches = () => (state.matches ||= {});
const apiKey = () => process.env.TMDB_API_KEY || settings().tmdbKey || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yearOf = (d) => Number(String(d || '').slice(0, 4)) || null;
const showId = (libraryId, showKey) => `${libraryId}/${showKey}`;

// ---------- API ----------

async function tmdb(pathname, params = {}, key = apiKey()) {
  if (!key) throw Object.assign(new Error('TMDB API key is not set'), { status: 401 });
  const url = new URL(API + pathname);
  url.searchParams.set('language', LANG);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  // v4 "API Read Access Token" is a JWT; the short v3 "API Key" goes in the query string.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && attempt < 5) {
      await sleep((Number(res.headers.get('retry-after')) || 1) * 1000);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`TMDB ${res.status} for ${pathname}`), { status: res.status });
    return res.json();
  }
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

// TMDB's own relevance order is decent; nudge it with exact-title and year agreement.
function pickBest(results, title, year, dateField, titleFields) {
  let best = null;
  let bestScore = -Infinity;
  results.slice(0, 10).forEach((r, i) => {
    const y = yearOf(r[dateField]);
    let score = -i * 0.2;
    if (titleFields.some((f) => norm(r[f]) === norm(title))) score += 3;
    if (year && y) score += y === year ? 3 : Math.abs(y - year) === 1 ? 1.5 : -2;
    if (score > bestScore) { best = r; bestScore = score; }
  });
  return best;
}

// Plex/Jellyfin-style id hints in folder or file names: "Movie (2010) {tmdb-27205}" or "[tmdbid-27205]".
const idHint = (p) => Number(p.match(/[{[]tmdb(?:id)?-(\d+)[}\]]/i)?.[1]) || null;

const castOf = (credits) => (credits?.cast || []).slice(0, 15).map((c) => ({
  name: c.name, character: c.character || c.roles?.[0]?.character, profile: c.profile_path,
}));

async function fetchMovie(id) {
  const d = await tmdb(`/movie/${id}`, { append_to_response: 'credits,release_dates' });
  const rel = d.release_dates?.results?.find((r) => r.iso_3166_1 === REGION);
  return {
    tmdbId: d.id,
    imdbId: d.imdb_id,
    title: d.title,
    originalTitle: d.original_title !== d.title ? d.original_title : undefined,
    year: yearOf(d.release_date),
    releaseDate: d.release_date,
    overview: d.overview,
    tagline: d.tagline,
    genres: (d.genres || []).map((g) => g.name),
    runtime: d.runtime,
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    contentRating: rel?.release_dates?.find((x) => x.certification)?.certification,
    poster: d.poster_path,
    backdrop: d.backdrop_path,
    cast: castOf(d.credits),
    directors: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name),
    fetchedAt: Date.now(),
  };
}

async function fetchShow(id, seasonNumbers) {
  const seasons = [...new Set(seasonNumbers)].sort((a, b) => a - b);
  // append_to_response allows 20 sub-requests; the first call also carries credits + ratings.
  const chunks = [seasons.slice(0, 18)];
  for (let i = 18; i < seasons.length; i += 20) chunks.push(seasons.slice(i, i + 20));

  let d;
  const seasonData = {};
  for (const [ci, chunk] of chunks.entries()) {
    const extra = chunk.map((n) => `season/${n}`);
    const r = await tmdb(`/tv/${id}`, { append_to_response: (ci === 0 ? ['credits', 'content_ratings', ...extra] : extra).join(',') });
    if (ci === 0) d = r;
    for (const n of chunk) {
      const s = r[`season/${n}`];
      if (!s) continue;
      seasonData[n] = {
        name: s.name,
        overview: s.overview,
        poster: s.poster_path,
        episodes: Object.fromEntries((s.episodes || []).map((e) => [e.episode_number, {
          name: e.name,
          overview: e.overview,
          still: e.still_path,
          airDate: e.air_date,
          runtime: e.runtime,
          rating: e.vote_average ? Math.round(e.vote_average * 10) / 10 : null,
        }])),
      };
    }
  }

  return {
    tmdbId: d.id,
    title: d.name,
    year: yearOf(d.first_air_date),
    overview: d.overview,
    tagline: d.tagline,
    genres: (d.genres || []).map((g) => g.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    contentRating: d.content_ratings?.results?.find((r) => r.iso_3166_1 === REGION)?.rating,
    status: d.status,
    network: d.networks?.[0]?.name,
    poster: d.poster_path,
    backdrop: d.backdrop_path,
    cast: castOf(d.credits),
    creators: (d.created_by || []).map((c) => c.name),
    seasonCount: d.number_of_seasons,
    seasons: seasonData,
    // Every season TMDB knows of (including ones you don't have), for Missing episodes.
    seasonList: (d.seasons || []).map((s) => ({ number: s.season_number, name: s.name, episodes: s.episode_count, airDate: s.air_date })),
    lastAired: d.last_episode_to_air && { season: d.last_episode_to_air.season_number, episode: d.last_episode_to_air.episode_number, airDate: d.last_episode_to_air.air_date },
    nextAir: d.next_episode_to_air && { season: d.next_episode_to_air.season_number, episode: d.next_episode_to_air.episode_number, airDate: d.next_episode_to_air.air_date },
    fetchedAt: Date.now(),
  };
}

async function search(type, query, year) {
  const isTv = type === 'tv';
  const r = await tmdb(isTv ? '/search/tv' : '/search/movie', {
    query, include_adult: false, ...(year ? { [isTv ? 'first_air_date_year' : 'year']: year } : {}),
  });
  return r.results || [];
}

async function autoMatchMovie(item) {
  const hinted = idHint(item.path);
  if (hinted) return fetchMovie(hinted);
  let results = await search('movie', item.title, item.year);
  if (!results.length && item.year) results = await search('movie', item.title);
  const best = pickBest(results, item.title, item.year, 'release_date', ['title', 'original_title']);
  return best ? fetchMovie(best.id) : null;
}

// ---------- local views ----------

function localShows() {
  const map = new Map();
  for (const item of Object.values(state.items)) {
    if (item.kind !== 'episode') continue;
    const id = showId(item.libraryId, item.showKey);
    let s = map.get(id);
    if (!s) map.set(id, (s = { id, libraryId: item.libraryId, showKey: item.showKey, title: item.show, year: item.showYear, path: item.path, episodes: [] }));
    s.episodes.push(item);
  }
  return map;
}

const showMeta = (showKey) => matches()[showMatchKey(showKey)]?.meta || null;
const movieMeta = (item) => (item.kind === 'movie' ? matches()[movieKey(item)]?.meta || null : null);

function episodeMeta(item) {
  return showMeta(item.showKey)?.seasons?.[item.season]?.episodes?.[item.episode] || null;
}

// ---------- matching jobs ----------

async function matchShow(local, tmdbId) {
  const hinted = tmdbId || idHint(local.path.split(/[\\/]/).slice(0, -1).join('/'));
  let id = hinted;
  if (!id) {
    let results = await search('tv', local.title, local.year);
    if (!results.length && local.year) results = await search('tv', local.title);
    id = pickBest(results, local.title, local.year, 'first_air_date', ['name', 'original_name'])?.id;
  }
  const rec = (matches()[showMatchKey(local.showKey)] ||= {});
  if (!id) {
    rec.miss = Date.now();
    return null;
  }
  rec.meta = await fetchShow(id, local.episodes.map((e) => e.season));
  delete rec.miss;
  if (placeNumbered()) rec.meta = await fetchShow(id, local.episodes.map((e) => e.season)); // details for the seasons they moved to
  return rec.meta;
}

async function matchMovie(item, tmdbId) {
  const meta = tmdbId ? await fetchMovie(tmdbId) : await autoMatchMovie(item);
  matches()[movieKey(item)] = meta ? { meta } : { miss: Date.now() };
  return meta;
}

// Shows numbered straight through ("Season 05; The Assault/Bleach 100.mkv") go where TMDB has
// them: episode 100 of a show TMDB splits into seasons of 20, 21, 22, 28… episodes is season 5
// episode 9, and of one TMDB lists as a single 366-episode season it's season 1 episode 100.
// Only when the files clearly count straight through: no number repeats, and a later season
// folder carries on from the one before (Season 2 starts at 21) rather than starting again at 1.
// Returns whether anything moved.
function placeNumbered() {
  const shows = new Map();
  for (const item of Object.values(state.items)) {
    if (item.kind !== 'episode' || !item.numbered) continue;
    const id = showId(item.libraryId, item.showKey);
    if (!shows.has(id)) shows.set(id, []);
    shows.get(id).push(item);
  }
  let moved = false;
  for (const eps of shows.values()) {
    const seasons = (showMeta(eps[0].showKey)?.seasonList || []).filter((s) => s.number > 0 && s.episodes > 0).sort((a, b) => a.number - b.number);
    if (!seasons.length) continue;
    const nums = eps.map((e) => e.numbered.episode);
    if (new Set(nums).size !== nums.length) continue;
    const first = new Map();
    for (const { numbered: n } of eps) first.set(n.season, Math.min(first.get(n.season) ?? Infinity, n.episode));
    if (![...first].some(([season, ep]) => season > 1 && ep > 1)) continue;
    for (const item of eps) {
      const { episode: from, end } = item.numbered;
      let n = from;
      let i = 0;
      while (i < seasons.length && n > seasons[i].episodes) n -= seasons[i++].episodes;
      if (i === seasons.length) continue; // past what TMDB lists
      const place = { season: seasons[i].number, episode: n, episodeEnd: end ? n + (end - from) : null }; // "Bleach 176-177"
      if (Object.entries(place).every(([k, v]) => item[k] === v)) continue;
      Object.assign(item, place);
      moved = true;
    }
  }
  return moved;
}

let rerun = null;

// Matches anything unmatched; `force` refetches everything (keeping existing matches).
async function refresh({ force = false } = {}) {
  if (!apiKey()) return;
  if (status.running) {
    rerun = { force: force || rerun?.force };
    return;
  }
  status.running = true;
  status.done = 0;
  status.total = 0;
  status.error = null;
  const now = Date.now();
  const tasks = [];

  // One lookup per movie, even when there are several copies of it.
  const movies = new Map();
  for (const item of Object.values(state.items)) {
    if (item.kind === 'movie' && !movies.has(movieKey(item))) movies.set(movieKey(item), item);
  }
  for (const [key, item] of movies) {
    const rec = matches()[key];
    const due = force || (!rec?.meta && !(rec?.miss > now - 3 * DAY));
    if (due) tasks.push(() => matchMovie(item, rec?.meta?.tmdbId));
  }

  // One lookup per show, even if it appears in several libraries.
  const seenShows = new Set();
  for (const local of localShows().values()) {
    if (seenShows.has(local.showKey)) continue;
    seenShows.add(local.showKey);
    const rec = matches()[showMatchKey(local.showKey)];
    const meta = rec?.meta;
    // New episodes/seasons we have no info for -> refetch (at most daily).
    const missingEps = meta && local.episodes.some((e) => e.episode != null && !meta.seasons?.[e.season]?.episodes?.[e.episode]);
    // Shows still airing get new episodes: refetch weekly so Missing episodes stays current.
    const airing = meta && !['Ended', 'Canceled'].includes(meta.status);
    const due = force
      || (!meta && !(rec?.miss > now - 3 * DAY))
      || (meta && !meta.seasonList) // fetched before the full season list was kept
      || (missingEps && now - meta.fetchedAt > DAY)
      || (airing && now - meta.fetchedAt > 7 * DAY);
    if (due) tasks.push(() => matchShow(local, meta?.tmdbId));
  }

  status.total = tasks.length;
  const limit = limiter(4);
  let authFailed = false;
  try {
    await Promise.all(tasks.map((task) => limit(async () => {
      if (authFailed) return;
      try {
        await task();
      } catch (err) {
        if (err.status === 401) {
          authFailed = true;
          status.error = 'TMDB rejected the API key';
        } else {
          console.warn('[metadata]', err.message);
        }
      }
      status.done++;
      if (status.done % 25 === 0) db.save();
    })));
  } finally {
    status.running = false;
    status.lastRun = Date.now();
    db.save();
  }
  // Titles may have just been matched; refresh the catalog's names (loaded lazily: catalog uses metadata).
  require('./catalog').update();
  if (rerun) {
    const next = rerun;
    rerun = null;
    refresh(next);
  }
}

// ---------- images ----------

const SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280', 'original']);
const imageInflight = new Map();

async function getImage(size, file) {
  if (!SIZES.has(size) || !/^[A-Za-z0-9_-]+\.(jpe?g|png|webp|svg)$/.test(file)) return null;
  const out = path.join(IMAGE_DIR, size, file);
  if (fs.existsSync(out)) return out;
  if (imageInflight.has(out)) return imageInflight.get(out);
  const job = (async () => {
    const res = await fetch(`${IMG}/${size}/${file}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.tmp`;
    await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await fsp.rename(tmp, out);
    return out;
  })().catch(() => null).finally(() => imageInflight.delete(out));
  imageInflight.set(out, job);
  return job;
}

async function setApiKey(key) {
  key = String(key || '').trim();
  if (key) await tmdb('/configuration', {}, key); // throws on a bad key
  if (key) settings().tmdbKey = key;
  else delete settings().tmdbKey;
  db.save();
  if (key) refresh();
}

module.exports = {
  status, apiKey, setApiKey, refresh, search, matchMovie, matchShow, localShows, placeNumbered,
  showMeta, movieMeta, episodeMeta, showId, getImage, yearOf,
};
