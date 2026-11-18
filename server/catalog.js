// A permanent list of every title Deadair has ever found (movies, and shows with the seasons
// and episodes you have), so a failed drive can be rebuilt by re-ripping the discs.
//
// Unlike the file index it's never trimmed: when files disappear the title stays listed and is
// marked missing (with the date). It's kept in data/db.json and synced to D1 like everything else,
// and Settings can export it as a spreadsheet or a printable list.
const db = require('./db');
const metadata = require('./metadata');
const { movieKey, showMatchKey } = require('./keys');
const { parseMedia } = require('./parse');
const { resolution } = require('./quality');

const catalog = () => (db.state.catalog ||= {});

const RANK = { SD: 1, '720p': 2, '1080p': 3, '2160p': 4 };
const quality = (item) => {
  const r = resolution(item.video);
  return r === '4K' ? '2160p' : r;
};
const better = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b) || null;

// What's on disk right now, one entry per title.
function fromFiles() {
  const found = new Map();
  for (const item of Object.values(db.state.items)) {
    // Loose videos aren't titles to track; extras come with their show or movie.
    if (item.kind === 'video' || item.kind === 'extra') continue;
    if (item.kind === 'episode') {
      const key = showMatchKey(item.showKey);
      const meta = metadata.showMeta(item.showKey);
      if (!found.has(key)) {
        found.set(key, { kind: 'show', title: meta?.title || item.show, year: meta?.year ?? item.showYear ?? null, tmdbId: meta?.tmdbId ?? null, seasons: {}, extras: 0, quality: null });
      }
      const e = found.get(key);
      if (item.episode == null) e.extras++;
      else (e.seasons[item.season] ||= []).push(item.episode);
      e.quality = better(e.quality, quality(item));
    } else {
      const key = movieKey(item);
      const meta = metadata.movieMeta(item);
      if (!found.has(key)) found.set(key, { kind: 'movie', title: meta?.title || item.title, year: meta?.year ?? item.year ?? null, tmdbId: meta?.tmdbId ?? null, quality: null });
      found.get(key).quality = better(found.get(key).quality, quality(item));
    }
  }
  return found;
}

// Record what's on disk now. Episodes and quality are merged with what was seen before (it's a
// list of what you own, not of what's mounted today); titles no longer on disk get missingSince.
function update() {
  const now = Date.now();
  const cat = catalog();
  let changed = false;
  const found = fromFiles();

  for (const [key, entry] of found) {
    const old = cat[key];
    if (entry.kind === 'show') {
      const seasons = {};
      for (const src of [old?.seasons || {}, entry.seasons]) {
        for (const [s, eps] of Object.entries(src)) seasons[s] = [...new Set([...(seasons[s] || []), ...eps])].sort((a, b) => a - b);
      }
      entry.seasons = seasons;
      entry.extras = Math.max(entry.extras, old?.extras || 0);
    }
    const next = { ...entry, quality: better(entry.quality, old?.quality), firstSeen: old?.firstSeen ?? now };
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      cat[key] = next;
      changed = true;
    }
  }
  // Titles that were really extras ("Deleted Scenes" as a show, every DVD featurette as a movie)
  // aren't missing, they were never titles: drop them.
  const wasExtra = new Set();
  for (const item of Object.values(db.state.items)) {
    const lib = item.kind === 'extra' && db.state.libraries.find((l) => l.id === item.libraryId);
    if (!lib) continue;
    const before = parseMedia(item.path, lib, { extras: false });
    wasExtra.add(before.kind === 'episode' ? showMatchKey(before.showKey) : movieKey(before));
  }
  for (const [key, old] of Object.entries(cat)) {
    if (!found.has(key) && wasExtra.has(key)) {
      delete cat[key];
      changed = true;
    } else if (!found.has(key) && !old.missingSince) {
      cat[key] = { ...old, missingSince: now };
      changed = true;
    }
  }
  if (changed) db.save();
}

// "1-7, 9, 11-13"
function ranges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    i = j;
  }
  return out.join(', ');
}

const seasonNums = (e) => Object.keys(e.seasons || {}).map(Number).sort((a, b) => (a === 0) - (b === 0) || a - b);
const seasonLabel = (n) => (n === 0 ? 'Specials' : `S${n}`);
const episodeCount = (e) => Object.values(e.seasons || {}).reduce((n, eps) => n + eps.length, 0);
const day = (ms) => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tmdbUrl = (e) => (e.tmdbId ? `https://www.themoviedb.org/${e.kind === 'show' ? 'tv' : 'movie'}/${e.tmdbId}` : '');
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.year || 0) - (b.year || 0);

function entries() {
  return Object.values(catalog()).sort(byTitle);
}

function summary() {
  const all = entries();
  const missing = all.filter((e) => e.missingSince);
  return {
    movies: all.filter((e) => e.kind === 'movie').length,
    shows: all.filter((e) => e.kind === 'show').length,
    missing: missing.map((e) => ({ kind: e.kind, title: e.title, year: e.year, missingSince: e.missingSince })),
  };
}

function toCsv() {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Type', 'Title', 'Year', 'Seasons', 'Episodes', 'Episode list', 'Extras', 'Best quality', 'Status', 'First added', 'TMDB']];
  for (const e of entries()) {
    const show = e.kind === 'show';
    rows.push([
      show ? 'TV show' : 'Movie',
      e.title,
      e.year ?? '',
      show ? seasonNums(e).filter((n) => n > 0).length : '',
      show ? episodeCount(e) : '',
      show ? seasonNums(e).map((n) => `${seasonLabel(n)}: ${ranges(e.seasons[n])}`).join('; ') : '',
      show ? e.extras || '' : '',
      e.quality || '',
      e.missingSince ? `Missing since ${day(e.missingSince)}` : 'On disk',
      e.firstSeen ? day(e.firstSeen) : '',
      tmdbUrl(e),
    ]);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

function toText() {
  const all = entries();
  const movies = all.filter((e) => e.kind === 'movie');
  const shows = all.filter((e) => e.kind === 'show');
  const flag = (e) => (e.missingSince ? `   [MISSING since ${day(e.missingSince)}]` : '');
  const lines = [
    `Deadair catalog, ${day(Date.now())}`,
    `${plural(movies.length, 'movie')}, ${plural(shows.length, 'TV show')}${all.some((e) => e.missingSince) ? `, ${all.filter((e) => e.missingSince).length} missing from disk` : ''}`,
    '',
    `MOVIES (${movies.length})`,
    ...movies.map((e) => `  ${e.title}${e.year ? ` (${e.year})` : ''}${e.quality ? ` · ${e.quality}` : ''}${flag(e)}`),
    '',
    `TV SHOWS (${shows.length})`,
  ];
  for (const e of shows) {
    const regular = seasonNums(e).filter((n) => n > 0);
    lines.push(`  ${e.title}${e.year ? ` (${e.year})` : ''} · ${regular.length ? `${regular.length === 1 ? 'Season' : 'Seasons'} ${ranges(regular)}` : 'No numbered seasons'} · ${plural(episodeCount(e), 'episode')}${e.extras ? ` + ${plural(e.extras, 'extra')}` : ''}${e.quality ? ` · ${e.quality}` : ''}${flag(e)}`);
    lines.push(`      ${seasonNums(e).map((n) => `${seasonLabel(n)}: ${ranges(e.seasons[n])}`).join(' · ')}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { update, summary, toCsv, toText };
