// Episodes you don't have yet: every aired episode TMDB lists for a show, minus the files on disk
// in any library. Specials (season 0) are left out, since most collections skip them, and so are
// shows you've chosen to ignore (ones you never meant to collect in full).
const db = require('./db');
const metadata = require('./metadata');

const ignored = () => ((db.state.settings ||= {}).missingIgnored ||= []);

function setIgnored(showKey, on) {
  const list = ignored().filter((k) => k !== showKey);
  if (on) list.push(showKey);
  db.state.settings.missingIgnored = list;
  db.save();
}

// Every show on disk, merged across libraries: showKey -> { libraryId, title, have: season -> Set(episode) }.
function owned() {
  const shows = new Map();
  for (const local of metadata.localShows().values()) {
    let s = shows.get(local.showKey);
    if (!s) shows.set(local.showKey, (s = { showKey: local.showKey, libraryId: local.libraryId, title: local.title, year: local.year, have: new Map() }));
    for (const e of local.episodes) {
      if (e.episode == null) continue;
      if (!s.have.has(e.season)) s.have.set(e.season, new Set());
      // A double episode ("S01E01-E02") covers both.
      for (let n = e.episode; n <= (e.episodeEnd ?? e.episode); n++) s.have.get(e.season).add(n);
    }
  }
  return shows;
}

// Has season n, episode e aired? The episode's air date when TMDB has it, else TMDB's "last aired"
// marker, else whether the season has started.
function airedCheck(meta) {
  const today = new Date().toISOString().slice(0, 10);
  const last = meta.lastAired;
  return (n, e, airDate, seasonAirDate) => {
    if (airDate) return airDate <= today;
    if (last) return n < last.season || (n === last.season && e <= last.episode);
    return !!seasonAirDate && seasonAirDate <= today;
  };
}

// What's missing from one show, or null when TMDB can't tell us (unmatched, or not fetched yet).
function check(show, meta) {
  if (!meta?.seasonList) return null;
  const aired = airedCheck(meta);
  const seasons = [];
  let total = 0;
  let have = 0;
  let unknown = 0;
  for (const s of meta.seasonList) {
    if (s.number === 0) continue;
    const mine = show.have.get(s.number) || new Set();
    const detail = meta.seasons?.[s.number]?.episodes;
    // Episode names and air dates for seasons you have; just the count for ones you don't.
    const eps = detail
      ? Object.entries(detail).map(([n, e]) => ({ episode: Number(n), name: e.name, airDate: e.airDate }))
      : Array.from({ length: s.episodes || 0 }, (_, i) => ({ episode: i + 1, airDate: null }));
    const airedEps = eps.filter((e) => aired(s.number, e.episode, e.airDate, s.airDate));
    if (!airedEps.length) continue;
    const missing = airedEps.filter((e) => !mine.has(e.episode));
    total += airedEps.length;
    have += airedEps.length - missing.length;
    if (detail) unknown += [...mine].filter((n) => !detail[n]).length;
    if (missing.length) {
      seasons.push({
        season: s.number,
        name: s.name,
        aired: airedEps.length,
        whole: missing.length === airedEps.length,
        missing: missing.map((e) => ({ episode: e.episode, name: e.name || null, airDate: e.airDate || null })),
      });
    }
  }
  // Files in seasons TMDB doesn't list at all (e.g. anime numbered straight through as season 1).
  for (const [n, eps] of show.have) if (n > 0 && !meta.seasonList.some((s) => s.number === n)) unknown += eps.size;
  return { total, have, unknown, seasons };
}

function list() {
  const skip = new Set(ignored());
  const shows = [];
  const unchecked = [];
  const ignoredShows = [];
  let complete = 0;
  for (const show of owned().values()) {
    const meta = metadata.showMeta(show.showKey);
    const base = { showKey: show.showKey, libraryId: show.libraryId, title: meta?.title || show.title, year: meta?.year ?? show.year ?? null, poster: meta?.poster || null };
    if (skip.has(show.showKey)) {
      ignoredShows.push(base);
      continue;
    }
    const r = check(show, meta);
    if (!r) {
      unchecked.push({ ...base, reason: meta ? 'Not checked yet' : 'Not matched on TMDB' });
      continue;
    }
    if (!r.seasons.length) {
      complete++;
      continue;
    }
    const gaps = r.seasons.filter((s) => !s.whole);
    shows.push({
      ...base,
      tmdbId: meta.tmdbId,
      status: meta.status || null,
      nextAir: meta.nextAir || null,
      ...r,
      missingCount: r.total - r.have,
      // Holes inside seasons you have some of, vs. seasons you have none of.
      gapCount: gaps.reduce((n, s) => n + s.missing.length, 0),
      wholeSeasons: r.seasons.filter((s) => s.whole).length,
    });
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || (a.year || 0) - (b.year || 0);
  shows.sort(byTitle);
  return {
    shows,
    unchecked: unchecked.sort(byTitle),
    ignored: ignoredShows.sort(byTitle),
    totals: {
      shows: shows.length,
      complete,
      episodes: shows.reduce((n, s) => n + s.missingCount, 0),
      gapShows: shows.filter((s) => s.gapCount).length,
      wholeShows: shows.filter((s) => s.wholeSeasons).length,
    },
  };
}

// What's missing from one show, for its page (null if ignored or unknown).
function forShow(showKey) {
  if (ignored().includes(showKey)) return null;
  const show = owned().get(showKey);
  return show ? check(show, metadata.showMeta(showKey)) : null;
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

// A plain shopping list, one line per season.
function toText() {
  const { shows, totals } = list();
  const lines = [
    `Deadair missing episodes, ${new Date().toLocaleDateString('en-CA')}`,
    `${totals.episodes} aired episodes missing across ${totals.shows} shows (specials not counted)`,
    '',
  ];
  for (const s of shows) {
    lines.push(`${s.title}${s.year ? ` (${s.year})` : ''} · have ${s.have} of ${s.total}${s.unknown ? ` · ${s.unknown} files numbered differently from TMDB` : ''}`);
    for (const se of s.seasons) {
      lines.push(se.whole
        ? `    Season ${se.season}: all ${se.aired} episodes`
        : `    Season ${se.season}: episodes ${ranges(se.missing.map((e) => e.episode))}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = { list, forShow, setIgnored, toText };
