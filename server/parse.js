// Filename -> metadata heuristics. Each file is classified on its own as a movie or a TV
// episode, so one folder can mix both. Handles Plex-style layouts and typical downloads:
//   Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv
//   Breaking Bad (2008)/Season 1/Breaking.Bad.S01E02.720p.mkv
//   Futurama S01-S07 (1999-)/Futurama S02 (360p)/Futurama S02E01 A Flight To Remember.mp4
//   [CBM] Neon Genesis Evangelion 1-26 Complete/[CBM]_Neon_Genesis_Evangelion_-_11_-_In_the_Still_Darkness.mkv
const path = require('node:path');

const JUNK_RE = /(?:^|[\s\-[(])(?:2160p|1080p|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dovi|bluray|blu-ray|bdrip|brrip|webrip|web-?dl|hdtv|dvdrip|dvdscr|hdrip|x26[45]|h\.?26[45]|hevc|xvid|divx|aac[\d.]*|ac3|e?ac3|ddp?[\d.]*|dts(?:-hd)?|truehd|atmos|remux|proper|repack|unrated|10bit|8bit)(?=$|[\s\-\])]).*$/i;

function tidy(s, { junk = false } = {}) {
  // Drop [group] tags and {tmdb-123}-style id hints.
  let t = s.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
  // Dotted scene names ("The.Office.S01E01") use dots as spaces; real titles ("Mr. Robot") don't.
  if (!/\s/.test(t.trim())) t = t.replace(/[._]+/g, ' ');
  else t = t.replace(/_+/g, ' ');
  if (junk) t = t.replace(JUNK_RE, '');
  return t
    .replace(/\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s\-–:(.]+$/, '')
    .replace(/^[\s\-–.]+/, '')
    .trim();
}

function slug(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

// Greedy match so "Blade Runner 2049 (2017)" picks 2017, not 2049.
function parseTitleYear(name) {
  const m = name.match(/^(.+)[\s._\-([]+((?:19|20)\d{2})(?=$|[\s._\-)\]])/);
  if (m) {
    const title = tidy(m[1]);
    if (title) return { title, year: Number(m[2]) };
  }
  return { title: tidy(name, { junk: true }) || name, year: null };
}

// Folder names like "Season 2", "Better Call Saul - Season 4 (2018)", "Futurama S03 (360p)", even with a
// typo after the number ("Season 05l The Assault"),
// but not season ranges like "Futurama S01-S07".
const SEASON_DIR_RE = /\b(?:season|series)\s*\d{1,2}(?!\d)|(?<![-\d]\s*)\bs\d{1,2}\b(?!\s*-\s*s?\d)|^specials?$/i;
// ...but a folder naming several seasons is a box set, not a season: "(Season 1, 2, 3 & 4)", "Seasons 1-6".
const SEASON_LIST_RE = /\bseasons?\s*\d{1,2}\s*(?:[,&+]|-\s*\d|to\s+\d|and\s+\d)|\bseasons\s+\d/i;
const isSeasonDir = (name) => SEASON_DIR_RE.test(name) && !SEASON_LIST_RE.test(name);
// Containers that hold shows, never a show themselves.
const GENERIC_DIR_RE = /^(?:tv|tv[\s._-]*shows?|shows?|series|movies?|films?|media|videos?|downloads?|torrents?|complete|library|plex|anime|kids)$/i;
// ...and box-set folders that only list seasons ("Seasons 1-10"): the show is named further up.
const SEASONS_ONLY_RE = /^(?:seasons?|series)\b/i;

function seasonFromDir(name) {
  const m = name.match(/\b(?:season|series)\s*(\d{1,2})(?!\d)/i) || name.match(/(?<![-\d]\s*)\bs(\d{1,2})\b(?!\s*-\s*s?\d)/i);
  if (m) return Number(m[1]);
  return /^specials?$/i.test(name.trim()) ? 0 : null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
// Same show? One name contains the other, or they clearly start the same way
// ("Star Trek TNG" / "Star Trek - The Next Generation").
const related = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  let common = 0;
  while (common < x.length && x[common] === y[common]) common++;
  return common >= 6;
};
// "better call saul" -> "Better Call Saul"; names that already have capitals are left alone.
const titleCase = (s) => (s === s.toLowerCase() ? s.replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase()) : s);

// Show title from a folder name, dropping packaging:
//   "Futurama S01-S07 (1999-) + 4 Movies"                       -> Futurama (1999)
//   "NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras" -> NewsRadio
//   "The Sopranos - The Complete Series (Season 1, 2 & 3)"      -> The Sopranos
function showFromFolder(name) {
  const year = Number(name.match(/\(((?:19|20)\d{2})/)?.[1]) || null;
  // Leading release-group tags go ("[CBM] Show"); the title ends at the first bracket after the
  // name, except a country tag like "(US)" that's part of it.
  let t = name.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '');
  const end = t.search(/\[|\{|\((?!(?:us|uk|au|nz|ca)\))/i);
  if (end > 0) t = t.slice(0, end);
  if (!/\s/.test(t.trim())) t = t.replace(/[._]+/g, ' ');
  const cut = t.search(/\s(?:s\d{1,2}\b|seasons?\b|(?:the\s+)?complete\b|collection\b|\d{1,3}\s?-\s?\d{1,3}\b|\+|\d{3,4}p\b)/i);
  if (cut > 0) t = t.slice(0, cut);
  const title = titleCase(tidy(t, { junk: true }));
  return title ? { title, year } : null;
}

function parseEpisode(name) {
  // Specials like "Futurama S07X01 Simpsorama (The Simpsons S26E06)". Their numbering doesn't match
  // TMDB's Specials season, so no episode number: the title comes from the filename.
  let m = name.match(/^(.*?)[\s._\-]*\bs(\d{1,2})x(\d{1,3})(?!\d)(.*)$/i);
  if (m) return { showFromName: tidy(m[1]), season: 0, episode: null, episodeEnd: null, episodeTitle: tidy(m[4], { junk: true }) };
  m = name.match(/^(.*?)[\s._\-]*\bs(\d{1,2})[\s._\-]?e(\d{1,3})(?:-?e(\d{1,3}))?(?!\d)(.*)$/i);
  if (!m) {
    const x = name.match(/^(.*?)[\s._\-]*\b(\d{1,2})x(\d{2,3})\b(.*)$/i);
    if (x) m = [x[0], x[1], x[2], x[3], undefined, x[4]];
  }
  if (!m) {
    // Spelled out: "The Sopranos Season 1 Episode 01 - Pilot".
    const w = name.match(/^(.*?)[\s._\-]*\bseason[\s._\-]*(\d{1,2})[\s._\-]*(?:episode|ep)[\s._\-]*(\d{1,3})(?!\d)(.*)$/i);
    if (w) m = [w[0], w[1], w[2], w[3], undefined, w[4]];
  }
  if (!m) return null;
  return {
    showFromName: tidy(m[1]),
    season: Number(m[2]),
    episode: Number(m[3]),
    episodeEnd: m[4] ? Number(m[4]) : null,
    episodeTitle: tidy(m[5] || '', { junk: true }),
  };
}

// Returns episode info, or null if the file looks like a movie.
function detectEpisode(base, folders) {
  const ep = parseEpisode(base);
  if (ep) return ep;
  // Anime-style absolute numbering: "Neon Genesis Evangelion - 11 - In the Still Darkness".
  // Numbers like these may count straight through the whole show (metadata.js sorts that out).
  const anime = tidy(base).match(/^(.+?)\s+-\s+(\d{1,3})(?:v\d)?(?:\s+-\s+(.*))?$/);
  if (anime) return { showFromName: anime[1], season: null, episode: Number(anime[2]), episodeEnd: null, episodeTitle: tidy(anime[3] || '', { junk: true }), numbered: Number(anime[2]) };
  // "Episode 7" / "E07", or anything sitting in a season folder.
  const num = base.match(/\b(?:e|ep|episode)\s*(\d{1,3})\b/i);
  const inSeasonDir = folders.length > 0 && isSeasonDir(folders[folders.length - 1]);
  // Just a name and a number in a season folder: "Season 05; The Assault/Bleach 100.mkv". The show
  // comes from the folders, so a stray "Part 1.mkv" doesn't become a show called "Part". The number
  // is only a hint until metadata.js finds the whole show counts straight through: in a season
  // folder of a show numbered S05E01, "One Man NewsRadio - Joe Furey 01" isn't episode 1.
  const bare = !num && inSeasonDir && tidy(base, { junk: true }).match(/^\D.*?\s(\d{1,3})(?:-(\d{1,3}))?$/);
  if (bare) return { showFromName: '', season: null, episode: null, episodeEnd: null, episodeTitle: '', numbered: Number(bare[1]), numberedEnd: bare[2] ? Number(bare[2]) : null };
  if (num || inSeasonDir) return { showFromName: '', season: null, episode: num ? Number(num[1]) : null, episodeEnd: null, episodeTitle: '' };
  return null;
}

// Folders of extras: "Featurettes", "Deleted Scenes", "Bonus Disc", "S01&S02 DVD Special Features",
// "Season 10 On-Set_Behind the Scenes [720p]", Plex's "Behind The Scenes" / "Trailers" / "Shorts".
// Only names that *start* that way: "Futurama S01-S07 + Extras" is a show, not its extras.
// Plex's "Other" is left out on purpose: in practice it holds real movies.
const EXTRAS_DIR_RE = /^(?:extras?|bonus\b.*|special features?|featurettes?|behind the (?:scenes|studio)|on-set\b.*|deleted(?: scenes?)?|(?:alternate|extended) (?:takes?|endings?|scenes?|versions?)|lost (?:content|interviews?|scenes?)|interviews?|trailers?|teasers?|bloopers?\b.*|gag reels?|outtakes?|menu intros?|making of\b.*|shorts|scenes|3d models?\b.*|commentar(?:y|ies)|tv spots?|storyboards?)\W*$/i;
// "S01&S02 ", "Season 10 ", "DVD " in front of the folder's real name.
const EXTRAS_PREFIX_RE = /^(?:(?:s\d{1,2}(?:\s*[&+,-]\s*s?\d{1,2})*|season\s*\d{1,2}|dvd|blu-?ray|bd)\s+)+/i;
const isExtrasDir = (name) => EXTRAS_DIR_RE.test(tidy(name, { junk: true }).replace(EXTRAS_PREFIX_RE, ''));
// Plex's "Movie (2010)-trailer.mkv" style, and a lone "Theatrical Trailer.avi" next to a film.
const isExtraName = (base) => /-(?:trailer|teaser|behindthescenes|deleted|featurette|interview|scene|short)$/i.test(base)
  || /^(?:(?:official|theatrical|original|international|teaser)\s+)?trailer(?:\s*\d+)?$/i.test(tidy(base, { junk: true }));

// What an extra is listed under on its title's page: the folders between the title and the file,
// e.g. "Season 3 › Deleted Scenes" or "Lost Interviews". A leading "Extras"/"Featurettes" folder is
// dropped when there's something more specific below it.
function extraGroup(owner, below) {
  const parts = below.map((f) => tidy(f, { junk: true }) || f);
  if (parts.length > 1 && isExtrasDir(below[0])) parts.shift();
  const season = owner ? seasonFromDir(owner) : null;
  if (season != null) parts.unshift(season === 0 ? 'Specials' : `Season ${season}`);
  return parts.filter((p, i) => p !== parts[i - 1]).join(' › ') || 'Extras';
}

// `extras: false` gives the classification from before extras were recognised (catalog.js uses it
// to tidy up titles that turned out to be extras).
function parseMedia(file, lib, { extras = true } = {}) {
  const base = path.parse(file).name;
  const folders = path.relative(lib.path, file).split(path.sep).slice(0, -1);
  // Extras belong to the show or movie in the folder above the extras folder (worked out by
  // extras.js). Numbered specials ("South Park/Extras/South Park S00E01") stay episodes.
  const extraDir = extras ? folders.findIndex(isExtrasDir) : -1;
  if ((extraDir >= 0 && parseEpisode(base)?.season !== 0) || (extras && isExtraName(base))) {
    const at = extraDir >= 0 ? extraDir : folders.length;
    return {
      kind: 'extra',
      title: tidy(base, { junk: true }) || base,
      extraOf: path.join(lib.path, ...folders.slice(0, at)),
      extraGroup: extraGroup(folders[at - 1], folders.slice(at)),
      extraPath: [...folders, base].join('/'),
    };
  }

  const ep = detectEpisode(base, folders);

  if (ep) {
    // The show's folder is the nearest one that isn't a season folder. Trust it when it agrees
    // with the name in the filename (or the filename has none); otherwise use the filename.
    const showDir = [...folders].reverse().find((f) => !isSeasonDir(f) && !GENERIC_DIR_RE.test(f.trim()) && !SEASONS_ONLY_RE.test(f.trim()));
    const fromDir = showDir ? showFromFolder(showDir) : null;
    // A filename "show" with no real words ("01 - s1e01 - Pilot") isn't a show name.
    const fromName = /[a-z]{2}/i.test(ep.showFromName || '') ? titleCase(ep.showFromName) : '';
    const useDir = fromDir && (!fromName || related(fromDir.title, fromName));
    const show = (useDir ? fromDir.title : fromName) || fromDir?.title || tidy(base, { junk: true });
    const seasonDir = [...folders].reverse().find(isSeasonDir);
    const season = ep.season ?? (seasonDir ? seasonFromDir(seasonDir) : null) ?? 1;
    let { episode, numbered } = ep;
    // Season and episode run together: "Home Improvement Season 2/Home Improvement - 207 - …" is S2E07.
    if (numbered >= 100 && seasonDir && Math.floor(numbered / 100) === season) {
      episode = numbered % 100;
      numbered = null;
    }
    return {
      kind: 'episode',
      show,
      showKey: slug(show),
      showYear: useDir ? fromDir.year : null,
      season,
      episode,
      episodeEnd: ep.episodeEnd,
      title: ep.episodeTitle || (episode != null ? `Episode ${episode}` : tidy(base, { junk: true })),
      // Where the file says it is, for metadata.js to place shows that count straight through.
      numbered: numbered != null ? { season, episode: numbered, end: ep.numberedEnd ?? null } : undefined,
    };
  }

  // Movie. Drop franchise markers like "S05M01" ("Futurama S05M01 Bender's Big Score (2007)").
  let { title, year } = parseTitleYear(base.replace(/\bs\d{1,2}m\d{1,2}\b/i, ' '));
  // Fall back to the containing folder when the filename is generic ("movie.mkv").
  if (!year && folders.length) {
    const f = parseTitleYear(folders[folders.length - 1]);
    if (f.year) ({ title, year } = f);
  }
  return { kind: 'movie', title, year };
}

// Specials (season 0) go after the regular seasons, as in Plex.
const seasonRank = (s) => (s === 0 ? 1e6 : s);
const episodeOrder = (a, b) => (seasonRank(a.season) - seasonRank(b.season)) || ((a.episode ?? 1e9) - (b.episode ?? 1e9)) || a.title.localeCompare(b.title, undefined, { numeric: true });

module.exports = { parseMedia, parseEpisode, parseTitleYear, slug, tidy, episodeOrder };
