import { api, esc, fmtDuration, tmdbImg } from './util.js';

// Live TV: the guide, the live player and channel setup.

const HALF_HOUR = 30 * 60 * 1000;
const PX_PER_MIN = 8;
const GUIDE_HOURS = 12;

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const span = (p) => `${clock(p.start)} – ${clock(p.stop)}`;
// Logos and guide images come from outside lists: only ever load them as plain web images.
const safeUrl = (u) => (u && /^(https?:\/\/|\/api\/)/i.test(u) ? u : null);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function pref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// "S2 · E5 · Title" for library episodes, the guide's own episode text otherwise.
function subline(p) {
  if (p.episode != null) return [`S${p.season} · E${p.episode}`, p.subtitle].filter(Boolean).join(' · ');
  return [p.episodeCode, p.subtitle, p.movie && p.year].filter(Boolean).join(' · ');
}

// Best picture for a program: TMDB art, a frame from the file, or the guide's image.
function programImage(p, size = 'w500') {
  if (p.image && p.image.startsWith('/') && p.itemId) return tmdbImg(p.image, size);
  if (p.poster && p.itemId) return tmdbImg(p.poster, 'w342');
  if (p.itemId) return `/api/items/${p.itemId}/thumb`;
  return safeUrl(p.image);
}

// Dialogs sit on <body>, outside the page, so they're closed when the page changes (e.g. Back).
function attachDialog(dlg) {
  const onNav = () => dlg.close();
  document.body.append(dlg);
  window.addEventListener('hashchange', onNav);
  dlg.addEventListener('close', () => {
    window.removeEventListener('hashchange', onNav);
    dlg.remove();
  });
}

function channelBadge(c) {
  const logo = safeUrl(c.logo);
  return `<span class="ch-num">${esc(c.number)}</span>${logo
    ? `<img class="ch-logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<span class="ch-name">${esc(c.name)}</span>`;
}

// ---------- guide ----------

export async function guidePage(view, { admin }) {
  let from = Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR;
  let data = await api(`/api/live/guide?from=${from}&to=${from + GUIDE_HOURS * 3600e3}`);
  let group = pref('live:group', '');

  if (!data.channels.length) {
    view.innerHTML = `<div class="empty"><h1>Live TV</h1>${admin
      ? `<p>Make channels from your library, or add channels from a tuner or an M3U playlist.</p>
         <p><a class="btn primary" href="#/live/setup">Set up channels</a></p>`
      : '<p>No channels yet.</p>'}</div>`;
    return;
  }

  view.innerHTML = `<div class="toolbar">
      <h1>Live TV</h1>
      <span class="spacer"></span>
      <select data-group aria-label="Channel group" hidden></select>
      <button class="btn" data-iptv>Watch in other apps</button>
      ${admin ? '<a class="btn" href="#/live/setup">Set up channels</a>' : ''}
    </div>
    <div class="guide"></div>`;
  const guideEl = view.querySelector('.guide');
  const groupSel = view.querySelector('[data-group]');
  view.querySelector('[data-iptv]').onclick = iptvDialog;

  const x = (t) => ((t - from) / 60000) * PX_PER_MIN;
  const width = GUIDE_HOURS * 60 * PX_PER_MIN;

  function render() {
    const groups = [...new Set(data.channels.map((c) => c.group))];
    groupSel.hidden = groups.length < 2;
    if (!groups.includes(group)) group = '';
    groupSel.innerHTML = `<option value="">All channels</option>${groups.map((g) => `<option>${esc(g)}</option>`).join('')}`;
    groupSel.value = group;
    const shown = data.channels.filter((c) => !group || c.group === group);
    const now = Date.now();

    const ticks = [];
    for (let t = from; t < from + GUIDE_HOURS * 3600e3; t += HALF_HOUR) ticks.push(`<div class="tick" style="left:${x(t)}px">${clock(t)}</div>`);
    const rows = shown.map((c) => {
      const progs = data.programs[c.id] || [];
      const blocks = progs.length ? progs.map((p, i) => {
        const left = Math.max(0, x(p.start));
        const w = Math.min(width, x(p.stop)) - left;
        if (w <= 0) return '';
        const onNow = p.start <= now && now < p.stop;
        return `<button class="prog ${onNow ? 'now' : ''} ${p.stop <= now ? 'past' : ''}" style="left:${left}px;width:${w}px" data-ch="${esc(c.id)}" data-i="${i}">
            <span class="prog-title">${esc(p.title)}</span><span class="prog-sub">${esc(subline(p) || span(p))}</span></button>`;
      }).join('') : `<a class="prog empty-prog" style="left:0;width:${width}px" href="#/live/watch/${encodeURIComponent(c.id)}">${c.kind === 'library' ? 'Nothing to play' : 'No guide information'}</a>`;
      return `<div class="guide-row"><a class="guide-chan" href="#/live/watch/${encodeURIComponent(c.id)}" title="Watch ${esc(c.name)}">${channelBadge(c)}</a>
        <div class="guide-progs" style="width:${width}px">${blocks}</div></div>`;
    }).join('');

    const scroll = guideEl.querySelector('.guide-scroll');
    const keep = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null;
    guideEl.innerHTML = `<div class="guide-scroll"><div class="guide-inner">
        <div class="guide-head"><div class="guide-corner">${new Date(from).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          <div class="guide-times" style="width:${width}px">${ticks.join('')}</div></div>
        ${rows || '<p class="muted pad">No channels in this group.</p>'}
        <div class="guide-now"></div>
      </div></div>`;
    if (keep) [guideEl.querySelector('.guide-scroll').scrollLeft, guideEl.querySelector('.guide-scroll').scrollTop] = keep;
    placeNow();
  }

  function placeNow() {
    const line = guideEl.querySelector('.guide-now');
    if (line) line.style.transform = `translateX(${x(Date.now())}px)`;
  }

  guideEl.addEventListener('click', (e) => {
    const b = e.target.closest('.prog[data-i]');
    if (!b) return;
    const c = data.channels.find((ch) => ch.id === b.dataset.ch);
    const p = data.programs[c.id][Number(b.dataset.i)];
    if (p.start <= Date.now() && Date.now() < p.stop) location.hash = `#/live/watch/${encodeURIComponent(c.id)}`;
    else programDialog(c, p);
  });
  groupSel.onchange = () => {
    group = groupSel.value;
    setPref('live:group', group);
    render();
  };
  render();

  // Keep the "now" line moving; reload the guide as time moves on.
  const tick = setInterval(async () => {
    placeNow();
    const start = Math.floor(Date.now() / HALF_HOUR) * HALF_HOUR;
    if (start !== from || Date.now() - data.loadedAt > 10 * 60e3) {
      from = start;
      data = { ...(await api(`/api/live/guide?from=${from}&to=${from + GUIDE_HOURS * 3600e3}`).catch(() => data)), loadedAt: Date.now() };
      render();
    }
  }, 30000);
  data.loadedAt = Date.now();
  return () => clearInterval(tick);
}

function programDialog(c, p) {
  const dlg = document.createElement('dialog');
  const pic = programImage(p);
  const day = new Date(p.start).toDateString() === new Date().toDateString() ? '' : `${new Date(p.start).toLocaleDateString([], { weekday: 'long' })} `;
  dlg.innerHTML = `${pic ? `<div class="prog-art"><img src="${esc(pic)}" alt="" onerror="this.parentElement.remove()"></div>` : ''}
    <div class="dlg-body">
      <div class="muted">${channelBadge(c)}</div>
      <h2>${esc(p.title)}</h2>
      <div class="muted">${esc([day + span(p), subline(p), p.rating].filter(Boolean).join(' · '))}</div>
      ${p.desc ? `<p>${esc(p.desc)}</p>` : ''}
      ${p.genres?.length ? `<div class="chips">${p.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="fb-foot">
      ${p.itemId ? `<a class="btn" href="#/item/${esc(p.itemId)}">Details</a>` : ''}
      <a class="btn" href="#/live/watch/${encodeURIComponent(c.id)}">Watch channel</a>
      <button class="btn primary" data-close>Close</button>
    </div>`;
  attachDialog(dlg);
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close], a')) dlg.close(); });
  dlg.showModal();
}

// Links for IPTV apps. The server only shows a link when it's made, so "make a new one" is how
// you see it again.
async function iptvDialog() {
  const dlg = document.createElement('dialog');
  attachDialog(dlg);
  const render = (state, links) => {
    dlg.innerHTML = `<div class="dlg-body">
        <h2>Watch in other apps</h2>
        <p class="muted">Add Deadair to an IPTV app (TiviMate, IPTVnator, VLC, Channels, Jellyfin…) with a playlist link and a guide link. They're yours alone and work without signing in, so keep them private like a password.</p>
        ${links ? `
          <label class="copy-field">Playlist (M3U)<span class="inline"><input class="input" readonly value="${esc(links.playlist)}"><button class="btn small" data-copy>Copy</button></span></label>
          <label class="copy-field">Guide (XMLTV)<span class="inline"><input class="input" readonly value="${esc(links.guide)}"><button class="btn small" data-copy>Copy</button></span></label>
          <p class="muted small">Save these now: they're only shown once. Other devices reach them the same way they reach Deadair (your network or Tailscale), so a TV away from home needs Tailscale.</p>`
          : state.createdAt ? `<p>You made links on ${new Date(state.createdAt).toLocaleDateString()}. They're only shown once. Make new ones to see them again; the old ones then stop working.</p>`
          : '<p>You don’t have links yet.</p>'}
        <p class="error" data-err></p>
      </div>
      <div class="fb-foot">
        ${state.createdAt ? '<button class="btn danger" data-off>Turn off links</button><span class="spacer"></span>' : ''}
        ${links ? '' : `<button class="btn ${state.createdAt ? '' : 'primary'}" data-make>${state.createdAt ? 'Make new links' : 'Make links'}</button>`}
        <button class="btn ${links || state.createdAt ? 'primary' : ''}" data-done>Done</button>
      </div>`;
    dlg.querySelector('[data-done]').onclick = () => dlg.close();
    dlg.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async (e) => {
      e.preventDefault();
      const input = b.previousElementSibling;
      input.select();
      try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
      b.textContent = 'Copied';
    }));
    const run = async (fn) => {
      try { await fn(); } catch (err) { dlg.querySelector('[data-err]').textContent = err.message; }
    };
    dlg.querySelector('[data-make]')?.addEventListener('click', () => run(async () => {
      if (state.createdAt && !confirm('Make new links? Apps using the old ones will stop working until you give them the new ones.')) return;
      const made = await api('/api/live/iptv', { method: 'POST' });
      render(made, made);
    }));
    dlg.querySelector('[data-off]')?.addEventListener('click', () => run(async () => {
      if (!confirm('Turn off your links? Apps using them will stop working.')) return;
      render(await api('/api/live/iptv', { method: 'DELETE' }));
    }));
  };
  render(await api('/api/live/iptv'));
  dlg.showModal();
}

// ---------- live player ----------

export function mountLive(root, channelId, { onBack }) {
  root.innerHTML = `
    <div class="player live loading">
      <video playsinline></video>
      <div class="spinner"></div>
      <div class="pc pc-top">
        <button data-act="back" title="Guide (Esc)">←</button>
        <div class="live-chan"></div>
        <span class="live-badge">LIVE</span>
      </div>
      <div class="live-entry" hidden></div>
      <div class="player-msg" hidden></div>
      <div class="pc pc-bottom">
        <div class="live-info">
          <div class="live-title"></div>
          <div class="live-meta"></div>
          <div class="live-progress"><span></span></div>
          <div class="live-next"></div>
        </div>
        <div class="pc-row">
          <button data-act="play" title="Pause (Space)">❚❚</button>
          <button data-act="down" class="ch-btn" title="Previous channel (↓)">CH −</button>
          <button data-act="up" class="ch-btn" title="Next channel (↑)">CH +</button>
          <span class="spacer"></span>
          <button data-act="mute" title="Mute (M)">🔊</button>
          <input class="vol" type="range" min="0" max="1" step="0.05" aria-label="Volume">
          <button data-act="fs" title="Fullscreen (F)">⛶</button>
        </div>
      </div>
    </div>`;

  const el = root.querySelector('.player');
  const video = el.querySelector('video');
  const msgEl = el.querySelector('.player-msg');
  const entryEl = el.querySelector('.live-entry');
  const playBtn = el.querySelector('[data-act=play]');
  const muteBtn = el.querySelector('[data-act=mute]');
  const vol = el.querySelector('.vol');
  const bar = el.querySelector('.live-progress span');

  let tuned = null; // last answer from /api/live/channels/:id
  let lineup = [];
  let mode = null; // 'direct' | 'transcode' | 'stream'
  let offset = 0; // transcode streams start at `offset` seconds into the file
  let seq = 0;
  let destroyed = false;
  let waitTimer;
  let idleTimer;
  let entryTimer;
  let typed = '';

  try {
    video.volume = Number(localStorage.getItem('vol') ?? 1);
    video.muted = localStorage.getItem('muted') === '1';
  } catch {}
  vol.value = video.volume;

  const showMsg = (text, retry) => {
    el.classList.remove('loading');
    msgEl.hidden = !text;
    msgEl.innerHTML = text ? `${esc(text)}${retry ? '<div style="margin-top:12px"><button class="btn small" data-retry>Try again</button></div>' : ''}` : '';
    msgEl.querySelector('[data-retry]')?.addEventListener('click', () => tune(channelId));
  };

  function renderInfo() {
    const { channel, now: p, next } = tuned;
    el.querySelector('.live-chan').innerHTML = channelBadge(channel);
    el.querySelector('.live-title').innerHTML = p ? `${esc(p.title)}${subline(p) ? ` <small>${esc(subline(p))}</small>` : ''}` : esc(channel.name);
    el.querySelector('.live-meta').textContent = p ? [span(p), p.rating, p.desc].filter(Boolean).join(' · ') : '';
    el.querySelector('.live-next').textContent = next ? `Next: ${clock(next.start)} ${next.title}${next.subtitle ? ` — ${next.subtitle}` : ''}` : '';
    el.querySelector('.live-progress').hidden = !p;
    document.title = `${channel.number} ${channel.name} · Deadair`;
  }

  // Where playback is in the current program: from the file for library channels (the player
  // can be behind the schedule after a pause), from the clock for outside channels.
  function renderProgress() {
    const p = tuned?.now;
    if (!p) return;
    let done;
    if (tuned.play?.itemId) done = (mode === 'direct' ? video.currentTime : offset + video.currentTime) / tuned.play.duration;
    else done = (Date.now() - p.start) / (p.stop - p.start);
    bar.style.width = `${Math.max(0, Math.min(100, done * 100)).toFixed(1)}%`;
  }

  function load(t) {
    el.classList.add('loading');
    const { play } = tuned;
    if (mode === 'stream') {
      video.src = play.stream;
    } else if (mode === 'direct') {
      video.src = `/api/items/${play.itemId}/direct`;
      if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = t; }, { once: true });
    } else {
      offset = t;
      video.src = `/api/items/${play.itemId}/transcode?t=${t.toFixed(2)}&audio=${play.audio}`;
    }
    video.play().catch(() => {});
  }

  async function tune(id) {
    const mine = ++seq;
    clearTimeout(waitTimer);
    showMsg('');
    el.classList.add('loading');
    let data;
    try {
      data = await api(`/api/live/channels/${encodeURIComponent(id)}`);
    } catch (err) {
      if (mine === seq && !destroyed) showMsg(err.message, true);
      return;
    }
    if (mine !== seq || destroyed) return;
    channelId = id;
    tuned = data;
    lineup = data.lineup;
    history.replaceState(null, '', `#/live/watch/${encodeURIComponent(id)}`);
    setPref('live:last', id);
    renderInfo();
    wake(5000);
    video.pause();
    if (!data.play) {
      video.removeAttribute('src');
      video.load();
      return showMsg('Nothing to play on this channel right now.');
    }
    if (data.play.stream) mode = 'stream';
    else mode = data.play.directPlay || !data.play.canTranscode ? 'direct' : 'transcode';
    load(data.play.offset || 0);
  }

  function surf(step) {
    if (!lineup.length) return;
    const i = lineup.findIndex((c) => c.id === channelId);
    tune(lineup[(i + step + lineup.length) % lineup.length].id);
  }

  // Typing a channel number, like a TV remote.
  function typeDigit(d) {
    typed = (typed + d).slice(0, 8);
    entryEl.hidden = false;
    entryEl.textContent = typed;
    clearTimeout(entryTimer);
    entryTimer = setTimeout(goTyped, 1500);
  }
  function goTyped() {
    clearTimeout(entryTimer);
    entryEl.hidden = true;
    const hit = lineup.find((c) => c.number === typed) || lineup.find((c) => parseFloat(c.number) === parseFloat(typed));
    typed = '';
    if (hit) tune(hit.id);
  }

  function wake(ms = 3000) {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) el.classList.add('idle'); }, ms);
  }

  const togglePlay = () => (video.paused ? video.play() : video.pause());
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen());
  const toggleMute = () => { video.muted = !video.muted; };

  video.addEventListener('timeupdate', renderProgress);
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; wake(); });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; el.classList.remove('idle'); });
  video.addEventListener('waiting', () => el.classList.add('loading'));
  for (const ev of ['playing', 'canplay']) video.addEventListener(ev, () => el.classList.remove('loading'));
  video.addEventListener('volumechange', () => {
    muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    vol.value = video.muted ? 0 : video.volume;
    try { localStorage.setItem('vol', video.volume); localStorage.setItem('muted', video.muted ? '1' : '0'); } catch {}
  });
  // End of a program: on to whatever the channel plays next. If playback finished a little
  // ahead of the schedule, wait for the clock to catch up rather than replay the end.
  video.addEventListener('ended', () => {
    const wait = (tuned?.now?.stop || 0) - Date.now();
    el.classList.add('loading');
    waitTimer = setTimeout(() => tune(channelId), wait > 0 && wait < 60000 ? wait + 250 : 0);
  });
  video.addEventListener('error', () => {
    if (destroyed || !video.getAttribute('src')) return;
    if (mode === 'direct' && tuned.play.canTranscode) {
      const t = video.currentTime || tuned.play.offset;
      mode = 'transcode';
      return load(t);
    }
    showMsg(mode === 'stream' ? 'This channel isn’t available right now.' : 'Playback failed. Check the server console for ffmpeg errors.', true);
  });
  video.addEventListener('loadeddata', () => {
    if (mode === 'direct' && video.videoWidth === 0 && tuned.play.canTranscode) {
      mode = 'transcode';
      load(video.currentTime || tuned.play.offset);
    }
  });
  vol.addEventListener('input', () => { video.volume = Number(vol.value); video.muted = video.volume === 0; });

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') onBack();
    else if (act === 'play') togglePlay();
    else if (act === 'up') surf(1);
    else if (act === 'down') surf(-1);
    else if (act === 'mute') toggleMute();
    else if (act === 'fs') toggleFs();
    else if (e.target === video) togglePlay();
  });
  video.addEventListener('dblclick', toggleFs);
  el.addEventListener('mousemove', () => wake());

  function onKey(e) {
    if (e.target.matches('input, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9.]$/.test(e.key)) {
      e.preventDefault();
      return typeDigit(e.key);
    }
    const keys = {
      ' ': togglePlay, k: togglePlay,
      ArrowUp: () => surf(1), PageUp: () => surf(1), ChannelUp: () => surf(1),
      ArrowDown: () => surf(-1), PageDown: () => surf(-1), ChannelDown: () => surf(-1),
      Enter: () => (typed ? goTyped() : wake()),
      f: toggleFs, m: toggleMute, g: onBack,
      Escape: () => { if (!document.fullscreenElement) onBack(); },
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
      wake();
    }
  }
  document.addEventListener('keydown', onKey);

  // Outside channels change programs on the clock; refresh what's on now and then.
  const infoTimer = setInterval(async () => {
    renderProgress();
    if (!tuned || tuned.play?.itemId) return;
    const p = tuned.now;
    if (p && Date.now() < p.stop) return;
    const mine = seq;
    const data = await api(`/api/live/channels/${encodeURIComponent(channelId)}`).catch(() => null);
    if (data && mine === seq && !destroyed) {
      tuned = { ...data, play: tuned.play };
      renderInfo();
    }
  }, 15000);

  tune(channelId);

  return function destroy() {
    destroyed = true;
    seq++;
    clearTimeout(waitTimer);
    clearTimeout(idleTimer);
    clearTimeout(entryTimer);
    clearInterval(infoTimer);
    document.removeEventListener('keydown', onKey);
    document.title = 'Deadair';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // Dropping the src aborts the HTTP request, which stops the server-side ffmpeg.
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}

// ---------- setup (admins) ----------

const ORDER_LABEL = { sequential: 'In order', rotate: 'Rotating shows', shuffle: 'Shuffled' };
const ORDER_HELP = {
  sequential: 'Each show from the first episode to the last, then the next show, then the movies (oldest first), then around again.',
  rotate: 'One episode from each show in turn, like a rerun block. Any movies take a turn too.',
  shuffle: 'Everything in a random order. Nothing repeats until everything has played.',
};

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
};

export async function setupPage(view) {
  view.innerHTML = `<div class="toolbar"><h1>Set up Live TV</h1><span class="spacer"></span><a class="btn" href="#/live">Guide</a></div>
    <div class="panel">
      <h2>Channels from your library</h2>
      <p class="muted">24/7 channels of your own shows and movies, planned three days ahead so they have a guide like any other channel.</p>
      <div data-channels></div>
      <p><button class="btn primary" data-new>New channel</button></p>
    </div>
    <div class="panel">
      <h2>Channel sources</h2>
      <p class="muted">Channels from an M3U playlist: an HDHomeRun antenna tuner (<code>http://&lt;tuner address&gt;/lineup.m3u</code>), a free channel list, or a service you subscribe to. Only add channels you’re entitled to watch.</p>
      <div data-sources></div>
      <h3>Add a source</h3>
      <form class="form" data-add>
        <label>Name<input class="input" name="name" required placeholder="Antenna"></label>
        <label>Playlist (M3U) address or file<input class="input" name="url" required placeholder="http://192.168.1.50/lineup.m3u"></label>
        <label>Guide (XMLTV) address or file<input class="input" name="guideUrl" placeholder="Optional if the playlist names its guide (.xml or .xml.gz)"></label>
        <details><summary class="muted">More options</summary>${sourceOptions({ proxy: true })}</details>
        <div><button class="btn primary">Add source</button> <span class="error" data-err></span></div>
      </form>
    </div>`;

  let data;
  let pollTimer;
  async function load() {
    clearTimeout(pollTimer);
    data = await api('/api/live/setup');
    if (!view.querySelector('[data-channels]')) return;
    renderChannels();
    renderSources();
    if (data.sources.some((s) => s.refreshing)) pollTimer = setTimeout(load, 2000);
  }

  function renderChannels() {
    const el = view.querySelector('[data-channels]');
    el.innerHTML = data.channels.length ? data.channels.map((c) => `<div class="lib-row">
        <div class="grow"><strong>${esc(c.number)} · ${esc(c.name)}</strong>
          <div class="muted small">${[c.shows && plural(c.shows, 'show'), c.movies && plural(c.movies, 'movie'), c.duration ? (c.duration > 48 * 3600 ? `${Math.round(c.duration / 3600).toLocaleString()} h` : fmtDuration(c.duration)) : 'nothing playable yet', ORDER_LABEL[c.order]].filter(Boolean).join(' · ')}</div></div>
        <a class="btn small" href="#/live/watch/${encodeURIComponent(c.id)}">Watch</a>
        <button class="btn small" data-edit="${esc(c.id)}">Edit</button>
        <button class="btn small danger" data-del="${esc(c.id)}">Delete</button>
      </div>`).join('') : '<p class="muted">No library channels yet.</p>';
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => channelEditor(data.channels.find((c) => c.id === b.dataset.edit), load)));
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const c = data.channels.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete channel ${c.number} “${c.name}”? Your files aren’t touched.`)) return;
      await api(`/api/live/library-channels/${c.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      load();
    }));
  }

  function renderSources() {
    const el = view.querySelector('[data-sources]');
    el.innerHTML = data.sources.length ? data.sources.map((s) => {
      const state = s.refreshing ? '<span class="scanning">Updating…</span>'
        : s.error && !s.channelCount ? `<span class="error">${esc(s.error)}</span>`
        : [`${s.includedCount.toLocaleString()} of ${plural(s.channelCount, 'channel')}`,
          !s.hasGuide ? 'no guide' : s.guideError ? `<span class="error">guide: ${esc(s.guideError)}</span>` : `guide for ${s.guideChannels.toLocaleString()}`,
          s.error ? `<span class="error">last update failed: ${esc(s.error)}</span>` : s.fetchedAt && `updated ${ago(s.fetchedAt)}`].filter(Boolean).join(' · ');
      return `<div class="lib-row">
        <div class="grow"><strong>${esc(s.name)}</strong> <span class="muted">· ${state}</span><div class="path">${esc(s.url)}</div></div>
        <button class="btn small ${s.channelCount && !s.includedCount ? 'primary' : ''}" data-pick="${esc(s.id)}" ${s.channelCount ? '' : 'disabled'}>Channels</button>
        <button class="btn small" data-edit="${esc(s.id)}">Edit</button>
        <button class="btn small" data-refresh="${esc(s.id)}" ${s.refreshing ? 'disabled' : ''}>Update</button>
        <button class="btn small danger" data-del="${esc(s.id)}">Remove</button>
      </div>`;
    }).join('') : '<p class="muted">No sources yet.</p>';
    const find = (id) => data.sources.find((s) => s.id === id);
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => channelPicker(find(b.dataset.pick), load)));
    el.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => sourceEditor(find(b.dataset.edit), load)));
    el.querySelectorAll('[data-refresh]').forEach((b) => (b.onclick = async () => {
      await api(`/api/live/sources/${b.dataset.refresh}/refresh`, { method: 'POST' }).catch((err) => alert(err.message));
      load();
    }));
    el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const s = find(b.dataset.del);
      if (!confirm(`Remove “${s.name}” and its channels from Deadair?`)) return;
      await api(`/api/live/sources/${s.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      load();
    }));
  }

  view.querySelector('[data-new]').onclick = () => channelEditor(null, load);
  const form = view.querySelector('[data-add]');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const errEl = form.querySelector('[data-err]');
    btn.disabled = true;
    btn.textContent = 'Loading playlist…';
    errEl.textContent = '';
    try {
      const src = await api('/api/live/sources', { method: 'POST', body: sourceBody(form) });
      form.reset();
      await load();
      // Big lists start with nothing selected: go straight to choosing.
      if (!src.includedCount) channelPicker(src, load);
    } catch (err) {
      errEl.textContent = err.message;
    }
    btn.disabled = false;
    btn.textContent = 'Add source';
  };

  await load();
  return () => clearTimeout(pollTimer);
}

function sourceOptions(s) {
  return `<label>First channel number<input class="input" name="firstNumber" inputmode="numeric" value="${esc(s.firstNumber || '')}" placeholder="Next free hundred" style="max-width:180px"></label>
    <p class="muted small" style="margin:0">Used for channels the playlist doesn’t number itself.</p>
    <label class="check"><input type="checkbox" name="proxy" ${s.proxy ? 'checked' : ''}> IPTV apps get these channels through Deadair</label>
    <p class="muted small" style="margin:0">Leave on for a tuner on your home network, so it also works away from home over Tailscale. Turn off to have apps connect to the source directly. Deadair's own player always goes through Deadair.</p>`;
}

const sourceBody = (form) => ({
  name: form.name.value,
  url: form.url.value,
  guideUrl: form.guideUrl.value,
  firstNumber: form.firstNumber.value || undefined,
  proxy: form.proxy.checked,
});

function sourceEditor(s, done) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form class="form dlg-body">
      <h2>Edit source</h2>
      <label>Name<input class="input" name="name" required value="${esc(s.name)}"></label>
      <label>Playlist (M3U) address or file<input class="input" name="url" required value="${esc(s.url)}"></label>
      <label>Guide (XMLTV) address or file<input class="input" name="guideUrl" value="${esc(s.guideUrl)}" placeholder="Optional if the playlist names its guide"></label>
      ${sourceOptions(s)}
      <p class="error" data-err></p>
    </form>
    <div class="fb-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`;
  attachDialog(dlg);
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  const form = dlg.querySelector('form');
  const save = async () => {
    try {
      await api(`/api/live/sources/${s.id}`, { method: 'PUT', body: sourceBody(form) });
      dlg.close();
      done();
    } catch (err) {
      form.querySelector('[data-err]').textContent = err.message;
    }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  dlg.querySelector('[data-save]').onclick = save;
  dlg.showModal();
}

// Choosing which channels of a playlist to show. Long lists only render the first matches.
async function channelPicker(s, done) {
  const { channels } = await api(`/api/live/sources/${s.id}/channels`);
  const selected = new Set(channels.filter((c) => c.included).map((c) => c.key));
  let all = s.include === 'all';
  const LIMIT = 400;
  const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))].sort();

  const dlg = document.createElement('dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<div class="dlg-body">
      <h2>Channels in ${esc(s.name)}</h2>
      <div class="picker-bar">
        <input class="input" type="search" placeholder="Filter by name" data-q>
        ${groups.length > 1 ? `<select data-g><option value="">All groups</option>${groups.map((g) => `<option>${esc(g)}</option>`).join('')}</select>` : ''}
        <button class="btn small" data-sel="1">Select shown</button>
        <button class="btn small" data-sel="0">Clear shown</button>
      </div>
      <div class="picker-list"></div>
      <label class="check"><input type="checkbox" data-all ${all ? 'checked' : ''}> Show every channel in this playlist, including ones added later</label>
    </div>
    <div class="fb-foot"><span class="muted" data-count style="margin-right:auto"></span><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>`;
  attachDialog(dlg);
  const list = dlg.querySelector('.picker-list');
  const q = dlg.querySelector('[data-q]');
  const g = dlg.querySelector('[data-g]');

  const matches = () => {
    const text = q.value.trim().toLowerCase();
    return channels.filter((c) => (!text || c.name.toLowerCase().includes(text)) && (!g?.value || c.group === g.value));
  };
  function render() {
    const shown = matches();
    list.innerHTML = shown.slice(0, LIMIT).map((c) => `<label class="pick">
        <input type="checkbox" data-key="${esc(c.key)}" ${all || selected.has(c.key) ? 'checked' : ''} ${all ? 'disabled' : ''}>
        ${safeUrl(c.logo) ? `<img class="ch-logo" src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
        <span>${c.number ? `<span class="muted">${esc(c.number)}</span> ` : ''}${esc(c.name)}</span><span class="muted small">${esc(c.group)}</span>
      </label>`).join('') + (shown.length > LIMIT ? `<p class="muted pad">…and ${(shown.length - LIMIT).toLocaleString()} more. Filter to find them.</p>` : '')
      + (shown.length ? '' : '<p class="muted pad">No matches.</p>');
    count();
  }
  const count = () => {
    dlg.querySelector('[data-count]').textContent = all ? `All ${channels.length.toLocaleString()} channels` : `${selected.size.toLocaleString()} of ${channels.length.toLocaleString()} selected`;
  };
  list.addEventListener('change', (e) => {
    const key = e.target.dataset.key;
    if (e.target.checked) selected.add(key);
    else selected.delete(key);
    count();
  });
  dlg.querySelectorAll('[data-sel]').forEach((b) => (b.onclick = () => {
    for (const c of matches()) (b.dataset.sel === '1' ? selected.add(c.key) : selected.delete(c.key));
    render();
  }));
  dlg.querySelector('[data-all]').onchange = (e) => {
    all = e.target.checked;
    render();
  };
  q.oninput = render;
  if (g) g.onchange = render;
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-save]').onclick = async () => {
    try {
      await api(`/api/live/sources/${s.id}`, { method: 'PUT', body: { include: all ? 'all' : [...selected] } });
      dlg.close();
      done();
    } catch (err) {
      alert(err.message);
    }
  };
  render();
  dlg.showModal();
}

// Making or editing a library channel.
async function channelEditor(ch, done) {
  const cat = await api('/api/live/catalog');
  const picked = new Set((ch?.content || []).map((c) => `${c.type}:${c.showKey ?? c.key ?? c.libraryId ?? c.genre}`));
  const row = (type, value, label, extra = '') => `<label class="pick" data-text="${esc(label.toLowerCase())}">
      <input type="checkbox" data-type="${type}" data-v="${esc(value)}" ${picked.has(`${type}:${value}`) ? 'checked' : ''}>
      <span>${esc(label)}</span><span class="muted small">${esc(extra)}</span></label>`;
  const section = (title, rows) => (rows.length ? `<div class="pick-section"><h3>${title}</h3>${rows.join('')}</div>` : '');

  const dlg = document.createElement('dialog');
  dlg.className = 'wide';
  dlg.innerHTML = `<form class="dlg-body" data-form>
      <h2>${ch ? 'Edit channel' : 'New channel'}</h2>
      <div class="ch-fields">
        <label>Number<input class="input" name="number" value="${esc(ch?.number || '')}" placeholder="Next" inputmode="decimal"></label>
        <label class="grow">Name<input class="input" name="name" value="${esc(ch?.name || '')}" placeholder="e.g. Futurama Forever" required></label>
        <label>Order<select name="order">${Object.entries(ORDER_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      </div>
      <p class="muted small" data-help></p>
      <div class="picker-bar"><input class="input" type="search" placeholder="Filter shows, movies, genres" data-q><span class="muted small" data-count></span></div>
      <div class="picker-list tall">
        ${section('Shows', cat.shows.map((s) => row('show', s.showKey, s.title, [s.year, plural(s.episodes, 'episode')].filter(Boolean).join(' · '))))}
        ${section('Movies', cat.movies.map((m) => row('movie', m.key, m.title, m.year || '')))}
        ${section('Genres (shows and movies)', cat.genres.map((gn) => row('genre', gn, gn)))}
        ${section('Whole libraries', cat.libraries.map((l) => row('library', l.id, l.name, 'everything in it, including what’s added later')))}
      </div>
      <p class="error" data-err></p>
    </form>
    <div class="fb-foot"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>${ch ? 'Save' : 'Create channel'}</button></div>`;
  attachDialog(dlg);
  const form = dlg.querySelector('[data-form]');
  const help = dlg.querySelector('[data-help]');
  form.order.value = ch?.order || 'sequential';
  const showHelp = () => { help.textContent = ORDER_HELP[form.order.value]; };
  form.order.onchange = showHelp;
  showHelp();

  const boxes = () => [...dlg.querySelectorAll('.picker-list input[type=checkbox]')];
  const count = () => {
    const n = boxes().filter((b) => b.checked).length;
    dlg.querySelector('[data-count]').textContent = n ? `${n} selected` : '';
  };
  dlg.querySelector('.picker-list').addEventListener('change', (e) => {
    // First pick names a new channel, if it has no name yet.
    if (e.target.checked && !form.name.value.trim()) form.name.value = e.target.nextElementSibling.textContent;
    count();
  });
  dlg.querySelector('[data-q]').oninput = (e) => {
    const text = e.target.value.trim().toLowerCase();
    for (const el of dlg.querySelectorAll('.pick')) el.hidden = !!text && !el.dataset.text.includes(text);
    for (const sec of dlg.querySelectorAll('.pick-section')) sec.hidden = !sec.querySelector('.pick:not([hidden])');
  };
  count();

  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  form.onsubmit = (e) => e.preventDefault();
  dlg.querySelector('[data-save]').onclick = async () => {
    const content = boxes().filter((b) => b.checked).map((b) => {
      const { type, v } = b.dataset;
      return { type, [{ show: 'showKey', movie: 'key', library: 'libraryId', genre: 'genre' }[type]]: v };
    });
    const body = { name: form.name.value, number: form.number.value, order: form.order.value, content };
    try {
      await api(ch ? `/api/live/library-channels/${ch.id}` : '/api/live/library-channels', { method: ch ? 'PUT' : 'POST', body });
      dlg.close();
      done();
    } catch (err) {
      dlg.querySelector('[data-err]').textContent = err.message;
    }
  };
  dlg.showModal();
}
