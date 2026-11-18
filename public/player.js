import { esc, fmtClock, parseCues, epCode } from './util.js';
import { castReady } from './cast.js';

// hls.js (public/vendor, Apache-2.0) is loaded only when a smaller size is first played.
let hlsModule = null;
const hlsLibrary = () => (hlsModule ||= import('./vendor/hls.light.min.mjs').then((m) => m.default));

// Three playback modes:
//  - direct: the browser streams the original file with Range requests.
//  - transcode: the server pipes a fragmented MP4 from ffmpeg starting at `offset`.
//    The <video> element's clock starts at 0 for each stream, so absolute time = offset + currentTime,
//    and seeking outside the buffered range restarts the stream at the new offset.
//  - hls: adaptive streaming at smaller sizes, through hls.js (see "Quality" below). Its clock is
//    the film's own, like direct play.
// item.base is where the streams and progress live (/api/items/<id> for library files, a
// plugin's own route for its videos).
export function mountPlayer(root, item, { onBack, onPlayNext }) {
  const base = item.base || `/api/items/${item.id}`;
  const heading = item.kind === 'episode'
    ? `${esc(item.show)}<small>${esc(epCode(item))} — ${esc(item.title)}</small>`
    : `${esc(item.title)}${item.year ? `<small>${item.year}</small>` : item.channel ? `<small>${esc(item.channel)}</small>` : ''}`;

  root.innerHTML = `
    <div class="player loading">
      <video playsinline preload="auto"></video>
      <div class="subs"></div>
      <div class="spinner"></div>
      <div class="cast-msg" hidden></div>
      <div class="pc pc-top">
        <button data-act="back" title="Back (Esc)">←</button>
        <div class="pc-title">${heading}</div>
      </div>
      <div class="pc pc-bottom">
        <input class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">
        <div class="pc-row">
          <button data-act="play" title="Play/Pause (Space)">▶</button>
          <button data-act="rew" title="Back 10s (←)">↺</button>
          <button data-act="fwd" title="Forward 10s (→)">↻</button>
          <span class="time">0:00 / 0:00</span>
          <span class="spacer"></span>
          <select data-el="quality" title="Quality" hidden></select>
          <select data-el="audio" title="Audio track" hidden></select>
          <select data-el="subs" title="Subtitles"></select>
          <button data-act="mute" title="Mute (M)">🔊</button>
          <input class="vol" type="range" min="0" max="1" step="0.05" aria-label="Volume">
          <span class="cast-slot" data-cast hidden><google-cast-launcher title="Play on a Chromecast"></google-cast-launcher></span>
          <button data-act="fs" title="Fullscreen (F)">⛶</button>
        </div>
      </div>
    </div>`;

  const el = root.querySelector('.player');
  const video = el.querySelector('video');
  const seekBar = el.querySelector('.seek');
  const timeEl = el.querySelector('.time');
  const subsEl = el.querySelector('.subs');
  const playBtn = el.querySelector('[data-act=play]');
  const muteBtn = el.querySelector('[data-act=mute]');
  const vol = el.querySelector('.vol');
  const audioSel = el.querySelector('[data-el=audio]');
  const subSel = el.querySelector('[data-el=subs]');
  const qualitySel = el.querySelector('[data-el=quality]');

  // Quality. Original plays the file itself (direct, or remuxed by ffmpeg). The smaller sizes come
  // from adaptive streaming (server/hls.js, played with hls.js): a fixed size stays put, and Auto
  // lets hls.js pick the size from how fast pieces arrive, changing it at the next piece without
  // restarting. Auto starts on Original and moves to adaptive streaming only when the connection
  // can't keep up, so a viewer at home never pays for re-encoding; this device then starts
  // adaptive for a day. All of it is remembered per device, since it's about that device's network.
  // Library files only (plugin streams have their own routes).
  const levels = item.base ? [] : item.qualities || [];
  let quality = 'auto'; // 'auto', 'original' or a height like '480'
  try {
    const q = localStorage.getItem('quality');
    if (q === 'original' || levels.some((l) => String(l.height) === q)) quality = q;
  } catch {}
  if (!levels.length) quality = 'original';
  const ADAPTIVE_FOR = 24 * 3600e3;
  const adaptiveRecently = () => { try { return Date.now() - Number(localStorage.getItem('adaptiveAt')) < ADAPTIVE_FOR; } catch { return false; } };

  const defaultAudio = Math.max(0, item.audio.findIndex((a) => a.default));
  const naturalMode = () => (item.directPlay || !item.canTranscode) && audioIndex === defaultAudio ? 'direct' : 'transcode';
  let audioIndex = defaultAudio;
  // 'direct' | 'transcode' (both Original) | 'hls' (adaptive)
  let mode = quality !== 'original' && (quality !== 'auto' || adaptiveRecently()) ? 'hls' : naturalMode();
  let offset = 0;
  let pendingStart = null; // where playback is about to start, until the video element gets there
  let cues = [];
  let dragging = false;
  let lastReport = 0;
  let destroyed = false;
  let upNextShown = false;

  const plainTitle = item.kind === 'episode' ? `${item.show} ${epCode(item)}` : item.title;
  const route = location.hash.split('?')[0]; // this player's page, e.g. #/play/<id>

  // While casting, the TV is the clock (see "Chromecast" below).
  let casting = null;
  const duration = () => item.duration || (Number.isFinite(video.duration) ? video.duration : 0);
  const now = () => (casting
    ? (casting.mode === 'direct' ? 0 : casting.offset) + (casting.player.currentTime || 0)
    : mode === 'transcode' ? offset + video.currentTime : pendingStart ?? video.currentTime);

  // ----- volume (remembered) -----
  try {
    video.volume = Number(localStorage.getItem('vol') ?? 1);
    video.muted = localStorage.getItem('muted') === '1';
  } catch {}
  vol.value = video.volume;

  // ----- audio / subtitle menus -----
  if (item.audio.length > 1) {
    audioSel.hidden = false;
    audioSel.innerHTML = item.audio.map((a) =>
      `<option value="${a.ai}">${esc([a.title, a.lang, a.codec, a.channels && `${a.channels}ch`].filter(Boolean).join(' · '))}</option>`).join('');
    audioSel.value = audioIndex;
  }
  if (levels.length) {
    qualitySel.hidden = false;
    qualitySel.innerHTML = `<option value="auto">Auto</option>
      <option value="original">Original${item.quality ? ` · ${esc(item.quality)}` : ''}</option>` +
      levels.map((l) => `<option value="${l.height}">${l.height}p</option>`).join('');
  }
  subSel.innerHTML = `<option value="">Subtitles off</option>` +
    item.subtitles.map((s) => `<option value="${esc(s.key)}">${esc(s.label)}</option>`).join('');
  if (!item.subtitles.length) subSel.hidden = true;

  // ----- loading / seeking -----
  function load(t) {
    el.classList.add('loading');
    stopHls();
    hasPlayed = false;
    // Until the video element has caught up, now() is where we asked it to start (a quality switch
    // straight after opening must not start from 0:00).
    pendingStart = mode !== 'transcode' && t > 0 ? t : null;
    if (mode === 'hls') {
      loadHls(t);
      return;
    }
    if (mode === 'direct') {
      video.src = `${base}/direct`;
      if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = pendingStart ?? t; }, { once: true });
    } else {
      offset = t;
      video.src = `${base}/transcode?t=${t.toFixed(2)}&audio=${audioIndex}`;
    }
    video.play().catch(() => {});
    renderQuality();
    // Auto on Original, and it's taking too long to start: the connection can't carry the file.
    clearTimeout(waitTimer);
    if (quality === 'auto' && levels.length) {
      waitTimer = setTimeout(() => {
        if (!destroyed && !casting && mode !== 'hls' && !hasPlayed && !video.paused) goAdaptive('slow to start on Original');
      }, 12000);
    }
  }

  function seek(t) {
    const d = duration();
    t = Math.max(0, d ? Math.min(t, d - 1) : t);
    if (casting) return castSeek(t);
    if (incident) incident.at = t;
    if (mode !== 'transcode') {
      if (pendingStart != null) pendingStart = t;
      video.currentTime = t;
      return;
    }
    const rel = t - offset;
    for (let i = 0; i < video.buffered.length; i++) {
      if (rel >= video.buffered.start(i) && rel <= video.buffered.end(i)) {
        video.currentTime = rel;
        return;
      }
    }
    load(t);
  }

  // ----- adaptive streaming -----
  let hlsPlayer = null;
  let hasPlayed = false; // since the last load: tells a stall apart from starting up
  const heightOf = (level) => Number(/\/hls\/(\d+)\//.exec(level?.uri || '')?.[1]) || null;
  const levelIndex = (height) => hlsPlayer.levels.findIndex((l) => heightOf(l) === height);

  async function loadHls(t) {
    const Hls = await hlsLibrary().catch(() => null);
    if (destroyed || mode !== 'hls' || hlsPlayer) return;
    const src = `${base}/hls/main.m3u8?audio=${audioIndex}`;
    if (!Hls?.isSupported()) {
      // Safari on an older iPhone: plays HLS itself, picking the size on its own.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        if (t > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = pendingStart ?? t; }, { once: true });
      } else {
        mode = naturalMode(); // no way to play it here: back to Original
        quality = 'original';
        load(t);
        return;
      }
      video.play().catch(() => {});
      renderQuality();
      return;
    }
    let saved = 0;
    try { saved = Number(localStorage.getItem('bandwidth')) || 0; } catch {}
    const h = new Hls({
      autoStartLoad: false,
      maxBufferLength: 60, // seconds ahead, to ride out a slow patch on a faraway connection
      abrEwmaDefaultEstimate: saved || 1e6, // where Auto starts: this device's last measured speed
    });
    hlsPlayer = h;
    h.on(Hls.Events.MANIFEST_PARSED, () => {
      const fixed = quality === 'auto' ? -1 : levelIndex(Number(quality));
      if (fixed >= 0) h.startLevel = fixed;
      h.loadLevel = fixed;
      h.startLoad(t);
      video.play().catch(() => {});
    });
    h.on(Hls.Events.LEVEL_SWITCHED, renderQuality);
    h.on(Hls.Events.ERROR, (e, data) => {
      // hls.js retries pieces itself; a fatal error means it gave up, so reconnect the usual way.
      if (data.fatal && hlsPlayer === h) recover('error', `adaptive stream: ${data.details}`);
    });
    h.loadSource(src);
    h.attachMedia(video);
    renderQuality();
  }

  function stopHls() {
    if (!hlsPlayer) return;
    try { localStorage.setItem('bandwidth', String(Math.round(hlsPlayer.bandwidthEstimate))); } catch {}
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  // Auto on Original, and the connection can't keep up: move to adaptive streaming from here.
  function goAdaptive(reason) {
    console.info('Switching to adaptive streaming:', reason);
    try { localStorage.setItem('adaptiveAt', String(Date.now())); } catch {}
    adaptiveSince = Date.now();
    const t = now();
    mode = 'hls';
    load(t);
  }
  let adaptiveSince = Date.now();

  // What the menu shows: on Auto, what Auto is playing right now.
  function renderQuality() {
    if (!levels.length) return;
    const h = mode === 'hls' && hlsPlayer && hlsPlayer.currentLevel >= 0 ? heightOf(hlsPlayer.levels[hlsPlayer.currentLevel]) : null;
    qualitySel.options[0].textContent = quality !== 'auto' ? 'Auto' : mode !== 'hls' ? 'Auto · Original' : h ? `Auto · ${h}p` : 'Auto';
    qualitySel.value = quality;
  }

  function switchToTranscode(reason) {
    if (mode === 'transcode' || !item.canTranscode) return false;
    console.info('Switching to transcode:', reason);
    const t = now();
    mode = 'transcode';
    load(t);
    return true;
  }

  // ----- recovering from dropped streams -----
  // A transcode is one long HTTP response. If it breaks (the server restarted, ffmpeg died, the
  // network blipped) the video plays what it has buffered and then errors, ends early or stalls.
  // Instead of giving up, reconnect from where playback got to, retrying for about a minute (a
  // service restart takes 10-20 s). Each incident is reported to the server with its outcome,
  // so dropouts show up in Settings → Playback problems.
  const RETRY_DELAYS = [1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000]; // ~66 s
  const STALL_MS = 30000;
  let incident = null; // { what, message, since, attempts, at, reported }
  let retryTimer = null;
  let msgEl = null;

  function showMsg(text, { retry = false } = {}) {
    msgEl ||= el.appendChild(Object.assign(document.createElement('div'), { className: 'player-msg' }));
    msgEl.innerHTML = `<div>${esc(text)}</div>${retry ? '<button class="btn small primary" data-retry>Try again</button>' : ''}`;
    msgEl.querySelector('[data-retry]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const at = incident?.at ?? now();
      incident = null;
      hideMsg();
      load(at);
    });
  }
  function hideMsg() {
    msgEl?.remove();
    msgEl = null;
  }

  function recover(what, message) {
    if (destroyed) return;
    if (incident?.reported) incident = null; // gave up earlier, and the viewer tried again (seeked)
    incident ||= { what, message, since: Date.now(), attempts: 0, at: now() };
    clearTimeout(retryTimer);
    if (incident.attempts >= RETRY_DELAYS.length) {
      el.classList.remove('loading');
      showMsg('Playback stopped: couldn’t reach the server for a minute.', { retry: true });
      closeIncident('failed');
      return;
    }
    el.classList.add('loading');
    showMsg(incident.attempts ? 'Still reconnecting…' : 'Connection lost. Reconnecting…');
    retryTimer = setTimeout(() => load(incident.at), RETRY_DELAYS[incident.attempts++]);
  }

  // Report how an outage ended: recovered, failed (gave up) or left (the viewer closed the player).
  function closeIncident(outcome) {
    const i = incident;
    if (!i || i.reported) return;
    i.reported = true;
    if (outcome !== 'failed') incident = null; // a failed one is kept for Try again's position
    const body = JSON.stringify({
      what: i.what, outcome, message: i.message, attempts: i.attempts, mode, title: plainTitle, ref: route,
      position: i.at, downFor: (Date.now() - i.since) / 1000,
    });
    navigator.sendBeacon('/api/playback/problems', new Blob([body], { type: 'application/json' }));
  }

  // Playing again after an outage: it worked.
  video.addEventListener('playing', () => {
    if (!incident) return;
    closeIncident('recovered'); // (no-op if it was already reported as failed)
    incident = null;
    hideMsg();
  });

  // Stuck: not paused, but the clock hasn't moved for STALL_MS (a stream that went quiet).
  let lastClock = -1;
  let lastMove = Date.now();
  const stallTimer = setInterval(() => {
    if (video.currentTime !== lastClock || video.paused || video.ended) {
      lastClock = video.currentTime;
      lastMove = Date.now();
      return;
    }
    if (Date.now() - lastMove > STALL_MS && !incident?.reported) {
      lastMove = Date.now();
      recover('stalled', `no progress for ${STALL_MS / 1000}s`);
    }
  }, 5000);

  // ----- remembering the position -----
  // Keep ?t= in the address bar at the current position, so a reload (or a crashed tab) resumes
  // right here even if the last progress report never reached the server.
  let lastUrlUpdate = 0;
  function rememberPosition(force) {
    const t = Math.floor(now());
    if (destroyed || t < 1 || location.hash.split('?')[0] !== route) return;
    if (!force && Date.now() - lastUrlUpdate < 5000) return;
    lastUrlUpdate = Date.now();
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if (q.get('t') === String(t)) return;
    q.set('t', String(t));
    history.replaceState(history.state, '', `${route}?${q}`);
  }

  // ----- progress reporting -----
  function report(force) {
    const t = now();
    const d = duration();
    if (!d || t < 1) return;
    if (!force && Date.now() - lastReport < 10000) return;
    lastReport = Date.now();
    const body = JSON.stringify({ position: t, duration: d });
    const url = `${base}/progress`;
    if (force === 'beacon') navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }

  // ----- UI updates -----
  function renderTime() {
    const t = now();
    const d = duration();
    timeEl.textContent = `${fmtClock(t)} / ${fmtClock(d)}`;
    if (!dragging && d) seekBar.value = Math.round((t / d) * 1000);
    if (item.next && d && d - t < 30 && !upNextShown) showUpNext();
  }

  function showUpNext() {
    upNextShown = true;
    const box = document.createElement('div');
    box.className = 'upnext';
    box.innerHTML = `<div class="muted">Up next</div>
      <div><strong>${esc(epCode(item.next))}</strong> — ${esc(item.next.title)}</div>
      <div style="display:flex;gap:8px"><button class="btn primary small" data-go>Play now</button><button class="btn small" data-x>Dismiss</button></div>`;
    box.querySelector('[data-go]').onclick = () => { report(true); onPlayNext(item.next); };
    box.querySelector('[data-x]').onclick = () => box.remove();
    el.appendChild(box);
  }

  let lastSub = '';
  function renderSubs() {
    if (destroyed) return;
    let text = '';
    if (cues.length) {
      const t = now();
      text = cues.filter((c) => t >= c.start && t <= c.end).map((c) => c.text).join('\n');
    }
    if (text !== lastSub) {
      lastSub = text;
      subsEl.innerHTML = text ? `<span>${esc(text)}</span>` : '';
    }
    requestAnimationFrame(renderSubs);
  }
  requestAnimationFrame(renderSubs);

  let idleTimer;
  function wake() {
    el.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) el.classList.add('idle'); }, 3000);
  }

  const togglePlay = () => (casting ? casting.controller.playOrPause() : video.paused ? video.play() : video.pause());
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen());
  const toggleMute = () => (casting ? casting.controller.muteOrUnmute() : (video.muted = !video.muted));

  // ----- events -----
  video.addEventListener('timeupdate', () => {
    if (pendingStart != null && Math.abs(video.currentTime - pendingStart) < 5) pendingStart = null;
    renderTime(); report(false); rememberPosition(false);
  });
  video.addEventListener('durationchange', renderTime);
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; wake(); });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; el.classList.remove('idle'); report(true); rememberPosition(true); });
  video.addEventListener('waiting', () => el.classList.add('loading'));
  video.addEventListener('seeking', () => el.classList.add('loading'));
  for (const ev of ['playing', 'canplay', 'seeked']) video.addEventListener(ev, () => el.classList.remove('loading'));
  video.addEventListener('volumechange', () => {
    muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
    vol.value = video.muted ? 0 : video.volume;
    try { localStorage.setItem('vol', video.volume); localStorage.setItem('muted', video.muted ? '1' : '0'); } catch {}
  });
  video.addEventListener('ended', () => {
    // Ended well before the end: the stream broke off (e.g. the server restarted).
    if (duration() && now() < duration() - 10) return recover('dropped', `stream ended at ${fmtClock(now())} of ${fmtClock(duration())}`);
    fetch(`${base}/progress`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: duration(), duration: duration() }),
    }).catch(() => {});
    if (item.next) onPlayNext(item.next);
  });
  video.addEventListener('error', () => {
    if (destroyed || !video.getAttribute('src')) return;
    const err = video.error;
    // Direct play the browser can't decode: hand it to ffmpeg. (A network error is retried instead.)
    if (mode === 'direct' && err?.code !== MediaError.MEDIA_ERR_NETWORK && switchToTranscode(err?.message || 'media error')) return;
    if (mode === 'direct' && !item.canTranscode && err?.code !== MediaError.MEDIA_ERR_NETWORK) {
      el.classList.remove('loading');
      showMsg('This file needs transcoding, but ffmpeg is not installed on the server.');
      return;
    }
    recover('error', err?.message || `media error ${err?.code ?? ''}`.trim());
  });
  // Direct play of an MP4 with an unsupported codec sometimes "plays" with no video frames.
  video.addEventListener('loadeddata', () => {
    if (mode === 'direct' && item.video && video.videoWidth === 0) switchToTranscode('no video frames decoded');
  });

  seekBar.addEventListener('input', () => {
    dragging = true;
    timeEl.textContent = `${fmtClock((seekBar.value / 1000) * duration())} / ${fmtClock(duration())}`;
  });
  seekBar.addEventListener('change', () => {
    dragging = false;
    seek((seekBar.value / 1000) * duration());
  });
  vol.addEventListener('input', () => {
    if (casting) {
      casting.player.volumeLevel = Number(vol.value);
      casting.controller.setVolumeLevel();
      return;
    }
    video.volume = Number(vol.value);
    video.muted = video.volume === 0;
  });

  audioSel.addEventListener('change', () => {
    audioIndex = Number(audioSel.value);
    const t = now();
    if (mode !== 'hls') mode = 'transcode'; // browsers can't switch audio tracks on their own
    if (casting) {
      casting.mode = 'transcode';
      castLoad(t);
    } else load(t);
  });

  qualitySel.addEventListener('change', () => {
    quality = qualitySel.value;
    try { localStorage.setItem('quality', quality); } catch {}
    if (quality === 'original') try { localStorage.removeItem('adaptiveAt'); } catch {}
    if (casting) return; // the TV fetches from the server itself; this applies when it's back here
    if (mode === 'hls' && hlsPlayer && quality !== 'original') {
      // Already adaptive: change size at the next piece, without restarting.
      hlsPlayer.nextLevel = quality === 'auto' ? -1 : levelIndex(Number(quality));
      return renderQuality();
    }
    if (quality === 'auto') return renderQuality(); // carries on with Original until it can't keep up
    const t = now();
    mode = quality === 'original' ? naturalMode() : 'hls';
    load(t);
  });

  // Auto, playing Original: a stall that lasts (not the start, and not just a seek) means the
  // connection can't carry the file, so move to adaptive streaming.
  let waitTimer = null;
  let lastSeek = 0;
  video.addEventListener('seeking', () => { lastSeek = Date.now(); });
  video.addEventListener('waiting', () => {
    if (quality !== 'auto' || !levels.length || mode === 'hls' || casting || !hasPlayed) return;
    clearTimeout(waitTimer);
    const patience = Date.now() - lastSeek < 3000 ? 6000 : 2500;
    waitTimer = setTimeout(() => {
      if (!destroyed && mode !== 'hls' && !video.paused && video.readyState < 3) goAdaptive('stalled on Original');
    }, patience);
  });
  video.addEventListener('playing', () => { hasPlayed = true; clearTimeout(waitTimer); });

  // Auto, adaptive, and the connection has been fast enough for Original for a minute (and it's
  // been adaptive for at least five): go back to Original. Also saves the speed for next time.
  let fastChecks = 0;
  const speedTimer = setInterval(() => {
    if (!hlsPlayer || mode !== 'hls') return;
    const bw = hlsPlayer.bandwidthEstimate;
    try { localStorage.setItem('bandwidth', String(Math.round(bw))); } catch {}
    if (quality !== 'auto' || !item.bitrate || video.paused) { fastChecks = 0; return; }
    fastChecks = bw > item.bitrate * 2.5 ? fastChecks + 1 : 0;
    if (fastChecks >= 6 && Date.now() - adaptiveSince > 5 * 60e3) {
      fastChecks = 0;
      try { localStorage.removeItem('adaptiveAt'); } catch {}
      const t = now();
      mode = naturalMode();
      load(t);
    }
  }, 10000);

  subSel.addEventListener('change', async () => {
    cues = [];
    try { localStorage.setItem('subsOn', subSel.value ? '1' : '0'); } catch {}
    if (!subSel.value) return;
    const res = await fetch(`${base}/subtitles/${subSel.value}`);
    if (res.ok) cues = parseCues(await res.text());
  });

  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') onBack();
    else if (act === 'play') togglePlay();
    else if (act === 'rew') seek(now() - 10);
    else if (act === 'fwd') seek(now() + 10);
    else if (act === 'mute') toggleMute();
    else if (act === 'fs') toggleFs();
    else if (e.target === video) togglePlay();
  });
  video.addEventListener('dblclick', toggleFs);
  el.addEventListener('mousemove', wake);

  function onKey(e) {
    if (e.target.matches('input, select')) return;
    const keys = {
      ' ': togglePlay, k: togglePlay,
      ArrowLeft: () => seek(now() - 10), ArrowRight: () => seek(now() + 10),
      j: () => seek(now() - 10), l: () => seek(now() + 10),
      ArrowUp: () => { video.volume = Math.min(1, video.volume + 0.1); },
      ArrowDown: () => { video.volume = Math.max(0, video.volume - 0.1); },
      f: toggleFs, m: toggleMute,
      Escape: () => { if (!document.fullscreenElement) onBack(); },
    };
    const fn = keys[e.key];
    if (fn) { e.preventDefault(); fn(); wake(); }
  }
  document.addEventListener('keydown', onKey);
  // Save the position when the page goes away. pagehide and visibilitychange are what mobile
  // browsers reliably fire (beforeunload often isn't).
  const onUnload = () => { report('beacon'); rememberPosition(true); };
  const onHidden = () => { if (document.visibilityState === 'hidden') onUnload(); };
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('pagehide', onUnload);
  document.addEventListener('visibilitychange', onHidden);


  // ----- Chromecast -----
  // The Cast button appears in Chrome/Edge when there's a Chromecast on the network. Casting hands
  // the TV a signed link to this video (POST /api/cast/link), stops playing here, and turns these
  // controls into a remote. Progress is still recorded from here. Ending the cast resumes here
  // at the same point. Leaving the player keeps the TV playing; the next episode keeps casting.
  const castSlot = el.querySelector('[data-cast]');
  const castMsg = el.querySelector('.cast-msg');
  let castContext = null;
  const contentType = /webm/.test(item.container || '') ? 'video/webm' : 'video/mp4';

  async function castLoad(t) {
    const c = casting;
    const direct = c.mode === 'direct';
    c.offset = direct ? 0 : t;
    const { chrome } = window;
    const info = new chrome.cast.media.MediaInfo(direct ? `${c.url}/direct` : `${c.url}/transcode?t=${t.toFixed(2)}&audio=${audioIndex}`, direct ? contentType : 'video/mp4');
    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    if (duration()) info.duration = direct ? duration() : Math.max(1, duration() - t);
    info.metadata = Object.assign(new chrome.cast.media.GenericMediaMetadata(), {
      title: item.kind === 'episode' ? `${item.show} · ${epCode(item)}` : item.title,
      subtitle: item.kind === 'episode' ? item.title : item.channel || (item.year ? String(item.year) : ''),
    });
    const request = new chrome.cast.media.LoadRequest(info);
    request.currentTime = direct ? t : 0;
    request.autoplay = true;
    try {
      await c.session.loadMedia(request);
    } catch (err) {
      castMsg.textContent = `The Chromecast couldn’t play this (${err?.code || err}). Is it on the same network as the server?`;
    }
  }

  function castSeek(t) {
    if (casting.mode === 'direct') {
      casting.player.currentTime = t;
      casting.controller.seek();
    } else castLoad(t); // a transcode can only start from where it's asked to
    renderTime();
  }

  async function startCasting(session) {
    if (casting || destroyed) return;
    // From where it's playing here, or (nothing loaded yet: a new episode mid-cast) where it starts.
    const t = video.getAttribute('src') ? now() : (startAt > 5 ? startAt : 0);
    const res = await fetch('/api/cast/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base }) }).catch(() => null);
    if (!res?.ok || destroyed) return showMsg('Couldn’t start casting this video.');
    const { url } = await res.json();
    const { cast } = window;
    const player = new cast.framework.RemotePlayer();
    const controller = new cast.framework.RemotePlayerController(player);
    // Smaller sizes are for this device's connection; the TV gets the file itself.
    casting = { session, player, controller, url, mode: mode === 'hls' ? naturalMode() : mode, offset: 0, last: t };
    // Stop playing here (and stop the server streaming to this tab).
    video.pause();
    stopHls();
    video.removeAttribute('src');
    video.load();
    el.classList.add('casting');
    el.classList.remove('loading');
    castMsg.hidden = false;
    castMsg.textContent = `Playing on ${session.getCastDevice()?.friendlyName || 'Chromecast'}`;
    const E = cast.framework.RemotePlayerEventType;
    controller.addEventListener(E.CURRENT_TIME_CHANGED, () => {
      if (casting?.player !== player) return;
      casting.last = now();
      renderTime();
      report(false);
      rememberPosition(false);
    });
    controller.addEventListener(E.IS_PAUSED_CHANGED, () => {
      playBtn.textContent = player.isPaused ? '▶' : '❚❚';
      if (player.isPaused) report(true);
    });
    controller.addEventListener(E.VOLUME_LEVEL_CHANGED, () => { vol.value = player.volumeLevel; });
    controller.addEventListener(E.IS_MUTED_CHANGED, () => { muteBtn.textContent = player.isMuted ? '🔇' : '🔊'; });
    controller.addEventListener(E.PLAYER_STATE_CHANGED, () => {
      // Finished on the TV: count it as watched and go on to the next episode (still casting).
      if (casting?.player === player && player.playerState === 'IDLE' && duration() && casting.last > duration() - 15) {
        fetch(`${base}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: duration(), duration: duration() }) }).catch(() => {});
        if (item.next) onPlayNext(item.next);
      }
    });
    playBtn.textContent = '❚❚';
    await castLoad(t);
  }

  function stopCasting() {
    if (!casting) return;
    const t = casting.last;
    casting = null;
    el.classList.remove('casting');
    castMsg.hidden = true;
    if (!destroyed) load(t);
  }

  const onCastSession = (e) => {
    const S = window.cast.framework.SessionState;
    if (e.sessionState === S.SESSION_STARTED || e.sessionState === S.SESSION_RESUMED) startCasting(castContext.getCurrentSession());
    else if (e.sessionState === S.SESSION_ENDED) stopCasting();
  };
  castReady().then((ok) => {
    if (!ok || destroyed) return;
    castSlot.hidden = false;
    castContext = window.cast.framework.CastContext.getInstance();
    castContext.addEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastSession);
    // Already casting (e.g. the next episode started from the TV's queue): carry on there.
    if (castContext.getCurrentSession()) startCasting(castContext.getCurrentSession());
  });

  // ----- start -----
  const resume = item.progress && !item.progress.watched ? item.progress.position : 0;
  const startAt = item.startAt ?? resume;
  // (When a cast is already running, startCasting takes over from here.)
  if (!window.cast?.framework?.CastContext.getInstance().getCurrentSession()) load(startAt > 5 ? startAt : 0);
  wake();

  // Auto-enable the first subtitle track if the viewer had subtitles on last time.
  try {
    if (localStorage.getItem('subsOn') === '1' && item.subtitles.length) {
      subSel.value = item.subtitles[0].key;
      subSel.dispatchEvent(new Event('change'));
    }
  } catch {}

  return function destroy() {
    report(true);
    castContext?.removeEventListener(window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastSession);
    if (incident) closeIncident('left');
    destroyed = true;
    clearTimeout(idleTimer);
    clearTimeout(retryTimer);
    clearInterval(stallTimer);
    clearInterval(speedTimer);
    clearTimeout(waitTimer);
    stopHls();
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    window.removeEventListener('pagehide', onUnload);
    document.removeEventListener('visibilitychange', onHidden);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // Dropping the src aborts the HTTP request, which kills the server-side ffmpeg.
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
