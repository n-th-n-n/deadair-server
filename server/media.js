const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FFMPEG, FFPROBE, run, limiter, probe } = require('./ffmpeg');
const { THUMB_DIR, SUB_CACHE_DIR } = require('./config');
const db = require('./db');
const playlog = require('./playlog');

// ---------- Is this really a video? ----------

// Items are only served once ffprobe has confirmed a video stream. Without ffprobe we
// can't inspect content, so fall back to excluding .ts (also the TypeScript extension).
function isServable(item) {
  if (FFPROBE) return !!(item.probed && item.video);
  return path.extname(item.path).toLowerCase() !== '.ts';
}

// Before sending a file's raw bytes: if it changed on disk since it was verified, verify it again.
async function verifyCurrent(item) {
  const st = await fsp.stat(item.path).catch(() => null);
  if (!st?.isFile()) return false;
  if (st.size === item.size && st.mtimeMs === item.mtime) return isServable(item);
  if (!FFPROBE) return isServable(item);
  const info = await probe(item.path).catch(() => null);
  if (!info?.video) return false;
  Object.assign(item, info, { size: st.size, mtime: st.mtimeMs, probed: true });
  db.save();
  return true;
}

// ---------- Playback decision ----------

const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// Whether a browser can play the file as-is (no ffmpeg involved).
function canDirectPlay(item) {
  const ext = path.extname(item.path).toLowerCase();
  if (!item.probed) return ['.mp4', '.m4v', '.webm'].includes(ext);
  const v = item.video;
  const a = item.audio?.[0]?.codec;
  const videoOk = !v
    || (['.mp4', '.m4v', '.mov'].includes(ext) && v.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p'))
    || (ext === '.webm' && ['vp8', 'vp9', 'av1'].includes(v.codec));
  const audioOk = !a || BROWSER_AUDIO.has(a);
  return videoOk && audioOk;
}

// ffmpeg arguments for transcode(). H.264 video is copied (cheap remux); anything else is
// re-encoded. Audio is always AAC stereo. (Smaller sizes for slow connections are in hls.js.)
function transcodeArgs(item, { start = 0, audio = 0 }) {
  const v = item.video;
  const copyVideo = v && v.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p');
  const videoArgs = copyVideo
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
       '-vf', "scale='min(1920,iw)':-2", '-g', '48'];

  return [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(start), '-i', item.path,
    '-map', '0:v:0?', '-map', `0:a:${audio}?`, '-sn', '-dn',
    ...videoArgs,
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
}

// Stream a fragmented MP4 starting at `start` seconds.
function transcode(item, opts, res) {
  const start = opts.start || 0;
  const proc = spawn(FFMPEG, transcodeArgs(item, opts), { windowsHide: true });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  proc.stdout.pipe(res);
  proc.on('error', (err) => {
    console.error('ffmpeg failed to start:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  // Browser seeks/closes -> kill the encoder so we don't leak processes. Failures are logged.
  const title = item.label || [item.show, item.title].filter(Boolean).join(' – ') || path.basename(item.path);
  playlog.watchFfmpeg(proc, res, { title, start, tag: `ffmpeg ${item.id}` });
}

// ---------- Thumbnails ----------

const thumbLimit = limiter(2);
const thumbInflight = new Map();
const thumbFailed = new Set();

async function getThumb(item) {
  const out = path.join(THUMB_DIR, `${item.id}.jpg`);
  const st = await fsp.stat(out).catch(() => null);
  if (st && st.mtimeMs >= item.mtime) return out;
  if (!FFMPEG || thumbFailed.has(item.id)) return null;
  if (thumbInflight.has(item.id)) return thumbInflight.get(item.id);

  const job = thumbLimit(async () => {
    const at = item.duration ? Math.min(item.duration * 0.15, 300) : 20;
    for (const seek of [at, 0]) {
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seek), '-i', item.path,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]);
      if (fs.existsSync(out)) return out;
    }
    thumbFailed.add(item.id);
    return null;
  }).finally(() => thumbInflight.delete(item.id));

  thumbInflight.set(item.id, job);
  return job;
}

// ---------- Subtitles ----------

const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

async function externalSubs(item) {
  const dir = path.dirname(item.path);
  const base = path.parse(item.path).name.toLowerCase();
  const files = await fsp.readdir(dir).catch(() => []);
  return files
    .filter((f) => SUB_EXT.has(path.extname(f).toLowerCase()) && f.toLowerCase().startsWith(base))
    .sort()
    .map((f) => path.join(dir, f));
}

async function listSubtitles(item) {
  const base = path.parse(item.path).name;
  const ext = (await externalSubs(item)).map((file, i) => {
    const tag = path.parse(file).name.slice(base.length).replace(/^[.\s_-]+/, '');
    return { key: `ext-${i}`, label: `${tag || 'External'} (${path.extname(file).slice(1)})` };
  });
  const emb = (item.subs || [])
    .filter((s) => TEXT_SUB_CODECS.has(s.codec))
    .map((s) => ({
      key: `emb-${s.si}`,
      label: [s.title, s.lang, s.forced && 'forced'].filter(Boolean).join(' · ') || `Track ${s.si + 1}`,
    }));
  return [...ext, ...emb];
}

function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // Lots of older .srt files are Windows-1252.
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

async function toWebVtt(input, mapArgs) {
  const { code, stdout, stderr } = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', input, ...mapArgs, '-f', 'webvtt', 'pipe:1']);
  if (code !== 0) throw new Error(stderr || 'subtitle conversion failed');
  return stdout.toString('utf8');
}

// Returns SRT or WebVTT text; the client parses either.
async function getSubtitle(item, key) {
  const [kind, n] = key.split('-');
  const idx = Number(n);
  if (kind === 'ext') {
    const file = (await externalSubs(item))[idx];
    if (!file) return null;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.srt' || ext === '.vtt') return decodeText(await fsp.readFile(file));
    if (!FFMPEG) return null;
    return toWebVtt(file, []);
  }
  if (kind === 'emb' && FFMPEG && (item.subs || []).some((s) => s.si === idx)) {
    const cache = path.join(SUB_CACHE_DIR, `${item.id}-${idx}-${Math.round(item.mtime)}.vtt`);
    const cached = await fsp.readFile(cache, 'utf8').catch(() => null);
    if (cached != null) return cached;
    const text = await toWebVtt(item.path, ['-map', `0:s:${idx}`]);
    await fsp.writeFile(cache, text);
    return text;
  }
  return null;
}

module.exports = { isServable, verifyCurrent, canDirectPlay, transcode, transcodeArgs, getThumb, listSubtitles, getSubtitle };
