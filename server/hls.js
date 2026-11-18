// Adaptive streaming (HLS) for slow or faraway connections: the film is offered at a few smaller
// sizes, cut into SEGMENT-second pieces, and the player (hls.js) times each piece's download and
// moves up or down a size at the next piece, without restarting. Pieces are made on demand: each
// one is its own short ffmpeg run starting at a keyframe, with timestamps on the film's own clock,
// so pieces of different sizes line up and can be mixed freely. An M4 makes a 6-second piece in
// well under a second at any of these sizes.
const { spawn } = require('node:child_process');
const { FFMPEG, limiter } = require('./ffmpeg');
const playlog = require('./playlog');

const SEGMENT = 6;

// Largest picture, video bitrate cap and audio bitrate for each size (kbit/s).
const LADDER = [
  { height: 1080, width: 1920, video: 4000, audio: 128 },
  { height: 720, width: 1280, video: 1500, audio: 128 },
  { height: 480, width: 854, video: 750, audio: 96 },
  { height: 360, width: 640, video: 400, audio: 64 },
];

// The sizes worth offering for a file: smaller than it in both directions (so a 1920×800 film
// gets 720p and below, a 3840×1608 one 1080p too), each capped at 60% of the file's own video
// bitrate, so every step down really is lighter than the original.
function levelsFor(item) {
  const v = item.video;
  if (!FFMPEG || !v?.width || !v?.height || !item.duration) return [];
  const sourceVideo = item.bitrate ? item.bitrate / 1000 - 192 : Infinity;
  const levels = [];
  for (const rung of LADDER) {
    if (rung.width >= v.width || rung.height >= v.height) continue;
    const video = Math.round(Math.min(rung.video, sourceVideo * 0.6));
    if (video < 250) continue;
    if (levels.length && video >= levels[levels.length - 1].video) continue;
    levels.push({ ...rung, video });
  }
  return levels;
}

// What the player shows in its quality menu.
const describe = (levels) => levels.map((l) => ({ height: l.height, kbps: l.video + l.audio }));

// The picture size ffmpeg's scale filter will produce: the film shrunk to fit inside the level.
function pictureSize(item, l) {
  const { width, height } = item.video;
  const scale = Math.min(1, l.width / width, l.height / height);
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return `${even(width * scale)}x${even(height * scale)}`;
}

function masterPlaylist(item, audio) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const l of levelsFor(item)) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round((l.video + l.audio) * 1100)},RESOLUTION=${pictureSize(item, l)},CODECS="avc1.640028,mp4a.40.2"`,
      `${l.height}/index.m3u8?audio=${audio}`);
  }
  return lines.join('\n') + '\n';
}

function mediaPlaylist(item, audio) {
  const count = Math.ceil(item.duration / SEGMENT);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEGMENT}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let n = 0; n < count; n++) {
    const len = Math.min(SEGMENT, item.duration - n * SEGMENT);
    lines.push(`#EXTINF:${len.toFixed(3)},`, `${n}.ts?audio=${audio}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function segmentArgs(item, level, n, audio) {
  const start = n * SEGMENT;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-i', item.path, '-t', String(SEGMENT),
    '-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn', '-dn',
    '-c:v', 'libx264', '-preset', level.height >= 1080 ? 'veryfast' : 'faster', '-profile:v', 'high', '-level:v', '4.0',
    '-crf', '23', '-maxrate', `${level.video}k`, '-bufsize', `${level.video}k`, '-pix_fmt', 'yuv420p',
    '-g', '48', '-sc_threshold', '0',
    '-vf', `scale='min(${level.width},iw)':'min(${level.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:a', 'aac', '-ac', '2', '-b:a', `${level.audio}k`,
    // On the film's clock (not starting at 0), so every piece knows where it belongs.
    '-output_ts_offset', String(start), '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', 'pipe:1',
  ];
}

// A few pieces at a time across all viewers; hls.js asks for one at a time per viewer.
const segmentLimit = limiter(4);

// Make piece `n` and send it whole (so a failure is a clean 500 that hls.js retries).
function sendSegment(item, height, n, audio, res) {
  const level = levelsFor(item).find((l) => l.height === height);
  if (!level || !(n >= 0 && n * SEGMENT < item.duration)) return res.status(404).end();
  let gone = false;
  res.on('close', () => { gone = true; });
  return segmentLimit(() => new Promise((resolve) => {
    if (gone) return resolve(); // the player moved on while this piece was queued
    const proc = spawn(FFMPEG, segmentArgs(item, level, n, audio), { windowsHide: true });
    const out = [];
    let stderr = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    res.on('close', () => proc.kill('SIGKILL')); // hls.js cancels pieces when it changes size
    proc.on('error', () => { if (!gone) res.status(500).end(); resolve(); });
    proc.on('close', (code) => {
      resolve();
      if (gone) return;
      if (code) {
        const lines = stderr.trim().split('\n').filter(Boolean).slice(-6).join('\n');
        playlog.add({ source: 'ffmpeg', what: 'exit', title: item.title, position: n * SEGMENT, message: `HLS ${height}p piece ${n}: ffmpeg exited with code ${code}${lines ? `\n${lines}` : ''}` });
        return res.status(500).end();
      }
      res.type('video/mp2t').set('Cache-Control', 'no-store').send(Buffer.concat(out));
    });
  }));
}

module.exports = { SEGMENT, levelsFor, describe, masterPlaylist, mediaPlaylist, segmentArgs, sendSegment };
