// Playback problems, from both ends, so a dropout can be matched to its cause:
//  - players report streams that errored, dropped or stalled, and whether reconnecting fixed it
//  - ffmpeg exiting with an error (with the end of what it printed)
//  - the server stopping while streams were playing, and starting again
// The last MAX entries, kept locally in data/db.json (not synced to D1). Shown in Settings.
const db = require('./db');

const MAX = 300;
let active = 0; // streams being served right now (transcodes and plugin streams)

function add(entry) {
  const log = (db.state.playbackLog ||= []);
  log.unshift({ at: Date.now(), ...entry });
  if (log.length > MAX) log.length = MAX;
  db.save();
  const { source, what, outcome, title, message } = entry;
  console.warn(`[playback] ${[source, what, outcome, title && `"${title}"`, message && message.split('\n').pop()].filter(Boolean).join(' · ')}`);
}

// Count a stream from start to end (call the returned function once it's over).
function streamStarted() {
  active++;
  let open = true;
  return () => { if (open) { open = false; active--; } };
}

// Watch an ffmpeg process serving a player: count it as an active stream, kill it when the viewer
// goes, and record it when ffmpeg fails on its own (not when we killed it).
function watchFfmpeg(proc, res, { title, start = 0, tag = 'ffmpeg' }) {
  const ended = streamStarted();
  let closedByViewer = false;
  let tail = '';
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.warn(`[${tag}] ${msg}`);
    tail = (tail + d).slice(-2000);
  });
  res.on('close', () => {
    closedByViewer = true;
    ended();
    proc.kill('SIGKILL');
  });
  proc.on('close', (code) => {
    ended();
    if (closedByViewer || !code) return;
    const lines = tail.trim().split('\n').filter(Boolean).slice(-6).join('\n');
    add({ source: 'ffmpeg', what: 'exit', title, position: Math.round(start), message: `ffmpeg exited with code ${code}${lines ? `\n${lines}` : ''}` });
  });
}

const list = () => db.state.playbackLog || [];
function clear() {
  db.state.playbackLog = [];
  db.save();
}

module.exports = { add, list, clear, streamStarted, watchFfmpeg, active: () => active };
