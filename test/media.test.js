// What ffmpeg is asked to do for a transcode, and the sizes adaptive streaming offers.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'deadair-test-data'); // media.js pulls in config
const { transcodeArgs } = require('../server/media');
const hls = require('../server/hls');
const { FFMPEG } = require('../server/ffmpeg');

const h264 = { path: '/L/Blue Jasmine (2013).mp4', video: { codec: 'h264', pixFmt: 'yuv420p' } };
const hevc = { path: '/L/Film.mkv', video: { codec: 'hevc', pixFmt: 'yuv420p10le' } };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('H.264 is copied, not re-encoded', () => {
  const args = transcodeArgs(h264, { start: 60 });
  assert.equal(after(args, '-c:v'), 'copy');
  assert.equal(after(args, '-ss'), '60');
});

test('other codecs are re-encoded at up to 1080p', () => {
  const args = transcodeArgs(hevc, {});
  assert.equal(after(args, '-c:v'), 'libx264');
  assert.match(after(args, '-vf'), /1920/);
});

// Real files from the library.
const blueJasmine = { title: 'Blue Jasmine', path: '/L/bj.mp4', duration: 5905.984, bitrate: 2095340, video: { width: 1920, height: 800 } };
const uhd = { title: '4K', path: '/L/4k.mkv', duration: 7200, bitrate: 40e6, video: { width: 3840, height: 1608 } };
const sd = { title: 'SD', path: '/L/sd.avi', duration: 1300, bitrate: 1.2e6, video: { width: 720, height: 480 } };
const heights = (item) => hls.levelsFor(item).map((l) => l.height);

test('adaptive sizes are smaller than the file, and lighter', { skip: !FFMPEG && 'no ffmpeg' }, () => {
  assert.deepEqual(heights(blueJasmine), [720, 480, 360]); // 1920×800 is no taller than 1080
  assert.deepEqual(heights(uhd), [1080, 720, 480, 360]);
  assert.deepEqual(heights(sd), [360]);
  const kbps = hls.levelsFor(blueJasmine).map((l) => l.video);
  assert.ok(kbps[0] < (blueJasmine.bitrate / 1000) * 0.65, 'the biggest step down is well under the original');
  assert.deepEqual([...kbps].sort((a, b) => b - a), kbps, 'each step is lighter than the one above');
});

test('playlists cover the whole film in 6-second pieces', { skip: !FFMPEG && 'no ffmpeg' }, () => {
  const master = hls.masterPlaylist(blueJasmine, 1);
  assert.match(master, /RESOLUTION=1280x534/);
  assert.match(master, /^720\/index\.m3u8\?audio=1$/m);
  const media = hls.mediaPlaylist(blueJasmine, 0).split('\n');
  assert.equal(media.filter((l) => l.endsWith('.ts?audio=0')).length, Math.ceil(5905.984 / 6));
  assert.ok(media.includes('#EXTINF:1.984,'), 'the last piece is only what is left');
  assert.ok(media.includes('#EXT-X-ENDLIST'));
});

test('each piece starts at its own place on the film\'s clock', () => {
  const level = { height: 480, width: 854, video: 750, audio: 96 };
  const args = hls.segmentArgs(blueJasmine, level, 10, 1);
  assert.equal(after(args, '-ss'), '60');
  assert.equal(after(args, '-output_ts_offset'), '60');
  assert.equal(after(args, '-t'), String(hls.SEGMENT));
  assert.equal(after(args, '-maxrate'), '750k');
  assert.ok(args.includes('0:a:1?'), 'keeps the chosen audio track');
});
