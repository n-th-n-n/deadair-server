import { api, esc, fmtClock, fmtDuration, fmtSize, epCode, tmdbImg } from './util.js';
import { mountPlayer } from './player.js';
import { guidePage, mountLive, setupPage } from './live.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let cleanup = null;
let libraries = [];

// ---------- images & cards ----------

const frameUrl = (id) => id && `/api/items/${id}/thumb`;
// "4K" / "1080p" and HDR badges for a file.
const qualityTags = (f) => [f.quality && `<span class="q q-${f.quality.toLowerCase()}">${esc(f.quality)}</span>`,
  f.hdr && `<span class="q q-hdr">${esc(f.hdr)}</span>`].filter(Boolean).join('');
const folderLink = (f) => `#/library/${f.libraryId}${f.folder ? `?path=${encodeURIComponent(f.folder)}` : ''}`;
const initial = (t) => (t || '?').trim()[0]?.toUpperCase() || '?';

// Tries each source in turn, then falls back to a big initial letter.
window.imgFail = (img) => {
  const next = img.dataset.fb;
  if (next) {
    img.removeAttribute('data-fb');
    img.src = next;
  } else {
    img.parentElement.classList.add('noimg');
    img.remove();
  }
};

function img(sources, cls = '') {
  const [first, fallback] = sources.filter(Boolean);
  if (!first) return '';
  return `<img loading="lazy" class="${cls}" src="${esc(first)}" ${fallback ? `data-fb="${esc(fallback)}"` : ''} alt="" onerror="imgFail(this)">`;
}

function progressBar(p, duration) {
  if (!p || p.watched || !p.position || !duration) return '';
  return `<div class="bar"><span style="width:${Math.min(100, (p.position / duration) * 100).toFixed(1)}%"></span></div>`;
}

function card({ href, sources, title, sub, poster, progress, duration, badge = '' }) {
  return `<a class="card ${poster ? 'poster' : ''}" href="${href}">
    <div class="thumb ${sources.some(Boolean) ? '' : 'noimg'}" data-initial="${esc(initial(title))}">${img(sources)}${progressBar(progress, duration)}${badge}</div>
    <div class="title" title="${esc(title)}">${esc(title)}</div>
    <div class="sub">${esc(sub || '')}</div>
  </a>`;
}

const watchedBadge = (p) => (p?.watched ? '<span class="badge done">✓</span>' : '');

// poster=true -> 2:3 poster art; otherwise 16:9 (backdrops, episode stills, frame grabs).
function itemCard(i, { poster = false } = {}) {
  if (i.kind === 'video') {
    return card({
      href: `#/item/${i.id}`, title: i.title, sub: [i.channel, fmtDuration(i.duration)].filter(Boolean).join(' · '),
      sources: [frameUrl(i.id)], progress: i.progress, duration: i.duration, badge: watchedBadge(i.progress),
    });
  }
  if (i.kind === 'extra') {
    return card({
      href: `#/item/${i.id}`, title: i.title, sub: fmtDuration(i.duration),
      sources: [frameUrl(i.id)], progress: i.progress, duration: i.duration, badge: watchedBadge(i.progress),
    });
  }
  if (i.kind === 'episode') {
    return card({
      href: `#/item/${i.id}`, title: i.show, sub: `${epCode(i)} · ${i.title}`,
      sources: [tmdbImg(i.still, 'w500'), frameUrl(i.id), tmdbImg(i.backdrop, 'w780')],
      progress: i.progress, duration: i.duration, badge: watchedBadge(i.progress),
    });
  }
  return card({
    href: `#/item/${i.id}`, title: i.title, poster,
    sub: [i.year, fmtDuration(i.duration)].filter(Boolean).join(' · '),
    sources: poster ? [tmdbImg(i.poster), frameUrl(i.id)] : [tmdbImg(i.backdrop, 'w780'), frameUrl(i.id)],
    progress: i.progress, duration: i.duration, badge: watchedBadge(i.progress),
  });
}

function showCard(s) {
  return card({
    href: `#/show/${s.libraryId}/${encodeURIComponent(s.showKey)}`, title: s.title, poster: true,
    sub: [s.year, `${s.episodeCount} episode${s.episodeCount === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
    sources: [tmdbImg(s.poster), frameUrl(s.thumbId)],
    badge: s.unwatched ? `<span class="badge">${s.unwatched}</span>` : '<span class="badge done">✓</span>',
  });
}

const backdrop = (p) => (p ? `<div class="backdrop" style="background-image:url('${esc(tmdbImg(p, 'w1280'))}')"></div>` : '');

function metaLine(parts) {
  return `<div class="meta">${parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('')}</div>`;
}

const ratingHtml = (r) => (r ? `<span class="rating">★ ${r.toFixed(1)}</span>` : '');
const chip = (t) => `<span class="chip">${esc(t)}</span>`;

function castRow(cast) {
  if (!cast?.length) return '';
  return `<h2>Cast</h2><div class="cast">${cast.map((c) => `<div class="person">
      <div class="avatar" data-initial="${esc(initial(c.name))}">${img([tmdbImg(c.profile, 'w185')])}</div>
      <div class="name">${esc(c.name)}</div><div class="muted role">${esc(c.character || '')}</div>
    </div>`).join('')}</div>`;
}

// Behind the scenes, deleted scenes and so on, one fold per folder they came in. A single folder
// is shown open; lots of them start closed so the page stays short.
function extrasSection(list) {
  if (!list?.length) return '';
  const groups = new Map();
  for (const e of list) {
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }
  const grid = (items) => `<div class="grid">${items.map((e) => itemCard(e)).join('')}</div>`;
  if (groups.size === 1) return `<h2>Extras</h2>${grid(list)}`;
  return `<h2>Extras <span class="muted">${list.length}</span></h2>${[...groups].map(([name, items]) => `<details class="extras-group" ${groups.size <= 3 ? 'open' : ''}>
      <summary>${esc(name)} <span class="muted">${items.length}</span></summary>${grid(items)}
    </details>`).join('')}`;
}

// ---------- nav ----------

async function loadLibraries() {
  libraries = await api('/api/libraries');
  renderNav();
}

function renderNav() {
  const hash = location.hash || '#/';
  nav.innerHTML = [`<a href="#/" class="${hash === '#/' ? 'active' : ''}">Home</a>`,
    `<a href="#/live" class="${hash.startsWith('#/live') ? 'active' : ''}">Live TV</a>`,
    // Plugins' links (both groups, 'Watch' then 'Backstage') come after Live TV.
    ...['Watch', 'Backstage'].flatMap((group) => plugged.nav.filter((l) => l.group === group))
      .map((l) => `<a href="${l.href}" class="${hash.startsWith(l.href) ? 'active' : ''}">${esc(l.label)}</a>`),
    ...libraries.map((l) => `<a href="#/library/${l.id}" class="${hash.startsWith(`#/library/${l.id}`) ? 'active' : ''}">${esc(l.name)}</a>`),
    `<a href="#/notes" class="${hash.startsWith('#/notes') ? 'active' : ''}">Notes</a>`,
  ].join('');
}

const isAdmin = () => !!currentUser?.admin;

const noLibraries = () => isAdmin()
  ? `<div class="empty"><h1>Welcome to Deadair</h1>
      <p>Add a folder of movies or shows to get started.</p>
      <p><a class="btn primary" href="#/settings">Add a library</a></p></div>`
  : '<div class="empty"><h1>Welcome to Deadair</h1><p>Nothing to watch yet.</p></div>';

// ---------- Fix match dialog ----------

function matchDialog({ type, query, year, apply }) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form class="fb-head match-form">
      <input class="input" name="q" value="${esc(query)}" placeholder="Title">
      <input class="input" name="year" value="${esc(year || '')}" placeholder="Year" inputmode="numeric" style="width:80px">
      <button class="btn primary">Search</button>
    </form>
    <div class="fb-list match-list"></div>
    <div class="fb-foot"><span class="muted" style="margin-right:auto;font-size:12px">Results from TMDB</span><button class="btn" type="button" data-close>Cancel</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.showModal();

  const form = dlg.querySelector('form');
  const list = dlg.querySelector('.match-list');
  async function run() {
    list.innerHTML = '<p class="muted pad">Searching…</p>';
    try {
      const { results } = await api(`/api/tmdb/search?type=${type}&q=${encodeURIComponent(form.q.value)}&year=${encodeURIComponent(form.year.value)}`);
      list.innerHTML = results.length ? results.map((r) => `<button class="match-item" data-id="${r.id}">
          <div class="mi-poster" data-initial="${esc(initial(r.title))}">${img([tmdbImg(r.poster, 'w92')])}</div>
          <div><strong>${esc(r.title)}</strong> <span class="muted">${r.year || ''}</span>
          <div class="muted clamp2">${esc(r.overview || '')}</div></div>
        </button>`).join('') : '<p class="muted pad">No results. Try a different title or clear the year.</p>';
      list.querySelectorAll('[data-id]').forEach((b) => (b.onclick = async () => {
        list.innerHTML = '<p class="muted pad">Fetching details…</p>';
        try {
          await apply(Number(b.dataset.id));
          dlg.close();
        } catch (err) {
          list.innerHTML = `<p class="error pad">${esc(err.message)}</p>`;
        }
      }));
    } catch (err) {
      list.innerHTML = `<p class="error pad">${esc(err.message)}</p>`;
    }
  }
  form.onsubmit = (e) => { e.preventDefault(); run(); };
  run();
}

// ---------- pages ----------

async function home() {
  const data = await api('/api/home');
  if (!libraries.length) return (view.innerHTML = noLibraries());
  let html = '';
  if (data.continueWatching.length) {
    html += `<h2>Continue watching</h2><div class="row">${data.continueWatching.map((i) => itemCard(i)).join('')}</div>`;
  }
  if (data.recentlyWatched?.length) {
    html += `<h2>Recently watched</h2><div class="row">${data.recentlyWatched.map((i) => itemCard(i)).join('')}</div>`;
  }
  if (data.recentMovies.length) {
    html += `<h2>Recently added movies</h2><div class="row posters">${data.recentMovies.map((i) => itemCard(i, { poster: true })).join('')}</div>`;
  }
  if (data.recentShows.length) {
    html += `<h2>Recently added TV</h2><div class="row posters">${data.recentShows.map(showCard).join('')}</div>`;
  }
  if (!data.recentMovies.length && !data.recentShows.length) {
    html += `<div class="empty">Your libraries are empty or still scanning.${isAdmin() ? ' <a href="#/settings">Check settings</a>.' : ''}</div>`;
  }
  view.innerHTML = html;
}

const SORTS = {
  title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
  added: (a, b) => b.addedAt - a.addedAt,
  year: (a, b) => (b.year || 0) - (a.year || 0),
  rating: (a, b) => (b.rating || 0) - (a.rating || 0),
};

function pref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
const naturally = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function library(id, q) {
  const folderPath = q?.get('path') || '';
  const data = await api(`/api/libraries/${id}/items`);
  // Folders shows the library as it is on disk; Movies / TV Shows group it by what was detected.
  const tabs = [['folders', 'Folders', null],
    ...[['movies', 'Movies', data.movies], ['shows', 'TV Shows', data.shows], ['videos', 'Videos', data.videos || []]].filter(([, , list]) => list.length)];
  let tab = folderPath ? 'folders' : pref(`libview:${id}`, 'folders');
  if (!tabs.some(([key]) => key === tab)) tab = 'folders';
  let browse = null; // folder listing, fetched when the Folders tab is shown
  let sort = pref(`sort:${id}`, 'title');
  let genre = '';
  let filter = '';

  view.innerHTML = `<div class="toolbar">
      <h1>${esc(data.library.name)}</h1>
      <div class="tabs" role="tablist">${tabs.map(([key, label, list]) =>
        `<button role="tab" data-tab="${key}">${label}${list ? ` <span class="muted">${list.length}</span>` : ''}</button>`).join('')}</div>
      <span class="spacer"></span>
      <input class="input" data-filter placeholder="Filter…">
      <select data-genre hidden></select>
      <select data-sort>
        <option value="title">Title</option><option value="added">Recently added</option>
        <option value="year">Year</option><option value="rating">Rating</option>
      </select>
    </div><div data-body></div>`;
  const body = view.querySelector('[data-body]');
  const sortSel = view.querySelector('[data-sort]');
  const genreSel = view.querySelector('[data-genre]');
  sortSel.value = sort;

  function genreOptions(genres) {
    if (!genres.includes(genre)) genre = '';
    genreSel.hidden = !genres.length;
    genreSel.innerHTML = `<option value="">All genres</option>${genres.map((g) => `<option>${esc(g)}</option>`).join('')}`;
    genreSel.value = genre;
  }

  // ----- Folders: the files as they are on disk, with the same artwork and details -----

  const folderSorts = {
    title: (a, b) => naturally(a.name ?? a.fileName, b.name ?? b.fileName),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
  };
  const folderHref = (p) => `#/library/${id}${p ? `?path=${encodeURIComponent(p)}` : ''}`;

  const folderCard = (f) => {
    const extra = f.title && f.title.toLowerCase() !== f.name.toLowerCase() ? f.title : null;
    return `<a class="card poster folder-card" href="${folderHref(f.path)}">
      <div class="thumb" data-initial="${esc(initial(f.name))}">${img([tmdbImg(f.poster), frameUrl(f.thumbId)])}
        <span class="folder-tag" title="Folder">${FOLDER_ICON}</span>
        ${f.unwatched ? `<span class="badge">${f.unwatched}</span>` : '<span class="badge done">✓</span>'}</div>
      <div class="title wrap" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="sub">${esc([extra, f.year, `${f.count} video${f.count === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}${f.rating ? ` · <span class="rating">★ ${f.rating.toFixed(1)}</span>` : ''}</div>
    </a>`;
  };

  const fileRow = (i) => {
    const ep = i.kind === 'episode';
    const detail = ep ? [i.show, epCode(i), i.title] : [i.title, i.year];
    const sources = ep ? [tmdbImg(i.still, 'w300'), frameUrl(i.id), tmdbImg(i.poster)] : [tmdbImg(i.poster, 'w185'), frameUrl(i.id)];
    return `<a class="file-row ${i.progress?.watched ? 'watched' : ''}" href="#/item/${i.id}">
      <div class="file-thumb"><div class="thumb ${ep ? '' : 'poster'}" data-initial="${esc(initial(i.title))}">${img(sources)}${progressBar(i.progress, i.duration)}</div></div>
      <div class="file-info">
        <div class="file-name">${esc(i.fileName)} ${qualityTags(i)}${i.copies > 1 ? ` <span class="q q-copies" title="This title has ${i.copies} files; see Settings → Duplicates">${i.copies} copies</span>` : ''}</div>
        <div class="muted file-detail">${esc(detail.filter((x) => x != null && x !== '').join(' · '))}${i.rating ? ` · <span class="rating">★ ${i.rating.toFixed(1)}</span>` : ''}${i.progress?.watched ? ' · <span class="watched-tag">Watched</span>' : ''}</div>
      </div>
      <div class="muted file-dur">${fmtDuration(i.duration)}</div>
    </a>`;
  };

  async function renderFolders() {
    if (!browse) {
      try {
        browse = await api(`/api/libraries/${id}/browse${folderPath ? `?path=${encodeURIComponent(folderPath)}` : ''}`);
      } catch (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}. <a href="${folderHref('')}">Back to ${esc(data.library.name)}</a></div>`;
        return;
      }
    }
    const parts = folderPath.split('/').filter(Boolean);
    genreOptions([...new Set([...browse.folders.flatMap((f) => f.genres), ...browse.files.flatMap((i) => i.genres || [])])].sort());
    const hit = (...texts) => texts.filter(Boolean).join(' ').toLowerCase().includes(filter);
    const byGenre = (genres) => !genre || (genres || []).includes(genre);
    const folders = browse.folders.filter((f) => hit(f.name, f.title) && byGenre(f.genres)).sort(folderSorts[sort]);
    const files = browse.files.filter((i) => hit(i.fileName, i.title, i.show) && byGenre(i.genres)).sort(folderSorts[sort]);
    const crumbs = [`<a href="${folderHref('')}">${esc(data.library.name)}</a>`,
      ...parts.map((p, n) => (n === parts.length - 1 ? `<span>${esc(p)}</span>` : `<a href="${folderHref(parts.slice(0, n + 1).join('/'))}">${esc(p)}</a>`))];
    body.innerHTML = `${parts.length ? `<nav class="crumbs" aria-label="Folder path">${crumbs.join('<span class="crumb-sep">/</span>')}</nav>` : ''}
      ${folders.length ? `<div class="grid posters folder-grid">${folders.map(folderCard).join('')}</div>` : ''}
      ${files.length ? `<div class="file-list">${files.map(fileRow).join('')}</div>` : ''}
      ${!folders.length && !files.length ? `<div class="empty">${browse.folders.length || browse.files.length ? 'No matches.' : 'Nothing here yet. The library may still be scanning.'}</div>` : ''}`;
  }

  // ----- Movies / TV Shows: grouped by what was detected -----

  function renderGrid() {
    const list = tab === 'shows' ? data.shows : tab === 'videos' ? data.videos : data.movies;
    genreOptions([...new Set(list.flatMap((i) => i.genres || []))].sort());
    const shown = list
      .filter((i) => [i.title, i.channel].join(' ').toLowerCase().includes(filter) && (!genre || i.genres?.includes(genre)))
      .sort(SORTS[sort]);
    body.innerHTML = `<div class="grid ${tab === 'videos' ? '' : 'posters'}">${shown.length
      ? shown.map((i) => (tab === 'shows' ? showCard(i) : itemCard(i, { poster: tab !== 'videos' }))).join('')
      : `<div class="empty" style="grid-column:1/-1">${list.length ? 'No matches.' : 'Nothing here yet. The library may still be scanning.'}</div>`}</div>`;
  }

  const render = () => {
    view.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    sortSel.options[0].textContent = tab === 'folders' ? 'Name' : 'Title';
    return tab === 'folders' ? renderFolders() : renderGrid();
  };
  view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; setPref(`libview:${id}`, tab); render(); }));
  sortSel.onchange = () => { sort = sortSel.value; setPref(`sort:${id}`, sort); render(); };
  genreSel.onchange = () => { genre = genreSel.value; render(); };
  view.querySelector('[data-filter]').oninput = (e) => { filter = e.target.value.trim().toLowerCase(); render(); };
  await render();
}

// ?season=N keeps the season you picked (Back from an episode returns to it), and ?ep=<id> is the
// episode you opened from here, scrolled to and highlighted when you come back.
async function show(libraryId, showKey, q) {
  const data = await api(`/api/libraries/${libraryId}/shows/${encodeURIComponent(showKey)}`);
  const m = data.meta;
  const bySeason = new Map();
  for (const ep of data.episodes) {
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
    bySeason.get(ep.season).push(ep);
  }
  const onDeck = data.episodes.find((e) => e.id === data.onDeck);
  const seasonName = (n) => data.seasons[n]?.name || (n === 0 ? 'Specials' : `Season ${n}`);
  // Admins see aired episodes they don't have (from TMDB) as greyed-out rows.
  const missingIn = new Map((data.missing?.seasons || []).map((s) => [s.season, s]));
  const otherSeasons = [...missingIn.values()].filter((s) => !bySeason.has(s.season));
  const missingCount = (data.missing?.total || 0) - (data.missing?.have || 0);

  view.innerHTML = `${backdrop(m?.backdrop)}<div class="page">
    <div class="detail">
      <div class="poster-art" data-initial="${esc(initial(data.title))}">${img([tmdbImg(m?.poster, 'w500'), frameUrl(onDeck.id)])}</div>
      <div>
        <h1>${esc(data.title)}</h1>
        ${metaLine([data.year, m?.contentRating && `<span class="cert">${esc(m.contentRating)}</span>`, ratingHtml(m?.rating),
          `${bySeason.size} season${bySeason.size > 1 ? 's' : ''}`, `${data.episodes.length} episodes`, esc(m?.network)])}
        ${m?.genres?.length ? `<div class="chips">${m.genres.map(chip).join('')}</div>` : ''}
        <div class="actions">
          <a class="btn primary" href="#/play/${onDeck.id}">▶ ${onDeck.progress?.position ? 'Resume' : 'Play'} ${esc(epCode(onDeck))}</a>
          ${isAdmin() ? '<button class="btn" data-fix>Fix match</button>' : ''}
          ${isAdmin() && m ? '<button class="btn" data-refresh>Refresh metadata</button>' : ''}
        </div>
        ${m?.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ''}
        ${m?.overview ? `<p class="overview">${esc(m.overview)}</p>` : ''}
        ${m?.creators?.length ? `<p class="muted">Created by ${esc(m.creators.join(', '))}</p>` : ''}
        ${missingCount ? `<p class="missing-note">You have ${data.missing.have} of ${data.missing.total} aired episodes${otherSeasons.length
          ? `. Not in your library: ${otherSeasons.map((s) => `Season ${s.season} (${s.aired})`).join(', ')}` : ''}. <a href="#/missing">All missing episodes</a></p>` : ''}
      </div>
    </div>
    <div class="season">
      <div class="season-bar">
        ${bySeason.size > 1
          ? `<select data-season aria-label="Season">${[...bySeason].map(([n, eps]) =>
            `<option value="${n}">${esc(seasonName(n))} · ${eps.length} episode${eps.length === 1 ? '' : 's'}${missingIn.get(n) ? ` · ${missingIn.get(n).missing.length} missing` : ''}</option>`).join('')}</select>`
          : `<h2>${esc(seasonName([...bySeason.keys()][0]))}</h2>`}
        <span class="muted" data-season-progress></span>
      </div>
      <p class="muted clamp2 season-overview" data-season-overview></p>
      <div data-episodes></div>
    </div>
    ${extrasSection(data.extras)}
    ${castRow(m?.cast)}
  </div>`;

  // One season at a time, starting with the one you're up to.
  const renderSeason = (n) => {
    const eps = bySeason.get(n) || [];
    const watched = eps.filter((e) => e.progress?.watched).length;
    view.querySelector('[data-season-progress]').textContent = watched ? `${watched} of ${eps.length} watched` : '';
    const overview = view.querySelector('[data-season-overview]');
    overview.textContent = data.seasons[n]?.overview || '';
    overview.hidden = !overview.textContent;
    const gaps = (missingIn.get(n)?.missing || []).map((g) => ({ ...g, gap: true }));
    const rows = [...eps, ...gaps].sort((a, b) => (a.episode ?? 1e9) - (b.episode ?? 1e9));
    view.querySelector('[data-episodes]').innerHTML = rows.map((e) => (e.gap ? `<div class="episode missing-ep">
        <div class="thumb"></div>
        <div><div class="ep-title">${e.episode}. ${esc(e.name || `Episode ${e.episode}`)}</div>
          <div class="muted" style="font-size:13px">Not in your library${e.airDate ? ` · aired ${new Date(`${e.airDate}T12:00`).toLocaleDateString()}` : ''}</div></div>
        <div><span class="q q-missing">Missing</span></div>
      </div>` : `<a class="episode ${e.progress?.watched ? 'watched' : ''}" href="#/item/${e.id}">
        <div class="thumb" data-initial="${esc(initial(e.title))}">${img([tmdbImg(e.still, 'w300'), frameUrl(e.id)])}${progressBar(e.progress, e.duration)}</div>
        <div><div class="ep-title">${e.episode != null ? `${e.episode}. ` : ''}${esc(e.title)}</div>
          ${e.overview ? `<div class="muted clamp2 ep-overview">${esc(e.overview)}</div>` : `<div class="muted" style="font-size:13px">${esc(epCode(e))}</div>`}</div>
        <div class="muted">${fmtDuration(e.duration)}</div>
      </a>`)).join('');
  };
  const seasonSel = view.querySelector('[data-season]');
  const asked = q?.has('season') ? Number(q.get('season')) : null;
  const startSeason = bySeason.has(asked) ? asked : bySeason.has(onDeck.season) ? onDeck.season : [...bySeason.keys()][0];
  const showHref = `#/show/${libraryId}/${encodeURIComponent(showKey)}`;
  // Update the address without a navigation, so Back comes here with the same season / episode.
  const remember = (season, ep) => history.replaceState(history.state, '', `${showHref}?season=${season}${ep ? `&ep=${ep}` : ''}`);
  if (seasonSel) {
    seasonSel.value = String(startSeason);
    seasonSel.onchange = () => { renderSeason(Number(seasonSel.value)); remember(seasonSel.value); };
  }
  renderSeason(startSeason);
  view.querySelector('[data-episodes]').addEventListener('click', (e) => {
    const link = e.target.closest('a.episode');
    if (link) remember(seasonSel ? seasonSel.value : startSeason, link.getAttribute('href').split('/').pop());
  });
  const back = q?.get('ep') && view.querySelector(`a.episode[href="#/item/${CSS.escape(q.get('ep'))}"]`);
  if (back) {
    back.scrollIntoView({ block: 'center' });
    back.classList.add('flash');
  }

  const url = `/api/libraries/${libraryId}/shows/${encodeURIComponent(showKey)}/match`;
  view.querySelector('[data-fix]')?.addEventListener('click', () => matchDialog({
    type: 'tv', query: data.localTitle, year: data.localYear,
    apply: async (tmdbId) => { await api(url, { method: 'POST', body: { tmdbId } }); show(libraryId, showKey, new URLSearchParams(location.hash.split('?')[1])); },
  }));
  view.querySelector('[data-refresh]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Refreshing…';
    await api(url, { method: 'POST', body: {} }).catch((err) => alert(err.message));
    show(libraryId, showKey, new URLSearchParams(location.hash.split('?')[1]));
  });
}

async function item(id) {
  const i = await api(`/api/items/${id}`);
  const m = i.meta || {};
  const isEp = i.kind === 'episode';
  const isMovie = i.kind === 'movie';
  const resume = i.progress && !i.progress.watched && i.progress.position > 5;
  const v = i.video;
  const specs = [
    ['Video', v && [v.codec?.toUpperCase(), v.width && `${v.width}×${v.height}`, v.pixFmt].filter(Boolean).join(' · ')],
    ['Audio', i.audio.map((a) => [a.codec?.toUpperCase(), a.channels && `${a.channels}ch`, a.lang].filter(Boolean).join(' ')).join(', ')],
    ['Subtitles', i.subtitles.map((s) => s.label).join(', ')],
    ['Playback', i.directPlay ? 'Direct play' : i.canTranscode ? 'Transcode (ffmpeg)' : 'Needs ffmpeg to play'],
    ['Size', fmtSize(i.size)],
    ['File', i.path],
    ['Probe error', i.probeError],
  ].filter(([, val]) => val);

  const art = isEp
    ? `<div class="hero" data-initial="${esc(initial(i.title))}">${img([tmdbImg(i.still, 'w780'), frameUrl(i.id)])}${progressBar(i.progress, i.duration)}</div>`
    : `<div class="poster-art" data-initial="${esc(initial(i.title))}">${img(isMovie ? [tmdbImg(i.poster, 'w500'), frameUrl(i.id)] : [frameUrl(i.id)])}${progressBar(i.progress, i.duration)}</div>`;

  view.innerHTML = `${backdrop(i.backdrop)}<div class="page">
    <div class="detail ${isEp ? 'wide' : ''}">
      ${art}
      <div>
        ${isEp ? `<a class="muted" href="#/show/${i.libraryId}/${encodeURIComponent(i.showKey)}?season=${i.season}&ep=${i.id}">${esc(i.show)} ›</a>` : ''}
        ${i.of ? `<a class="muted" href="${i.of.kind === 'show' ? `#/show/${i.of.libraryId}/${encodeURIComponent(i.of.showKey)}` : `#/item/${i.of.id}`}">${esc(i.of.title)} · Extras${i.group ? ` · ${esc(i.group)}` : ''} ›</a>` : ''}
        <h1>${esc(i.title)}</h1>
        ${metaLine([
          isEp && esc(epCode(i)), !isEp && i.year, isEp && m.airDate && new Date(m.airDate).toLocaleDateString(),
          m.contentRating && `<span class="cert">${esc(m.contentRating)}</span>`, ratingHtml(m.rating),
          fmtDuration(i.duration), qualityTags(i),
          i.progress?.watched && '<span style="color:var(--accent)">Watched</span>',
        ])}
        ${isMovie && m.genres?.length ? `<div class="chips">${m.genres.map(chip).join('')}</div>` : ''}
        <div class="actions">
          ${resume ? `<a class="btn primary" href="#/play/${i.id}">▶ Resume from ${fmtClock(i.progress.position)}</a>
            <a class="btn" href="#/play/${i.id}?t=0">Play from start</a>`
            : `<a class="btn primary" href="#/play/${i.id}?t=0">▶ Play</a>`}
          <button class="btn" data-watched>${i.progress?.watched ? 'Mark unwatched' : 'Mark watched'}</button>
          ${isMovie && isAdmin() ? '<button class="btn" data-fix>Fix match</button>' : ''}
        </div>
        ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ''}
        ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : ''}
        ${m.directors?.length ? `<p class="muted">Directed by ${esc(m.directors.join(', '))}</p>` : ''}
        ${i.next ? `<p class="muted">Next: <a href="#/item/${i.next.id}" style="color:var(--text)">${esc(epCode(i.next))} — ${esc(i.next.title)}</a></p>` : ''}
        ${i.copies.length ? `<div class="copies"><h3>Other copies</h3>${i.copies.map((c) => `<div class="copy">
            ${qualityTags(c)} <a href="#/item/${c.id}">${esc(c.fileName)}</a>
            <span class="muted">${esc([c.codec?.toUpperCase(), fmtSize(c.size)].filter(Boolean).join(' · '))} · <a class="muted" href="${folderLink(c)}">${esc([c.library, c.folder].filter(Boolean).join(' / '))}</a></span>
          </div>`).join('')}</div>` : ''}
        <details class="fileinfo"><summary>File info</summary>
          <dl class="specs">${specs.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
        </details>
      </div>
    </div>
    ${extrasSection(i.extras)}
    ${castRow(m.cast)}
  </div>`;

  view.querySelector('[data-watched]').onclick = async () => {
    await api(`/api/items/${i.id}/watched`, { method: 'POST', body: { watched: !i.progress?.watched } });
    item(id);
  };
  view.querySelector('[data-fix]')?.addEventListener('click', () => matchDialog({
    type: 'movie', query: i.localTitle, year: i.localYear,
    apply: async (tmdbId) => { await api(`/api/items/${i.id}/match`, { method: 'POST', body: { tmdbId } }); item(id); },
  }));
}

async function play(id, params) {
  const i = await api(`/api/items/${id}`);
  if (params.has('t')) i.startAt = Number(params.get('t'));
  document.body.classList.add('playing');
  const destroy = mountPlayer(view, i, {
    onBack: () => (history.length > 1 ? history.back() : (location.hash = `#/item/${id}`)),
    onPlayNext: (next) => location.replace(`#/play/${next.id}?t=0`),
  });
  return () => { destroy(); document.body.classList.remove('playing'); };
}

function watchLive(channelId) {
  document.body.classList.add('playing');
  const destroy = mountLive(view, channelId, { onBack: () => { location.hash = '#/live'; } });
  return () => { destroy(); document.body.classList.remove('playing'); };
}

async function search(params) {
  const q = params.get('q') || '';
  document.getElementById('search').value = q;
  const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
  const movies = data.items.filter((i) => i.kind === 'movie');
  const others = data.items.filter((i) => i.kind !== 'movie');
  view.innerHTML = `<h1>Results for “${esc(q)}”</h1>
    ${data.shows.length ? `<h2>Shows</h2><div class="grid posters">${data.shows.map(showCard).join('')}</div>` : ''}
    ${movies.length ? `<h2>Movies</h2><div class="grid posters">${movies.map((i) => itemCard(i, { poster: true })).join('')}</div>` : ''}
    ${others.length ? `<h2>Episodes, extras & videos</h2><div class="grid">${others.map((i) => itemCard(i)).join('')}</div>` : ''}
    ${!data.shows.length && !data.items.length ? '<div class="empty">No results.</div>' : ''}`;
}

// ---------- playback problems ----------
// Dropouts reported by players (and whether reconnecting fixed them), ffmpeg failures and server
// restarts, newest first (server/playlog.js).

const PROBLEM_LABEL = { error: 'Stream error', dropped: 'Stream dropped', stalled: 'Stream stalled' };
const OUTCOME_LABEL = { recovered: 'reconnected', failed: 'gave up', left: 'viewer left while reconnecting' };

function problemLine(p) {
  if (p.source === 'server') {
    return p.what === 'start' ? ['Server started', '', 'muted'] : ['Server stopped', p.message, 'warn'];
  }
  if (p.source === 'ffmpeg') return ['ffmpeg failed', p.message, 'bad'];
  const detail = [OUTCOME_LABEL[p.outcome] || p.outcome,
    p.attempts && `${p.attempts} attempt${p.attempts === 1 ? '' : 's'}`,
    p.downFor && `down ${fmtClock(p.downFor)}`, p.mode, p.message].filter(Boolean).join(' · ');
  return [PROBLEM_LABEL[p.what] || p.what, detail, p.outcome === 'recovered' ? 'warn' : 'bad'];
}

function problemsView(list) {
  const week = list.filter((p) => p.at > Date.now() - 7 * 864e5);
  const drops = week.filter((p) => p.source === 'player');
  const count = (f) => drops.filter(f).length;
  const summary = drops.length || week.some((p) => p.source === 'ffmpeg')
    ? `Last 7 days: <strong>${drops.length} dropout${drops.length === 1 ? '' : 's'}</strong> (${count((p) => p.outcome === 'recovered')} reconnected, ${count((p) => p.outcome === 'failed')} gave up), ${week.filter((p) => p.source === 'ffmpeg').length} ffmpeg failure(s), ${week.filter((p) => p.source === 'server' && p.what === 'start').length} server start(s).`
    : 'No dropouts in the last 7 days.';
  return `<p>${summary}</p>
    <p class="muted" style="font-size:13px">When a stream breaks (the server restarting, ffmpeg failing, the network), the player reconnects from where it was for about a minute. Each time is listed here with what happened, so dropouts can be matched to restarts or ffmpeg errors.</p>
    ${list.length ? `<div class="problems">${list.slice(0, 100).map((p) => {
      const [label, detail, tone] = problemLine(p);
      return `<div class="problem ${tone}"><span class="muted">${new Date(p.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
        <div><strong>${esc(label)}</strong>${p.title ? ` · ${esc(p.title)}` : ''}${p.position ? ` <span class="muted">at ${fmtClock(p.position)}</span>` : ''}${p.user ? ` <span class="muted">· ${esc(p.user)}</span>` : ''}
        ${detail ? `<div class="muted problem-detail">${esc(detail)}</div>` : ''}</div></div>`;
    }).join('')}</div>
    <p><button class="btn small" data-clear-problems>Clear log</button></p>` : ''}`;
}

async function settings() {
  // A plugin section that fails shows its error instead of breaking the page.
  const loadSection = (s) => Promise.resolve().then(() => s.load?.()).then((data) => ({ s, data }), (error) => ({ s, error }));
  const failed = (error) => `<p class="error">Couldn’t load this: ${esc(error.message)}</p>`;
  const renderSection = ({ s: sec, data, error }) => {
    if (error) return failed(error);
    try { return sec.render(data); } catch (err) { return failed(err); }
  };
  const [status, prefs, cat, dups, problems, miss, sections] = await Promise.all([api('/api/status'), api('/api/settings'), api('/api/catalog'), api('/api/duplicates'), api('/api/playback/problems'), api('/api/missing'), Promise.all(plugged.settings.map(loadSection)), loadLibraries()]);

  view.innerHTML = `<h1>Settings</h1>
    <div class="panel">
      <h2>Libraries</h2>
      <div data-libs></div>
    </div>
    <div class="panel">
      <h2>Add library</h2>
      <form class="form" data-add>
        <label>Name<input class="input" name="name" required placeholder="Media"></label>
        <label>Folder<span class="inline"><input class="input" name="path" required placeholder="${status.platform === 'win32' ? 'D:\\Media' : '/Volumes/Media'}"><button type="button" class="btn" data-browse>Browse…</button></span></label>
        <p class="muted" style="margin:0;font-size:13px">Movies and TV shows are detected automatically, so one folder can hold both.</p>
        <div><button class="btn primary">Add library</button> <span class="error" data-err></span></div>
      </form>
    </div>
    <div class="panel">
      <h2>Posters & metadata</h2>
      <p><span class="status-dot ${prefs.tmdbConfigured ? 'ok' : ''}"></span>TMDB ${prefs.tmdbConfigured
        ? `connected${prefs.tmdbFromEnv ? ' (key set by the TMDB_API_KEY environment variable)' : ''}`
        : 'not connected, so movies and shows will use frame grabs and file names'}</p>
      ${prefs.tmdbFromEnv ? '' : `<form class="form" data-tmdb>
        <label>TMDB API key or read access token
          <span class="inline"><input class="input" name="key" type="password" autocomplete="off" placeholder="${prefs.tmdbConfigured ? '•••••••• (saved; paste a new one to replace)' : 'Paste your key'}">
          <button class="btn primary">Save</button></span></label>
        <p class="muted" style="margin:0;font-size:13px">Free: create an account at themoviedb.org, then go to Settings → API to get a key. <span class="error" data-tmdb-err></span></p>
      </form>`}
      ${prefs.tmdbConfigured ? `<p style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-meta="">Match unmatched items</button>
        <button class="btn" data-meta="force">Refresh all metadata</button></p>` : ''}
      <p data-meta-status class="muted"></p>
      <p class="muted" style="font-size:12px">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
    <div class="panel">
      <h2>Catalog backup</h2>
      <p>A permanent list of every title Deadair has found: <strong>${cat.movies} movie${cat.movies === 1 ? '' : 's'}</strong> and <strong>${cat.shows} TV show${cat.shows === 1 ? '' : 's'}</strong>, with the seasons and episodes you have. If a drive fails, it's your list of what to re-rip.</p>
      <p class="muted">Titles stay on it when their files disappear, marked as missing. It's kept on this server and backed up to D1 with the rest of your data. Download a copy to keep somewhere else too.</p>
      <p style="display:flex;gap:8px;flex-wrap:wrap">
        <a class="btn" href="/api/catalog/export?format=csv" download>Download spreadsheet (CSV)</a>
        <a class="btn" href="/api/catalog/export?format=txt" download>Download printable list</a>
      </p>
      ${cat.missing.length ? `<details class="catalog-missing"><summary class="error">${cat.missing.length} title${cat.missing.length === 1 ? '' : 's'} missing from disk</summary>
        <ul>${cat.missing.map((m) => `<li>${esc(m.title)}${m.year ? ` (${m.year})` : ''} <span class="muted">· ${m.kind === 'show' ? 'TV show' : 'movie'} · missing since ${new Date(m.missingSince).toLocaleDateString()}</span></li>`).join('')}</ul>
      </details>` : '<p class="muted">Everything on the list is on disk.</p>'}
    </div>
    ${sections.map(({ s: sec, data, error }, i) => `<div class="panel" data-plugin-panel="${i}">
      <h2>${esc(sec.title)}</h2>
      ${renderSection({ s: sec, data, error })}
    </div>`).join('')}
    <div class="panel">
      <h2>Missing episodes</h2>
      <p>${miss.totals.shows
        ? `<strong>${miss.totals.episodes} aired episode${miss.totals.episodes === 1 ? '' : 's'}</strong> missing across ${miss.totals.shows} show${miss.totals.shows === 1 ? '' : 's'}: ${miss.totals.gapShows} with gaps in seasons you have, ${miss.totals.wholeShows} with whole seasons you don't have. ${miss.totals.complete} complete.`
        : prefs.tmdbConfigured ? `Every show is complete${miss.totals.complete ? ` (${miss.totals.complete})` : ''}.` : 'Connect TMDB above to check shows for missing episodes.'}</p>
      ${miss.totals.shows || miss.unchecked.length ? '<p><a class="btn" href="#/missing">View missing episodes</a></p>' : ''}
    </div>
    <div class="panel">
      <h2>Duplicates</h2>
      <p>${dups.totals.titles
        ? `<strong>${dups.totals.titles} title${dups.totals.titles === 1 ? '' : 's'}</strong> ${dups.totals.titles === 1 ? 'has' : 'have'} more than one file: ${dups.totals.quality} in different qualities (like 4K + 1080p), ${dups.totals.same} the same quality twice. About ${fmtSize(dups.totals.extraBytes)} beyond the best copy of each.`
        : 'No duplicates: every movie and episode has exactly one file.'}</p>
      ${dups.totals.titles ? '<p><a class="btn" href="#/duplicates">View duplicates</a></p>' : ''}
    </div>
    <div class="panel">
      <h2>Playback problems</h2>
      <div data-problems>${problemsView(problems)}</div>
    </div>
    <div class="panel">
      <h2>Server</h2>
      <p><span class="status-dot ${status.ffmpeg ? 'ok' : ''}"></span>ffmpeg ${status.ffmpeg ? 'found' : 'not found, so only MP4/WebM files with browser-friendly codecs will play'}</p>
      <p><span class="status-dot ${status.ffprobe ? 'ok' : ''}"></span>ffprobe ${status.ffprobe ? 'found' : 'not found, so durations and codec info are unavailable'}</p>
      ${status.version?.commit ? `<p class="muted">Running <a href="${status.version.repo ? `https://github.com/${esc(status.version.repo)}/commit/${esc(status.version.commit)}` : '#'}" target="_blank" rel="noopener noreferrer"><code>${esc(status.version.commit)}</code></a>${status.version.date ? ` from ${new Date(status.version.date).toLocaleDateString()}` : ''}${status.deploy?.lastError ? ` · <span class="error">last update (${esc(status.deploy.lastError.commit)}) was rolled back: ${esc(status.deploy.lastError.message)}</span>` : ''}</p>` : ''}
      ${status.plugins?.length ? `<p>Plugins: ${status.plugins.map((p) => (p.error ? `<span class="error">${esc(p.name)} (off: ${esc(p.error)})</span>` : esc(p.name))).join(', ')}</p>` : ''}
      <p data-sync-status></p>
      <p data-scan-status class="muted"></p>
      <button class="btn" data-scan-all>Scan all libraries</button>
    </div>
    <dialog data-fb><div class="fb-head"></div><div class="fb-list"></div>
      <div class="fb-foot"><button class="btn" data-fb-cancel>Cancel</button><button class="btn primary" data-fb-ok>Choose this folder</button></div></dialog>`;

  const form = view.querySelector('[data-add]');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    try {
      await api('/api/libraries', { method: 'POST', body });
      settings();
    } catch (err) {
      view.querySelector('[data-err]').textContent = err.message;
    }
  };

  view.querySelector('[data-problems]').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-clear-problems]') || !confirm('Clear the playback problem log?')) return;
    await api('/api/playback/problems', { method: 'DELETE' });
    view.querySelector('[data-problems]').innerHTML = problemsView([]);
  });
  sections.forEach(({ s: sec, data, error }, i) => {
    const panel = view.querySelector(`[data-plugin-panel="${i}"]`);
    try { if (!error) sec.bind?.(panel, data); } catch (err) { panel.insertAdjacentHTML('beforeend', failed(err)); }
  });
  const tmdbForm = view.querySelector('[data-tmdb]');
  if (tmdbForm) {
    tmdbForm.onsubmit = async (e) => {
      e.preventDefault();
      const errEl = view.querySelector('[data-tmdb-err]');
      errEl.textContent = '';
      const btn = tmdbForm.querySelector('button');
      btn.disabled = true;
      try {
        await api('/api/settings', { method: 'PUT', body: { tmdbKey: tmdbForm.key.value } });
        settings();
      } catch (err) {
        errEl.textContent = err.message;
        btn.disabled = false;
      }
    };
  }
  view.querySelectorAll('[data-meta]').forEach((b) => (b.onclick = async () => {
    await api('/api/metadata/refresh', { method: 'POST', body: { force: b.dataset.meta === 'force' } });
    poll();
  }));

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const libraryCounts = (l) => (l.count ? [l.movies && plural(l.movies, 'movie'), l.shows && plural(l.shows, 'show')].filter(Boolean).join(' · ') : 'no videos yet');

  // Library rows re-render as scans finish so file counts stay current.
  let scanState = null;
  function renderLibs() {
    const el = view.querySelector('[data-libs]');
    if (!el) return;
    const busy = scanState?.running;
    el.innerHTML = libraries.length ? libraries.map((l) => {
      const scanning = busy && scanState.libraryId === l.id;
      const queued = busy && !scanning && scanState.queued?.includes(l.id);
      const state = scanning
        ? `Scanning… ${scanState.found ? `${scanState.found} videos found` : 'looking for videos'}${scanState.total ? `, ${scanState.done}/${scanState.total} analyzed` : ''}`
        : queued ? 'Waiting to scan…' : l.missing ? 'folder not found on this machine' : libraryCounts(l);
      return `<div class="lib-row">
        <div class="grow"><strong>${esc(l.name)}</strong> <span class="muted">· <span class="${scanning ? 'scanning' : l.missing ? 'error' : ''}">${state}</span></span>
          <div class="path">${esc(l.path)}</div></div>
        <button class="btn small ${l.missing ? 'primary' : ''}" data-move="${l.id}">Change folder</button>
        <button class="btn small" data-scan="${l.id}" ${scanning || queued || l.missing ? 'disabled' : ''}>${scanning ? 'Scanning…' : 'Scan'}</button>
        <button class="btn small danger" data-del="${l.id}">Remove</button>
      </div>`;
    }).join('') : '<p class="muted">No libraries yet.</p>';
    el.querySelectorAll('[data-scan]').forEach((b) => (b.onclick = () => startScan(b.dataset.scan)));
    el.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => {
      const lib = libraries.find((l) => l.id === b.dataset.move);
      // Same library, new location: watch history and matches stay as they are.
      pickFolder(lib.missing ? '' : lib.path, async (picked) => {
        try {
          await api(`/api/libraries/${lib.id}`, { method: 'PATCH', body: { path: picked } });
          await loadLibraries();
          startScan(lib.id);
        } catch (err) {
          alert(err.message);
        }
      });
    }));
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const lib = libraries.find((l) => l.id === b.dataset.del);
      if (!confirm(`Remove "${lib.name}"? Your files and watch history are kept; only the library is removed from Deadair.`)) return;
      await api(`/api/libraries/${lib.id}`, { method: 'DELETE' });
      settings();
    }));
  }
  async function startScan(libraryId) {
    scanState = await api('/api/scan', { method: 'POST', body: libraryId ? { libraryId } : {} });
    renderLibs();
    poll();
  }
  view.querySelector('[data-scan-all]').onclick = () => startScan('');
  renderLibs();

  // Folder browser
  const dlg = view.querySelector('[data-fb]');
  let current = null;
  async function browse(p) {
    try {
      const data = await api(`/api/fs${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      current = data.path;
      dlg.querySelector('.fb-head').textContent = data.path || 'Choose a drive or folder';
      dlg.querySelector('[data-fb-ok]').disabled = !data.path;
      const list = dlg.querySelector('.fb-list');
      list.innerHTML = (data.parent != null ? `<button data-p="${esc(data.parent)}">⬑ ..</button>` : '') +
        data.dirs.map((d) => `<button data-p="${esc(d.path)}">📁 ${esc(d.name)}</button>`).join('');
      list.querySelectorAll('button').forEach((b) => (b.onclick = () => browse(b.dataset.p)));
    } catch (err) {
      alert(err.message);
    }
  }
  let onPick = null;
  function pickFolder(start, then) {
    onPick = then;
    browse(start || '');
    dlg.showModal();
  }
  dlg.querySelector('[data-fb-cancel]').onclick = () => dlg.close();
  dlg.querySelector('[data-fb-ok]').onclick = () => {
    dlg.close();
    onPick?.(current);
  };
  view.querySelector('[data-browse]').onclick = () => pickFolder(form.path.value.trim(), (picked) => {
    form.path.value = picked;
    if (!form.name.value || form.name.dataset.auto === form.name.value) {
      form.name.value = form.name.dataset.auto = picked.split(/[\\/]/).filter(Boolean).pop() || '';
    }
  });

  let pollTimer;
  async function poll() {
    clearTimeout(pollTimer);
    const scanEl = view.querySelector('[data-scan-status]');
    if (!scanEl) return;
    const { scan: s, metadata: md, sync } = await api('/api/status');
    const syncEl = view.querySelector('[data-sync-status]');
    const syncText = !sync.enabled ? 'off: data is only on this server (see the README to keep it in D1)'
      : sync.state === 'error' ? `can't reach D1, retrying${sync.pending ? ` (${sync.pending} changes waiting)` : ''}: ${sync.error}`
      : sync.pending ? `saving ${sync.pending} changes…`
      : sync.lastSync ? `up to date · last saved ${new Date(sync.lastSync).toLocaleString()}` : 'up to date';
    syncEl.innerHTML = `<span class="status-dot ${sync.enabled && sync.state !== 'error' ? 'ok' : ''}"></span>Cloud copy (D1): `;
    syncEl.append(syncText, sync.note ? ` · ${sync.note}` : '');
    const finished = scanState?.running && !s.running;
    scanState = s;
    if (finished) await loadLibraries();
    renderLibs();
    scanEl.textContent = s.running
      ? `Scanning ${s.library || ''}… ${s.done}/${s.total} files analyzed`
      : s.lastScan ? `Last scan: ${new Date(s.lastScan).toLocaleString()}` : '';
    const metaEl = view.querySelector('[data-meta-status]');
    metaEl.textContent = md.running
      ? `Fetching metadata… ${md.done}/${md.total}`
      : md.error || (md.lastRun ? `Last metadata update: ${new Date(md.lastRun).toLocaleString()}` : '');
    metaEl.classList.toggle('error', !!md.error);
    if (s.running || md.running || sync.pending) pollTimer = setTimeout(poll, 1000);
  }
  poll();
  return () => clearTimeout(pollTimer);
}

const fmtSpeed = (bps) => (bps ? `${fmtSize(bps)}/s` : '');

// ---------- duplicates ----------

// Every title with more than one file, wherever the files are, so you can see 4K-and-1080p pairs
// and plain repeats. Nothing is deleted from here: it shows where each copy lives.
async function duplicatesPage(q) {
  const data = await api('/api/duplicates');
  let show = q?.get('show') || 'all';
  const fmtRate = (bps) => (bps ? `${(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)} Mb/s` : '');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const fileLine = (f) => `<div class="dup-file ${f.best ? 'best' : ''}">
      <div class="dup-tags">${qualityTags(f) || '<span class="q">?</span>'}${f.best ? '<span class="q q-best">Best</span>' : ''}${f.identical ? '<span class="q q-same" title="Exactly the same size as another copy, almost certainly the same file twice">Identical</span>' : ''}</div>
      <div class="dup-where">
        <a href="#/item/${f.id}" class="dup-name">${esc(f.fileName)}</a>
        <a href="${folderLink(f)}" class="muted dup-path">${FOLDER_ICON} ${esc([f.library, f.folder].filter(Boolean).join(' / '))}</a>
      </div>
      <div class="muted dup-specs">${esc([f.codec?.toUpperCase(), f.width && `${f.width}×${f.height}`, fmtRate(f.bitrate), fmtSize(f.size)].filter(Boolean).join(' · '))}</div>
    </div>`;
  const kindTag = (g) => `<span class="q ${g.type === 'quality' ? 'q-mixed' : 'q-same'}">${g.type === 'quality' ? esc(g.qualities.join(' + ')) : `Same quality${g.qualities.length === 1 ? ` (${esc(g.qualities[0])})` : ''}`}</span>`;
  const movieGroup = (m) => `<div class="dup-group">
      <div class="dup-head"><strong>${esc(m.title)}</strong>${m.year ? ` <span class="muted">(${m.year})</span>` : ''} ${kindTag(m)}
        <span class="muted dup-extra">${m.files.length} copies · ${fmtSize(m.extraBytes) || '0 B'} beyond the best</span></div>
      ${m.files.map(fileLine).join('')}
    </div>`;
  const showGroup = (s) => {
    const eps = s.episodes.filter((e) => show === 'all' || e.type === show);
    return `<details class="dup-group dup-show">
      <summary class="dup-head"><strong>${esc(s.title)}</strong>${s.year ? ` <span class="muted">(${s.year})</span>` : ''} ${kindTag(s)}
        <span class="muted dup-extra">${plural(eps.length, 'episode')} with more than one copy · ${fmtSize(eps.reduce((n, e) => n + e.extraBytes, 0)) || '0 B'} beyond the best</span></summary>
      ${eps.map((e) => `<div class="dup-ep"><div class="dup-ep-title">${esc(epCode(e))}${e.title ? ` · ${esc(e.title)}` : ''} ${kindTag(e)}</div>${e.files.map(fileLine).join('')}</div>`).join('')}
    </details>`;
  };

  function render() {
    const keep = (g) => show === 'all' || g.type === show || (g.episodes || []).some((e) => e.type === show);
    const movies = data.movies.filter(keep);
    const shows = data.shows.filter(keep);
    const t = data.totals;
    view.innerHTML = `<div class="page dup-page">
      <h1>Duplicates</h1>
      <p class="muted">${t.titles ? `${plural(t.titles, 'title')} ${t.titles === 1 ? 'has' : 'have'} more than one file (${t.files} files). Keeping only the best copy of each would free about <strong>${fmtSize(t.extraBytes)}</strong>.` : 'No duplicates: every movie and episode has exactly one file.'}
        Copies are matched by title, so they count even in different folders or libraries. Nothing is deleted here. Open a folder to see where a copy lives.</p>
      ${t.titles ? `<div class="tabs" role="tablist">
        ${[['all', 'All', t.titles], ['quality', 'Different quality', t.quality], ['same', 'Same quality', t.same]].map(([k, label, n]) =>
          `<button role="tab" data-show="${k}" aria-selected="${show === k}">${label} <span class="muted">${n}</span></button>`).join('')}
      </div>` : ''}
      ${movies.length ? `<h2>Movies <span class="muted">${movies.length}</span></h2>${movies.map(movieGroup).join('')}` : ''}
      ${shows.length ? `<h2>TV shows <span class="muted">${shows.length}</span></h2>${shows.map(showGroup).join('')}` : ''}
      ${t.titles && !movies.length && !shows.length ? '<div class="empty">None of this kind.</div>' : ''}
    </div>`;
    view.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { show = b.dataset.show; render(); }));
  }
  render();
}

// ---------- missing episodes ----------

// Aired episodes TMDB lists that aren't in any library, so you know what to get to finish a show.
// "Gaps" are holes in seasons you have some of; "whole seasons" are ones you have none of.
async function missingPage(q) {
  let data = await api('/api/missing');
  let filter = q?.get('show') || pref('missing:filter', 'all');
  let sort = pref('missing:sort', 'title');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const date = (d) => new Date(`${d}T12:00`).toLocaleDateString();
  const showHref = (s) => `#/show/${s.libraryId}/${encodeURIComponent(s.showKey)}`;
  const SORTS = {
    title: () => 0,
    closest: (a, b) => a.missingCount - b.missingCount,
    most: (a, b) => b.missingCount - a.missingCount,
  };

  const seasonLine = (se) => `<div class="miss-season">
      <div class="miss-season-head"><strong>Season ${se.season}</strong> <span class="muted">${se.whole
        ? `all ${plural(se.aired, 'episode')}` : `missing ${se.missing.length} of ${se.aired}`}</span></div>
      ${se.whole ? '' : `<ul class="miss-eps">${se.missing.map((e) => `<li><span class="miss-num">${e.episode}.</span> ${esc(e.name || `Episode ${e.episode}`)}${e.airDate ? ` <span class="muted">· ${date(e.airDate)}</span>` : ''}</li>`).join('')}</ul>`}
    </div>`;
  const showGroup = (s) => {
    const pct = s.total ? Math.round((s.have / s.total) * 100) : 0;
    const status = s.status === 'Ended' || s.status === 'Canceled' ? s.status
      : s.nextAir?.airDate ? `Next: S${s.nextAir.season}E${s.nextAir.episode} on ${date(s.nextAir.airDate)}` : s.status;
    const seasons = s.seasons.filter((se) => filter === 'all' || (filter === 'gaps') !== se.whole);
    return `<details class="dup-group dup-show miss-show" ${filter === 'gaps' || data.shows.length <= 5 ? 'open' : ''}>
      <summary class="dup-head">
        <a href="${showHref(s)}"><strong>${esc(s.title)}</strong></a>${s.year ? ` <span class="muted">(${s.year})</span>` : ''}
        ${status ? `<span class="q">${esc(status)}</span>` : ''}
        <span class="miss-progress" title="${s.have} of ${s.total} aired episodes"><span style="width:${pct}%"></span></span>
        <span class="muted dup-extra">${s.have} of ${s.total} · ${s.missingCount} missing</span>
      </summary>
      ${s.unknown ? `<p class="muted miss-warn">${plural(s.unknown, 'file')} ${s.unknown === 1 ? 'is' : 'are'} numbered differently from TMDB (often anime or DVD order), so this list may be off. Try Fix match on the show.</p>` : ''}
      ${seasons.map(seasonLine).join('')}
      <p class="miss-actions"><button class="btn small" data-ignore="${esc(s.showKey)}">Don't track this show</button></p>
    </details>`;
  };

  function render() {
    const t = data.totals;
    const shows = data.shows
      .filter((s) => filter === 'all' || (filter === 'gaps' ? s.gapCount : s.wholeSeasons))
      .sort((a, b) => SORTS[sort](a, b) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
    view.innerHTML = `<div class="page dup-page miss-page">
      <div class="toolbar">
        <h1>Missing episodes</h1>
        <span class="spacer"></span>
        ${t.shows ? '<a class="btn" href="/api/missing/export" download>Download list</a>' : ''}
      </div>
      <p class="muted">${t.shows
        ? `${plural(t.episodes, 'aired episode')} missing across ${plural(t.shows, 'show')}. ${t.complete} ${t.complete === 1 ? 'show is' : 'shows are'} complete.`
        : `No missing episodes${t.complete ? `: all ${plural(t.complete, 'show')} are complete` : ''}.`}
        Compared with TMDB, counting files in every library. Specials and episodes that haven't aired yet aren't counted.</p>
      ${t.shows ? `<div class="miss-controls">
        <div class="tabs" role="tablist">
          ${[['all', 'All', t.shows], ['gaps', 'Gaps in seasons you have', t.gapShows], ['whole', 'Whole seasons', t.wholeShows]].map(([k, label, n]) =>
            `<button role="tab" data-filter="${k}" aria-selected="${filter === k}">${label} <span class="muted">${n}</span></button>`).join('')}
        </div>
        <label class="muted">Sort <select class="input" data-sort>
          ${[['title', 'Title'], ['closest', 'Closest to complete'], ['most', 'Most missing']].map(([k, label]) => `<option value="${k}" ${sort === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
      </div>` : ''}
      ${shows.map(showGroup).join('')}
      ${t.shows && !shows.length ? '<div class="empty">None of this kind.</div>' : ''}
      ${data.unchecked.length ? `<details class="catalog-missing miss-other"><summary>${plural(data.unchecked.length, 'show')} couldn't be checked</summary>
        <ul>${data.unchecked.map((s) => `<li><a href="${showHref(s)}">${esc(s.title)}</a>${s.year ? ` (${s.year})` : ''} <span class="muted">· ${esc(s.reason)}</span></li>`).join('')}</ul>
        <p class="muted" style="font-size:13px">Unmatched shows need Fix match on their page. "Not checked yet" ones are picked up by the next metadata refresh.</p>
      </details>` : ''}
      ${data.ignored.length ? `<details class="catalog-missing miss-other"><summary>${plural(data.ignored.length, 'show')} not tracked</summary>
        <ul>${data.ignored.map((s) => `<li><a href="${showHref(s)}">${esc(s.title)}</a>${s.year ? ` (${s.year})` : ''} <button class="btn small" data-unignore="${esc(s.showKey)}">Track again</button></li>`).join('')}</ul>
      </details>` : ''}
    </div>`;
    view.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => { filter = b.dataset.filter; setPref('missing:filter', filter); render(); }));
    view.querySelector('[data-sort]')?.addEventListener('change', (e) => { sort = e.target.value; setPref('missing:sort', sort); render(); });
    const toggle = async (showKey, ignored) => {
      await api('/api/missing/ignore', { method: 'POST', body: { showKey, ignored } });
      data = await api('/api/missing');
      render();
    };
    view.querySelectorAll('[data-ignore]').forEach((b) => (b.onclick = () => toggle(b.dataset.ignore, true)));
    view.querySelectorAll('[data-unignore]').forEach((b) => (b.onclick = () => toggle(b.dataset.unignore, false)));
  }
  render();
}

// ---------- improvement notes ----------

// A shared list of ideas and bugs, written while using Deadair.

async function notesPage() {
  let list = await api('/api/notes');
  let showDone = pref('notes:showDone', '0') === '1';
  const when = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  view.innerHTML = `<div class="notes-page">
    <div class="toolbar">
      <h1>Notes</h1>
      <span class="spacer"></span>
      <button class="btn" data-copy title="Copy every open note as a plain-text list">Copy list</button>
    </div>
    <p class="muted notes-intro">Ideas, bugs and wishes for Deadair. Everyone signed in can add to this list and tick things off.</p>
    <form class="note-new" data-new>
      <textarea class="input" name="text" rows="3" maxlength="5000" placeholder="What should be better? (⌘/Ctrl + Enter to add)" required></textarea>
      <div class="note-new-actions"><span class="error" data-err></span><button class="btn primary">Add note</button></div>
    </form>
    <div class="notes-filter">
      <label><input type="checkbox" data-show-done ${showDone ? 'checked' : ''}> Show done</label>
      <span class="muted" data-count></span>
    </div>
    <div class="notes-list" data-list></div>
  </div>`;

  const listEl = view.querySelector('[data-list]');
  const form = view.querySelector('[data-new]');

  function render() {
    const open = list.filter((n) => !n.done);
    const shown = showDone ? list : open;
    view.querySelector('[data-count]').textContent = `${open.length} open · ${list.length - open.length} done`;
    listEl.innerHTML = shown.length ? shown.map((n) => `<div class="note ${n.done ? 'done' : ''}" data-id="${esc(n.id)}">
        <input type="checkbox" class="note-check" data-done ${n.done ? 'checked' : ''} aria-label="Mark done">
        <div class="note-body">
          <div class="note-text">${esc(n.text)}</div>
          <div class="muted note-meta">${esc(n.author)} · ${when(n.createdAt)}${n.editedAt ? ' · edited' : ''}${n.done ? ` · done${n.doneBy ? ` by ${esc(n.doneBy)}` : ''}` : ''}${!n.done && n.working ? ' · <span class="note-working">being worked on</span>' : ''}</div>
          ${n.resolution ? `<div class="note-resolution">${esc(n.resolution)}${n.commit ? ` <a href="${esc(n.commitUrl || '#')}" target="_blank" rel="noopener noreferrer"><code>${esc(n.commit.slice(0, 7))}</code></a>` : ''}</div>` : ''}
        </div>
        ${n.canEdit ? `<div class="note-actions"><button class="btn small" data-edit>Edit</button><button class="btn small danger" data-del>Delete</button></div>` : ''}
      </div>`).join('')
      : `<div class="empty">${list.length ? 'Nothing open. Tick “Show done” to see finished notes.' : 'No notes yet. Add the first one above.'}</div>`;

    listEl.querySelectorAll('.note').forEach((row) => {
      const note = list.find((n) => n.id === row.dataset.id);
      row.querySelector('[data-done]').onchange = async (e) => {
        Object.assign(note, await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { done: e.target.checked } }));
        render();
      };
      row.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm('Delete this note?')) return;
        await api(`/api/notes/${note.id}`, { method: 'DELETE' });
        list = list.filter((n) => n.id !== note.id);
        render();
      });
      row.querySelector('[data-edit]')?.addEventListener('click', () => {
        const body = row.querySelector('.note-body');
        body.innerHTML = `<textarea class="input note-edit" rows="3" maxlength="5000">${esc(note.text)}</textarea>
          <div class="note-new-actions"><button class="btn small" data-cancel>Cancel</button><button class="btn small primary" data-save>Save</button></div>`;
        const ta = body.querySelector('textarea');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        body.querySelector('[data-cancel]').onclick = render;
        const save = async () => {
          try {
            Object.assign(note, await api(`/api/notes/${note.id}`, { method: 'PATCH', body: { text: ta.value } }));
            render();
          } catch (err) {
            alert(err.message);
          }
        };
        body.querySelector('[data-save]').onclick = save;
        ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); };
      });
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = view.querySelector('[data-err]');
    errEl.textContent = '';
    try {
      list.unshift(await api('/api/notes', { method: 'POST', body: { text: form.text.value } }));
      form.reset();
      render();
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  form.text.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit(); };

  view.querySelector('[data-show-done]').onchange = (e) => {
    showDone = e.target.checked;
    setPref('notes:showDone', showDone ? '1' : '0');
    render();
  };

  // Every open note as a plain list, oldest first, ready to paste into a chat.
  view.querySelector('[data-copy]').onclick = async (e) => {
    const open = list.filter((n) => !n.done).reverse();
    if (!open.length) return alert('No open notes to copy.');
    const text = `Deadair improvement notes (${open.length} open):\n\n`
      + open.map((n) => `- [${n.author}, ${new Date(n.createdAt).toLocaleDateString('en-CA')}] ${n.text.replace(/\n/g, '\n  ')}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied ✓';
      setTimeout(() => { e.target.textContent = 'Copy list'; }, 2000);
    } catch {
      // No clipboard access (e.g. plain http on another device): show it for manual copying.
      prompt('Copy these notes:', text);
    }
  };

  render();
}

// ---------- plugins ----------
// Optional features installed on the server (plugins/<name>, see README → Plugins). Each one's
// public/client.js default export is called with this API, so it can add pages, links in the
// nav and a section in Settings. Its public/style.css is loaded too.

const plugged = { nav: [], routes: [], settings: [] };

// A page's heading. (The first argument is a label the plugin API has always taken; unused here.)
const pageTitle = (label, title, cls = '') => `<h1${cls ? ` class="${esc(cls)}"` : ''}>${esc(title)}</h1>`;

const pluginApi = {
  view, api, esc, fmtSize, fmtClock, fmtDuration, fmtSpeed, pageTitle, pref, setPref, mountPlayer,
  isAdmin: () => isAdmin(),
  user: () => currentUser,
  libraries: () => libraries,
  // A link in the nav: group 'Watch' or 'Backstage' (both go after Live TV). Active while the
  // page's hash starts with href.
  nav: ({ group, href, label }) => plugged.nav.push({ group, href, label }),
  // A page: `re` is matched against the hash path (like '/notes'); fn(match, query) renders into
  // view and may return a cleanup function.
  route: (re, fn) => plugged.routes.push([re, fn]),
  // A Settings section (admins only): load() fetches its data, render(data) returns its HTML,
  // bind(panel, data) wires it up.
  settings: (section) => plugged.settings.push(section),
  // Full-screen player for `item` (see player.js); returns the cleanup for the route.
  play(item, { onBack }) {
    document.body.classList.add('playing');
    const destroy = mountPlayer(view, item, { onBack, onPlayNext: () => {} });
    return () => { destroy(); document.body.classList.remove('playing'); };
  },
};

async function loadPlugin(p) {
  if (p.style) document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="/plugins/${encodeURIComponent(p.name)}/style.css">`);
  if (!p.client) return;
  try {
    const mod = await import(`/plugins/${encodeURIComponent(p.name)}/client.js`);
    mod.default?.(pluginApi);
  } catch (err) {
    console.error(`Plugin ${p.name} didn’t load:`, err);
  }
}

// Once per page load, so signing in again doesn't add them twice. If the list can't be fetched
// (signed out, server restarting), the next sign-in tries again.
let pluginsLoaded = null;
function loadPlugins() {
  return (pluginsLoaded ||= api('/api/plugins').then((list) => Promise.all(list.map(loadPlugin)), () => { pluginsLoaded = null; }));
}

// ---------- router ----------

const routes = [
  [/^\/$/, () => home()],
  [/^\/library\/([^/]+)$/, (m, q) => library(m[1], q)],
  [/^\/show\/([^/]+)\/([^/]+)$/, (m, q) => show(m[1], decodeURIComponent(m[2]), q)],
  [/^\/item\/([^/]+)$/, (m) => item(m[1])],
  [/^\/play\/([^/]+)$/, (m, q) => play(m[1], q)],
  [/^\/search$/, (m, q) => search(q)],
  [/^\/live$/, () => guidePage(view, { admin: isAdmin() })],
  [/^\/live\/watch\/([^/]+)$/, (m) => watchLive(decodeURIComponent(m[1]))],
  [/^\/live\/setup$/, () => (isAdmin() ? setupPage(view) : (view.innerHTML = '<div class="empty">Only an admin can set up channels.</div>'))],
  [/^\/notes$/, () => notesPage()],
  [/^\/missing$/, (m, q) => (isAdmin() ? missingPage(q) : (view.innerHTML = '<div class="empty">Only an admin can see missing episodes.</div>'))],
  [/^\/duplicates$/, (m, q) => (isAdmin() ? duplicatesPage(q) : (view.innerHTML = '<div class="empty">Only an admin can see duplicates.</div>'))],
  [/^\/settings$/, () => (isAdmin() ? settings() : (view.innerHTML = '<div class="empty">Only an admin can change settings.</div>'))],
];

async function router() {
  cleanup?.();
  cleanup = null;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  renderNav();
  window.scrollTo(0, 0);
  for (const [re, fn] of [...routes, ...plugged.routes]) {
    const m = path.match(re);
    if (!m) continue;
    try {
      const result = await fn(m, new URLSearchParams(qs));
      if (typeof result === 'function') cleanup = result;
    } catch (err) {
      // A 401 has already swapped in the login screen; don't paint over it.
      if (err.status !== 401) view.innerHTML = `<div class="empty error">${esc(err.message)}</div>`;
    }
    return;
  }
  view.innerHTML = '<div class="empty">Page not found.</div>';
}

document.getElementById('search-form').onsubmit = (e) => {
  e.preventDefault();
  const q = document.getElementById('search').value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
};

// ---------- auth ----------

let currentUser = null;

const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function renderLogin(message = '') {
  cleanup?.();
  cleanup = null;
  currentUser = null;
  document.body.classList.remove('playing');
  document.body.classList.add('signed-out');
  view.innerHTML = `<div class="login">
    <form class="login-card" data-login>
      <div class="logo login-logo"><span class="logo-mark">▶</span>Deadair</div>
      <p class="muted" style="margin:0 0 18px">Sign in with your account.</p>
      <label>Username<input class="input" name="username" autocomplete="username" autocapitalize="none" required autofocus></label>
      <label>Password<span class="pw-field">
        <input class="input" name="password" type="password" autocomplete="current-password" required>
        <button type="button" class="pw-toggle" data-pw-toggle aria-label="Show password" aria-pressed="false" title="Show password">${EYE}</button>
      </span></label>
      <button class="btn primary">Sign in</button>
      <p class="error" data-login-err>${esc(message)}</p>
    </form>
  </div>`;
  const form = view.querySelector('[data-login]');
  const toggle = form.querySelector('[data-pw-toggle]');
  toggle.onclick = () => {
    const show = form.password.type === 'password';
    form.password.type = show ? 'text' : 'password';
    toggle.innerHTML = show ? EYE_OFF : EYE;
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.title = toggle.getAttribute('aria-label');
    form.password.focus();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const errEl = form.querySelector('[data-login-err]');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      await api('/api/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      await start();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      form.password.select();
    }
  };
}

function renderUser() {
  const btn = document.getElementById('user-btn');
  btn.textContent = initial(currentUser.username);
  btn.title = currentUser.username;
  document.getElementById('user-name').textContent = `Signed in as ${currentUser.username}`;
  document.getElementById('logout-btn').hidden = !!currentUser.authDisabled;
  document.querySelector('.topbar .icon-link[href="#/settings"]').hidden = !currentUser.admin;
}

const userPop = document.getElementById('user-pop');
document.getElementById('user-btn').onclick = (e) => {
  e.stopPropagation();
  userPop.hidden = !userPop.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!userPop.hidden));
};
document.addEventListener('click', (e) => { if (!userPop.contains(e.target)) userPop.hidden = true; });
document.getElementById('logout-btn').onclick = async () => {
  userPop.hidden = true;
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  renderLogin();
};

// Any API call that comes back 401 (e.g. session expired) drops to the login screen.
window.addEventListener('unauthorized', () => { if (currentUser) renderLogin('Your session expired. Please sign in again.'); });

async function start() {
  try {
    currentUser = await api('/api/auth/me');
  } catch (err) {
    if (err.status === 401) {
      return renderLogin(err.body?.configured === false ? 'Login is not configured on the server yet (see README).' : '');
    }
    view.innerHTML = `<div class="empty error">${esc(err.message)}</div>`;
    return;
  }
  document.body.classList.remove('signed-out');
  renderUser();
  await Promise.all([loadLibraries().catch(() => {}), loadPlugins()]);
  router();
}

window.addEventListener('hashchange', () => { if (currentUser) router(); });
start();
