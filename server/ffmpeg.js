const { spawn, spawnSync } = require('node:child_process');

// Resolve ffmpeg/ffprobe: explicit env var first, then whatever is on PATH.
function resolveBin(name, envVar) {
  const candidate = process.env[envVar] || name;
  const r = spawnSync(candidate, ['-version'], { windowsHide: true });
  return !r.error && r.status === 0 ? candidate : null;
}

const FFMPEG = resolveBin('ffmpeg', 'FFMPEG_PATH');
const FFPROBE = resolveBin('ffprobe', 'FFPROBE_PATH');

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    const out = [];
    let stderr = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
  });
}

function limiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function probe(file) {
  if (!FFPROBE) return null;
  const { code, stdout, stderr } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `ffprobe exited ${code}`);
  const data = JSON.parse(stdout.toString('utf8'));
  const streams = data.streams || [];
  const tags = (s) => s.tags || {};

  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  return {
    duration: Number(data.format?.duration) || Number(v?.duration) || 0,
    container: data.format?.format_name || '',
    bitrate: Number(data.format?.bit_rate) || 0,
    video: v ? {
      codec: v.codec_name,
      profile: v.profile,
      pixFmt: v.pix_fmt,
      width: v.width,
      height: v.height,
      colorTransfer: v.color_transfer,
      dolbyVision: (v.side_data_list || []).some((d) => /dovi/i.test(d.side_data_type || '')) || undefined,
    } : null,
    audio: streams.filter((s) => s.codec_type === 'audio').map((s, ai) => ({
      ai,
      codec: s.codec_name,
      channels: s.channels,
      lang: tags(s).language,
      title: tags(s).title,
      default: !!s.disposition?.default,
    })),
    subs: streams.filter((s) => s.codec_type === 'subtitle').map((s, si) => ({
      si,
      codec: s.codec_name,
      lang: tags(s).language,
      title: tags(s).title,
      forced: !!s.disposition?.forced,
    })),
  };
}

// Bump when probe() records something new, so the next scan re-probes files probed before.
const PROBE_VERSION = 2; // 2: HDR / Dolby Vision

module.exports = { FFMPEG, FFPROBE, PROBE_VERSION, run, limiter, probe };
