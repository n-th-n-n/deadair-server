// Live TV: one lineup of library channels (channels.js) and outside channels (sources.js), its
// guide, the streams, and the M3U playlist + XMLTV guide that IPTV apps read.
//
// Streams:
//  - Browser, library channel: no special stream. The player plays the scheduled file with the
//    normal direct/transcode endpoints from the right offset, then asks what's on next.
//  - Browser, outside channel: ffmpeg re-packages it as fragmented MP4 (H.264 copied when it
//    can be, AAC audio), like transcoding a file.
//  - IPTV apps: one endless MPEG-TS per channel. For a library channel, each program is its own
//    ffmpeg run, all written into the same response with continuous timestamps
//    (-output_ts_offset), so the app sees a single broadcast. Outside channels are remuxed as-is.
const { spawn } = require('node:child_process');
const { FFMPEG, FFPROBE } = require('./ffmpeg');
const channels = require('./channels');
const sources = require('./sources');

// ---------- lineup & guide ----------

const libraryEntry = (ch) => ({ id: ch.id, kind: 'library', number: ch.number, name: ch.name, logo: null, group: 'Deadair', ch });

function lineup() {
  return [...channels.list().map(libraryEntry), ...sources.lineup()].sort(channels.byNumber);
}

const find = (id) => lineup().find((e) => e.id === id) || null;
const publicView = ({ id, kind, number, name, logo, group }) => ({ id, kind, number, name, logo, group });

function programsOf(entry, from, to) {
  return entry.kind === 'library' ? channels.programs(entry.ch, from, to) : sources.programs(entry.src.id, entry.ch.key, from, to);
}

function guide(from, to) {
  const entries = lineup();
  return {
    from,
    to,
    channels: entries.map(publicView),
    programs: Object.fromEntries(entries.map((e) => [e.id, programsOf(e, from, to)])),
  };
}

// What's on now and next, and how the browser should play it.
function tune(entry) {
  const now = Date.now();
  if (entry.kind === 'library') {
    const air = channels.onAir(entry.ch, now);
    if (!air) return { channel: publicView(entry), now: null, next: null, play: null };
    const { item } = air;
    const defaultAudio = item.audio?.find((a) => a.default)?.ai ?? 0;
    return {
      channel: publicView(entry),
      now: channels.describe(air.slot),
      next: air.next ? channels.describe(air.next) : null,
      play: { itemId: item.id, offset: (now - air.slot.start) / 1000, duration: item.duration, audio: defaultAudio },
    };
  }
  const [cur, next] = sources.programs(entry.src.id, entry.ch.key, now, now + 12 * 3600e3);
  return {
    channel: publicView(entry),
    now: cur && cur.start <= now ? cur : null,
    next: cur && cur.start > now ? cur : next || null,
    play: { stream: `/api/live/channels/${encodeURIComponent(entry.id)}/stream` },
  };
}

// ---------- ffmpeg ----------

function inputArgs(ch) {
  const args = [];
  if (/^https?:/i.test(ch.url)) {
    args.push('-user_agent', ch.userAgent || 'Deadair/1.0');
    if (ch.referer) args.push('-headers', `Referer: ${ch.referer}\r\n`);
    // Tuners and plain HTTP streams drop now and then; pick up again instead of ending.
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push('-rw_timeout', '15000000');
  return args;
}

function pipe(args, res, label, contentType) {
  const proc = spawn(FFMPEG, args, { windowsHide: true });
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  proc.stdout.pipe(res);
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.warn(`[live ${label}] ${msg}`);
  });
  proc.on('error', (err) => {
    console.error('ffmpeg failed to start:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  res.on('close', () => proc.kill('SIGKILL'));
  return proc;
}

// Codecs of an outside channel, so the browser stream copies H.264 instead of re-encoding.
const probes = new Map(); // channel id -> { at, video }
function probeStream(entry) {
  const hit = probes.get(entry.id);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return Promise.resolve(hit.video);
  if (!FFPROBE) return Promise.resolve(null);
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE, ['-v', 'error', ...inputArgs(entry.ch), '-analyzeduration', '4000000',
      '-print_format', 'json', '-show_streams', '-select_streams', 'v', entry.ch.url], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      clearTimeout(timer);
      let video = null;
      try {
        // HLS lists every quality; ffmpeg plays the biggest, so judge by that one.
        const streams = JSON.parse(out).streams || [];
        const v = streams.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (v) video = { codec: v.codec_name, pixFmt: v.pix_fmt, interlaced: !!v.field_order && v.field_order !== 'progressive' };
      } catch {}
      if (video) probes.set(entry.id, { at: Date.now(), video });
      resolve(video);
    });
  });
}

// Browser: an outside channel as fragmented MP4.
async function streamBrowser(entry, res) {
  const v = await probeStream(entry);
  if (res.destroyed) return;
  const copy = v && v.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p') && !v.interlaced;
  // Broadcast TV is often interlaced MPEG-2 (US antenna channels); deinterlace when re-encoding.
  const video = copy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
       '-vf', "yadif=deint=interlaced,scale='min(1920,iw)':-2", '-g', '48'];
  pipe([
    '-hide_banner', '-loglevel', 'error', ...inputArgs(entry.ch), '-i', entry.ch.url,
    '-sn', '-dn', ...video, '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
  ], res, entry.name, 'video/mp4');
}

// One program of a library channel as MPEG-TS, starting `start` seconds in, with timestamps
// continuing from `tsOffset`. Every program comes out as H.264 + stereo AAC so they join up.
function programArgs(item, { start, tsOffset, burst }) {
  const v = item.video;
  const copy = v?.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p');
  const audio = item.audio?.length ? item.audio.find((a) => a.default)?.ai ?? 0 : null;
  return [
    '-hide_banner', '-loglevel', 'error',
    // Real time, like a broadcast. The first program gets a head start so the app can fill its
    // buffer; later ones a second, to make up for starting ffmpeg between programs.
    '-readrate', '1', '-readrate_initial_burst', burst ? '8' : '1',
    // Audio starts at the same keyframe as the copied video, so a stream never opens without audio.
    '-noaccurate_seek', '-ss', start.toFixed(2), '-i', item.path,
    ...(audio == null ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest'] : []),
    '-map', '0:v:0', '-map', audio == null ? '1:a:0' : `0:a:${audio}`, '-sn', '-dn',
    ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2", '-g', '48']),
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k',
    '-output_ts_offset', tsOffset.toFixed(3),
    // Each program restarts the MPEG-TS packet counters; flag that as intended, not as corruption.
    '-mpegts_flags', '+initial_discontinuity',
    '-f', 'mpegts', 'pipe:1',
  ];
}

// IPTV apps: a library channel as one endless MPEG-TS, program after program.
function streamLibraryTs(entry, res) {
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  let proc = null;
  let closed = false;
  // Stream clock, in seconds. It starts at 60, not 0: joining mid-program with copied video
  // starts at the keyframe before that point, and those frames get timestamps before the
  // offset. Below zero, ffmpeg would shift the whole program later and it would overlap the next.
  let elapsed = 60;
  let last = null; // slot just played
  let failures = 0;
  // Gap between programs, so decode timestamps keep increasing: a program's first frames decode
  // slightly before it starts (B-frames, AAC priming).
  const GAP = 0.1;
  res.on('close', () => {
    closed = true;
    proc?.kill('SIGKILL');
  });

  const playNext = (finished) => {
    if (closed) return;
    const now = Date.now();
    let air = channels.onAir(entry.ch, now);
    // The stream runs ahead of the clock (head starts), so when a program ends (or fails to play)
    // the clock may still be inside it: go on to the next program rather than repeat it. If the
    // stream fell behind instead (the app paused), join whatever is on now.
    if (last && (finished || failures) && (!air || air.slot.start <= last.start)) air = channels.onAir(entry.ch, last.end);
    if (!air || failures > 5) return res.end();
    const start = Math.max(0, (Math.max(now, air.slot.start) - air.slot.start) / 1000);
    const length = Math.max(0, air.item.duration - start);
    const burst = !last;
    const started = Date.now();
    proc = spawn(FFMPEG, programArgs(air.item, { start, tsOffset: elapsed, burst }), { windowsHide: true });
    last = air.slot;
    proc.stdout.pipe(res, { end: false });
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[live ${entry.name}] ${msg}`);
    });
    proc.on('error', (err) => {
      console.error('ffmpeg failed to start:', err.message);
      res.end();
    });
    proc.on('close', (code) => {
      proc = null;
      const failed = code && Date.now() - started < 5000;
      failures = failed ? failures + 1 : 0;
      if (!failed) elapsed += length + GAP;
      playNext(code === 0);
    });
  };
  playNext(false);
}

// IPTV apps: an outside channel, remuxed without re-encoding.
function streamExternalTs(entry, res) {
  pipe(['-hide_banner', '-loglevel', 'error', ...inputArgs(entry.ch), '-i', entry.ch.url,
    '-c', 'copy', '-sn', '-dn', '-f', 'mpegts', 'pipe:1'], res, entry.name, 'video/mp2t');
}

// ---------- M3U + XMLTV for IPTV apps ----------

const attr = (s) => String(s ?? '').replace(/["\r\n]/g, "'");
const xml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const xmltvTime = (ms) => `${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;

// `base` is where the app reaches Deadair, e.g. https://deadair.example.dev/iptv/<token>.
function m3u(base) {
  const lines = [`#EXTM3U url-tvg="${attr(`${base}/epg.xml`)}" x-tvg-url="${attr(`${base}/epg.xml`)}"`];
  for (const e of lineup()) {
    lines.push(`#EXTINF:-1 tvg-id="${attr(e.id)}" tvg-chno="${attr(e.number)}" tvg-name="${attr(e.name)}"${e.logo ? ` tvg-logo="${attr(e.logo)}"` : ''} group-title="${attr(e.group)}",${e.name.replace(/[\r\n]/g, ' ')}`);
    // Outside channels can skip Deadair if the source says so; then the app needs the source's headers.
    if (e.kind === 'external' && !e.src.proxy) {
      if (e.ch.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${e.ch.userAgent}`);
      if (e.ch.referer) lines.push(`#EXTVLCOPT:http-referrer=${e.ch.referer}`);
      lines.push(e.ch.url);
    } else {
      lines.push(`${base}/stream/${encodeURIComponent(e.id)}.ts`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function xmltv(base) {
  const from = Date.now() - 2 * 3600e3;
  const to = Date.now() + 3 * 24 * 3600e3;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Deadair">'];
  const entries = lineup();
  for (const e of entries) {
    out.push(`<channel id="${xml(e.id)}"><display-name>${xml(e.name)}</display-name><display-name>${xml(e.number)}</display-name>${e.logo ? `<icon src="${xml(e.logo)}"/>` : ''}</channel>`);
  }
  for (const e of entries) {
    for (const p of programsOf(e, from, to)) {
      // Library artwork is served through the same link, so the app needs nothing else.
      const icon = e.kind === 'library'
        ? (p.image || p.poster ? `${base}/img/w500${p.image || p.poster}` : p.itemId && `${base}/thumb/${p.itemId}`)
        : p.image;
      const parts = [`<title>${xml(p.title)}</title>`];
      if (p.subtitle) parts.push(`<sub-title>${xml(p.subtitle)}</sub-title>`);
      if (p.desc) parts.push(`<desc>${xml(p.desc)}</desc>`);
      if (p.year) parts.push(`<date>${p.year}</date>`);
      for (const g of p.genres || []) parts.push(`<category>${xml(g)}</category>`);
      if (p.movie) parts.push('<category>Movie</category>');
      if (icon) parts.push(`<icon src="${xml(icon)}"/>`);
      if (p.episode != null) {
        parts.push(`<episode-num system="xmltv_ns">${Math.max(0, p.season - 1)}.${p.episode - 1}.</episode-num>`);
        parts.push(`<episode-num system="onscreen">S${p.season}E${p.episode}</episode-num>`);
      } else if (p.episodeCode) {
        parts.push(`<episode-num system="onscreen">${xml(p.episodeCode)}</episode-num>`);
      }
      if (p.rating) parts.push(`<rating><value>${xml(p.rating)}</value></rating>`);
      out.push(`<programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${xml(e.id)}">${parts.join('')}</programme>`);
    }
  }
  out.push('</tv>');
  return `${out.join('\n')}\n`;
}

module.exports = { lineup, find, guide, tune, streamBrowser, streamLibraryTs, streamExternalTs, m3u, xmltv };
