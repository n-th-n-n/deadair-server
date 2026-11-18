// Channels made from your own library: 24/7 schedules of shows and movies, like a TV network.
//
// A channel is some content (shows, movies, whole libraries, genres) and an order: in order,
// rotating between shows, or shuffled. Each channel is planned a few days ahead as a list of
// slots (what plays when), kept in data/db.json so the guide stays put. The plan is extended as
// time passes, and re-planned from the next program when the channel is edited or its content
// changes (new episodes, deleted files). The program on air is never cut off.
const crypto = require('node:crypto');
const db = require('./db');
const media = require('./media');
const metadata = require('./metadata');
const scanner = require('./scanner');
const { mediaKey, movieKey } = require('./keys');
const { episodeOrder } = require('./parse');

const HOUR = 60 * 60 * 1000;
const PLAN_AHEAD = 72 * HOUR; // how far ahead the guide goes
const TOP_UP = 48 * HOUR;     // extend the plan once less than this is left
const KEEP_PAST = 6 * HOUR;   // finished programs kept for the guide
const MAX_SLOTS = 3000;       // a channel of very short clips shouldn't plan forever

const ORDERS = ['sequential', 'rotate', 'shuffle'];
const { state } = db;
const channels = () => (state.channels ||= []);
const plans = () => (state.plans ||= {}); // channel id -> { base, slots, config, content, lib }

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const byNumber = (a, b) => (parseFloat(a.number) - parseFloat(b.number)) || a.name.localeCompare(b.name);

// ---------- content ----------

// Whether an item belongs on the channel. Extras and specials (season 0, usually extras too) are left out.
function matcher(ch) {
  const want = { show: new Set(), movie: new Set(), library: new Set(), genre: new Set() };
  for (const c of ch.content) want[c.type]?.add(c.showKey ?? c.key ?? c.libraryId ?? c.genre);
  const genreHit = (genres) => want.genre.size > 0 && (genres || []).some((g) => want.genre.has(g));
  return (item) => {
    if (item.kind === 'extra') return false;
    if (want.library.has(item.libraryId)) return item.kind !== 'episode' || item.season !== 0;
    if (item.kind === 'episode') {
      if (item.season === 0) return false;
      return want.show.has(item.showKey) || genreHit(metadata.showMeta(item.showKey)?.genres);
    }
    return want.movie.has(movieKey(item)) || genreHit(metadata.movieMeta(item)?.genres);
  };
}

const showTitle = (item) => metadata.showMeta(item.showKey)?.title || item.show;
const movieTitle = (item) => metadata.movieMeta(item)?.title || item.title;
const movieYear = (item) => metadata.movieMeta(item)?.year ?? item.year ?? 0;

// Everything playable on the channel as groups: one per show (episodes in order), then the movies
// (by year). One copy of each title; items without a known duration can't be scheduled.
function contentOf(ch) {
  const match = matcher(ch);
  const seen = new Set();
  const shows = new Map();
  const movies = [];
  for (const item of Object.values(state.items)) {
    if (!(item.duration > 0) || !media.isServable(item) || !match(item)) continue;
    const key = mediaKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.kind === 'movie') movies.push(item);
    else if (shows.has(item.showKey)) shows.get(item.showKey).push(item);
    else shows.set(item.showKey, [item]);
  }
  const groups = [...shows].map(([showKey, eps]) => ({ key: `show:${showKey}`, title: showTitle(eps[0]), items: eps.sort(episodeOrder) }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  if (movies.length) {
    movies.sort((a, b) => (movieYear(a) - movieYear(b)) || movieTitle(a).localeCompare(movieTitle(b)));
    groups.push({ key: 'movies', title: 'Movies', items: movies });
  }
  return groups;
}

// ---------- picking what's next ----------
//
// The position after a slot is { lastKey, lastGroup, round, cursors: { group: lastKey } }. It's
// folded from the slots themselves, so re-planning from any slot continues from exactly there.

function fold(pos, slot) {
  pos.lastKey = slot.key;
  pos.lastGroup = slot.group;
  if (slot.round != null) pos.round = slot.round;
  (pos.cursors ||= {})[slot.group] = slot.key;
  return pos;
}

const clonePos = (pos) => ({ ...pos, cursors: { ...pos.cursors } });

function picker(ch, groups) {
  const all = groups.flatMap((g) => g.items.map((item) => ({ item, group: g.key, key: mediaKey(item) })));
  if (!all.length) return () => null;

  if (ch.order === 'rotate') {
    // One from each show in turn (all the movies count as one "show").
    return (pos) => {
      const gi = groups.findIndex((g) => g.key === pos.lastGroup);
      const g = groups[(gi + 1) % groups.length];
      const ci = g.items.findIndex((i) => mediaKey(i) === pos.cursors?.[g.key]);
      const item = g.items[(ci + 1) % g.items.length];
      return { item, group: g.key, key: mediaKey(item) };
    };
  }

  if (ch.order === 'shuffle') {
    // Every title once per round, in a random order that's fixed for that round (seeded by the
    // channel and round number). New titles slot into the current round.
    const rounds = new Map();
    const order = (round) => {
      if (!rounds.has(round)) {
        rounds.set(round, all.map((e) => ({ ...e, rank: sha1(`${ch.id}:${round}:${e.key}`) })).sort((a, b) => (a.rank < b.rank ? -1 : 1)));
      }
      return rounds.get(round);
    };
    return (pos) => {
      const round = pos.round ?? 0;
      const rank = pos.lastKey ? sha1(`${ch.id}:${round}:${pos.lastKey}`) : '';
      const next = order(round).find((e) => e.rank > rank);
      if (next) return { ...next, round };
      // Start a new round, but not with what just played.
      const fresh = order(round + 1);
      return { ...(fresh[0].key === pos.lastKey && fresh.length > 1 ? fresh[1] : fresh[0]), round: round + 1 };
    };
  }

  // In order: each show start to finish, then the next, then the movies, then around again.
  return (pos) => {
    const i = all.findIndex((e) => e.key === pos.lastKey);
    return all[(i + 1) % all.length];
  };
}

// ---------- the plan ----------

const configSig = (ch) => sha1(JSON.stringify([ch.content, ch.order]));
const contentSig = (groups) => sha1(groups.map((g) => `${g.key}:${g.items.map(mediaKey).join(',')}`).join('|'));
// Changes whenever a scan, metadata run or library change could have changed what's on a channel.
const librarySig = () => `${Object.keys(state.items).length}:${scanner.status.lastScan}:${metadata.status.lastRun}:${state.libraries.length}`;

// Brings a channel's plan up to date for time `now` and returns it.
function plan(ch, now = Date.now()) {
  const p = (plans()[ch.id] ||= { base: {}, slots: [] });
  let changed = false;
  let replan = false;
  let groups = null;

  if (p.config !== configSig(ch)) {
    p.config = configSig(ch);
    replan = true;
  }
  if (p.lib !== librarySig()) {
    p.lib = librarySig();
    groups = contentOf(ch);
    const sig = contentSig(groups);
    if (p.content !== sig) {
      p.content = sig;
      replan = true;
    }
    changed = true;
  }
  while (p.slots.length && p.slots[0].end < now - KEEP_PAST) {
    fold(p.base, p.slots.shift());
    changed = true;
  }
  if (replan) {
    // Keep what's on now; everything after it is planned again.
    const cur = p.slots.findIndex((s) => s.end > now);
    if (cur >= 0 && p.slots.length > cur + 1) p.slots.length = cur + 1;
    changed = true;
  }
  const last = p.slots.at(-1);
  if (!last || last.end < now + TOP_UP) {
    groups ||= contentOf(ch);
    const next = picker(ch, groups);
    const pos = p.slots.reduce(fold, clonePos(p.base));
    // Nothing planned for right now (new channel, or the server was off): start fresh from now.
    let t = last && last.end > now ? last.end : now;
    const before = p.slots.length;
    while (t < now + PLAN_AHEAD && p.slots.length < MAX_SLOTS) {
      const pick = next(pos);
      if (!pick) break;
      const slot = { id: pick.item.id, key: pick.key, group: pick.group, start: t, end: t + Math.round(pick.item.duration * 1000) };
      if (pick.round != null) slot.round = pick.round;
      p.slots.push(slot);
      fold(pos, slot);
      t = slot.end;
    }
    if (p.slots.length > before) changed = true;
  }
  if (changed) db.save();
  return p;
}

// The file to play for a slot: the one planned, or another copy of the same title.
function resolve(slot) {
  const item = state.items[slot.id];
  if (item && media.isServable(item)) return item;
  return Object.values(state.items).find((i) => mediaKey(i) === slot.key && media.isServable(i)) || null;
}

// The slot on air at time t, with its item. A slot whose file has gone is cut short and the
// channel re-planned from there.
function onAir(ch, t = Date.now()) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = plan(ch, t);
    const i = p.slots.findIndex((s) => s.start <= t && t < s.end);
    if (i < 0) return null;
    const item = resolve(p.slots[i]);
    if (item) return { slot: p.slots[i], item, next: p.slots[i + 1] || null };
    p.slots.length = i;
    db.save();
  }
  return null;
}

// Guide entry for a slot. Images are TMDB paths (or none, then clients use the frame grab).
function describe(slot) {
  const item = resolve(slot);
  const base = { start: slot.start, stop: slot.end, itemId: item?.id };
  if (!item) return { ...base, title: 'Unavailable' };
  if (item.kind === 'episode') {
    const show = metadata.showMeta(item.showKey);
    const ep = metadata.episodeMeta(item);
    return {
      ...base,
      title: show?.title || item.show,
      subtitle: ep?.name || item.title,
      season: item.season,
      episode: item.episode,
      desc: ep?.overview || show?.overview,
      image: ep?.still || show?.backdrop,
      poster: show?.poster,
      genres: show?.genres,
      rating: show?.contentRating,
      year: show?.year ?? item.showYear,
    };
  }
  const m = metadata.movieMeta(item);
  return {
    ...base,
    title: m?.title || item.title,
    movie: true,
    year: m?.year ?? item.year,
    desc: m?.overview,
    image: m?.backdrop,
    poster: m?.poster,
    genres: m?.genres,
    rating: m?.contentRating,
  };
}

function programs(ch, from, to) {
  return plan(ch).slots.filter((s) => s.end > from && s.start < to).map(describe);
}

// ---------- editing ----------

const clean = (s, max) => String(s ?? '').trim().slice(0, max);

function validate(input, id) {
  const name = clean(input?.name, 80);
  if (!name) throw new Error('Give the channel a name');
  const number = clean(input?.number, 10) || String(Math.max(0, ...channels().filter((c) => c.id !== id).map((c) => Math.floor(parseFloat(c.number)) || 0)) + 1);
  if (!/^\d{1,5}(\.\d{1,3})?$/.test(number)) throw new Error('Channel number should look like 7 or 7.1');
  const order = ORDERS.includes(input?.order) ? input.order : 'sequential';
  const content = [];
  for (const c of Array.isArray(input?.content) ? input.content.slice(0, 5000) : []) {
    if (c?.type === 'show' && c.showKey) content.push({ type: 'show', showKey: clean(c.showKey, 200) });
    else if (c?.type === 'movie' && c.key) content.push({ type: 'movie', key: clean(c.key, 300) });
    else if (c?.type === 'library' && c.libraryId) content.push({ type: 'library', libraryId: clean(c.libraryId, 40) });
    else if (c?.type === 'genre' && c.genre) content.push({ type: 'genre', genre: clean(c.genre, 60) });
  }
  if (!content.length) throw new Error('Pick at least one show, movie, library or genre');
  return { name, number, order, content };
}

function create(input) {
  const ch = { id: crypto.randomUUID().slice(0, 8), ...validate(input), createdAt: Date.now() };
  channels().push(ch);
  channels().sort(byNumber);
  db.save();
  return ch;
}

function update(id, input) {
  const ch = channels().find((c) => c.id === id);
  if (!ch) return null;
  Object.assign(ch, validate(input, id));
  channels().sort(byNumber);
  db.save();
  return ch;
}

function remove(id) {
  const before = channels().length;
  state.channels = channels().filter((c) => c.id !== id);
  delete plans()[id];
  db.save();
  return state.channels.length < before;
}

// Channel plus a summary of what's on it, for the setup page.
function overview(ch) {
  const groups = contentOf(ch);
  const shows = groups.filter((g) => g.key !== 'movies').length;
  const movies = groups.find((g) => g.key === 'movies')?.items.length || 0;
  const duration = groups.reduce((sum, g) => sum + g.items.reduce((s, i) => s + i.duration, 0), 0);
  return { ...ch, shows, movies, duration };
}

// Everything that can go on a channel, for the channel editor.
function catalog() {
  const shows = new Map();
  const movies = new Map();
  const genres = new Set();
  for (const item of Object.values(state.items)) {
    if (!media.isServable(item)) continue;
    if (item.kind === 'episode') {
      if (item.season === 0) continue;
      const s = shows.get(item.showKey);
      if (s) {
        s.episodes++;
        continue;
      }
      const meta = metadata.showMeta(item.showKey);
      for (const g of meta?.genres || []) genres.add(g);
      shows.set(item.showKey, { showKey: item.showKey, title: meta?.title || item.show, year: meta?.year ?? item.showYear, poster: meta?.poster, episodes: 1 });
    } else if (!movies.has(movieKey(item))) {
      const meta = metadata.movieMeta(item);
      for (const g of meta?.genres || []) genres.add(g);
      movies.set(movieKey(item), { key: movieKey(item), title: meta?.title || item.title, year: meta?.year ?? item.year, poster: meta?.poster });
    }
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });
  return {
    libraries: state.libraries.map((l) => ({ id: l.id, name: l.name })),
    genres: [...genres].sort(),
    shows: [...shows.values()].sort(byTitle),
    movies: [...movies.values()].sort(byTitle),
  };
}

module.exports = { list: () => channels(), find: (id) => channels().find((c) => c.id === id), plan, onAir, programs, describe, create, update, remove, overview, catalog, byNumber, ORDERS };
