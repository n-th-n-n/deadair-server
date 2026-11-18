// Keeps the server on the latest pushed code: Deadair itself, and each plugin in plugins/ that is
// its own git checkout. Installed only when you run `npm run service:install` yourself
// (com.deadair.deploy, every 5 minutes, as root so it can restart the services; git and npm run
// as the folder's owner, never as root).
//
//   1. git fetch Deadair and each plugin. Nothing new on any of their branches -> stop.
//   2. Someone is watching (ffmpeg running under Deadair) -> wait, for up to 3 hours.
//   3. Fast-forward each one that has something new (never merges or overwrites local edits),
//      npm install where the dependencies changed, then npm test (Deadair's, and a plugin's own
//      tests if it has any).
//   4. Restart Deadair (and HTTPS if its files changed), check it answers and that every plugin
//      that loaded before still loads.
//   Any of that fails -> put everything back on its previous commit, restart that, and skip the
//   bad commit until a newer one is pushed.
//
// Logs to data/logs/deploy.log only when something happens; data/deploy-state.json is what
// Settings → Server shows. Pause it: touch data/deploy-hold (delete to resume).
// Remove it: npm run service:uninstall. See what it would do: node scripts/autodeploy.mjs --check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PLUGINS = path.join(ROOT, 'plugins');
const STATE_FILE = path.join(DATA, 'deploy-state.json');
const PLUGIN_STATUS = path.join(DATA, 'plugins-status.json'); // written by the server as it starts
const HOLD = path.join(DATA, 'deploy-hold');
const check = process.argv.includes('--check');
const WAIT_FOR_VIEWERS_MS = 3 * 60 * 60 * 1000;
const NPM = path.join(path.dirname(process.execPath), 'npm');

const log = (msg) => console.log(`${new Date().toLocaleString('sv')} ${msg}`);
const owner = fs.statSync(ROOT);
const isRoot = process.getuid?.() === 0;
const state = (() => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
})();
function save() {
  if (check) return;
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  if (isRoot) fs.chownSync(STATE_FILE, owner.uid, owner.gid);
}

// git and npm run as whoever owns the folder (their SSH keys / GitHub login).
function run(cmd, args, { timeout = 120000, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout, ...(isRoot ? { uid: owner.uid, gid: owner.gid } : {}),
    // No prompts: a git that wants a password or passphrase fails instead of hanging.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
  });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}
const git = (cwd, ...args) => run('git', args, { cwd });
const install = (cwd) => run(NPM, ['install', '--no-audit', '--no-fund'], { cwd, timeout: 600000 });

function launchctl(...args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout || '' };
}
const restartService = (label) => (check || !isRoot ? null : launchctl('kickstart', '-k', `system/${label}`));

// Transcodes and plugin streams are ffmpeg processes under Deadair.
function someoneWatching() {
  const pid = launchctl('print', 'system/com.deadair.server').out.match(/\bpid = (\d+)/)?.[1];
  return !!pid && spawnSync('pgrep', ['-P', pid, 'ffmpeg']).status === 0;
}

async function answers(timeoutMs = 60000) {
  const port = Number(process.env.PORT) || 8420;
  for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, 2000))) {
    const r = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
    if (r?.ok) return true;
  }
  return false;
}

// Plugins that failed to load, as the server last wrote it ({ name: error }), and when it did.
function pluginFailures() {
  try {
    const list = JSON.parse(fs.readFileSync(PLUGIN_STATUS, 'utf8'));
    return { at: fs.statSync(PLUGIN_STATUS).mtimeMs, failed: Object.fromEntries(list.filter((p) => p.error).map((p) => [p.name, p.error])) };
  } catch {
    return { at: 0, failed: {} };
  }
}

// Quiet by default (this runs every 5 minutes); --check prints the reason.
function stop(msg) {
  if (check && msg) log(msg);
  process.exit(0);
}

if (fs.existsSync(HOLD)) stop(`on hold (${HOLD} exists)`);

// Deadair, then each plugin with a .git of its own. A plugin's fetch error and skipped commit
// are kept under state.plugins[name]; Deadair's at the top level, as before plugins existed.
const parts = [{ name: 'Deadair', dir: ROOT, state }];
for (const name of fs.existsSync(PLUGINS) ? fs.readdirSync(PLUGINS).sort() : []) {
  const dir = path.join(PLUGINS, name);
  if (fs.existsSync(path.join(dir, '.git'))) parts.push({ name: `plugin ${name}`, plugin: name, dir, state: ((state.plugins ||= {})[name] ||= {}) });
}

// What's new for one part, or null when there's nothing to deploy (--check says why).
function pending(part) {
  const nothing = (msg) => {
    if (check) log(`${part.name}: ${msg}`);
    return null;
  };
  const branch = git(part.dir, 'rev-parse', '--abbrev-ref', 'HEAD').out;
  if (!branch || branch === 'HEAD') return nothing('not on a branch; leaving it alone');
  const fetched = git(part.dir, 'fetch', '--quiet', 'origin', branch);
  if (!fetched.ok) {
    if (part.state.fetchError !== fetched.err) { // log a failing fetch once, not every 5 minutes
      part.state.fetchError = fetched.err;
      save();
      log(`${part.name}: git fetch failed (this machine must be able to pull without a password): ${fetched.err}`);
    }
    return nothing(`git fetch failed: ${fetched.err}`);
  }
  if (part.state.fetchError) { delete part.state.fetchError; save(); }

  const head = git(part.dir, 'rev-parse', 'HEAD').out;
  const target = git(part.dir, 'rev-parse', `origin/${branch}`).out;
  if (head === target) return nothing(`up to date (${head.slice(0, 7)})`);
  if (!git(part.dir, 'merge-base', '--is-ancestor', head, target).ok) return nothing('this checkout has commits that aren\'t on GitHub; not deploying');
  if (part.state.skip === target) return nothing(`${target.slice(0, 7)} failed before; waiting for a newer commit`);
  const changed = git(part.dir, 'diff', '--name-only', head, target).out.split('\n').filter(Boolean);
  const subject = git(part.dir, 'log', '-1', '--format=%s', target).out;
  return { ...part, head, target, changed, subject, depsChanged: changed.some((f) => /^package(-lock)?\.json$/.test(f)) };
}

const updates = parts.map(pending).filter(Boolean);
if (!updates.length) stop();
const core = updates.find((u) => !u.plugin);
const label = (u) => `${u.name} ${u.head.slice(0, 7)} → ${u.target.slice(0, 7)} "${u.subject}"`;
const short = (u) => (u.plugin ? `${u.plugin} ${u.target.slice(0, 7)}` : u.target.slice(0, 7));
if (check) stop(`would deploy ${updates.map((u) => `${label(u)} (${u.changed.length} files)`).join('; ')}${someoneWatching() ? ', once the current playback ends' : ''}`);

// Don't cut someone off mid-film; deploy anyway after 3 hours.
const waitKey = updates.map((u) => u.target).join(',');
if (someoneWatching()) {
  if (state.waitingFor !== waitKey) {
    Object.assign(state, { waitingSince: Date.now(), waitingFor: waitKey });
    save();
    log(`${updates.map(short).join(', ')} ready; waiting for playback to finish first`);
  }
  if (Date.now() - state.waitingSince < WAIT_FOR_VIEWERS_MS) stop();
  log('still playing after 3 hours; deploying anyway');
}
delete state.waitingSince;
delete state.waitingFor;

log(`deploying ${updates.map(label).join('; ')}`);
function restart() {
  restartService('com.deadair.server');
  if (core?.changed.some((f) => f === 'scripts/https.mjs' || f.startsWith('deploy/'))) restartService('com.deadair.https');
}

// Before the restart the old code is still what's running, so only the files need putting back.
function putBack() {
  for (const u of updates.filter((x) => x.moved)) {
    git(u.dir, 'reset', '--hard', u.head);
    if (u.depsChanged) install(u.dir);
  }
}

// Put everything back and skip the commits in `culprits` until something newer is pushed.
let restarted = false;
async function rollBack(why, culprits = updates) {
  log(`${why}; going back to ${updates.map((u) => `${u.name} ${u.head.slice(0, 7)}`).join(', ')}`);
  putBack();
  if (restarted) restart();
  const back = !restarted || await answers();
  for (const u of culprits) u.state.skip = u.target;
  Object.assign(state, { lastError: { at: Date.now(), commit: culprits.map(short).join(', '), message: why } });
  save();
  log(back ? `back on the previous code; ${culprits.map(short).join(', ')} skipped until something newer is pushed`
    : '!! Deadair didn\'t come back on the previous code either. Check data/logs/server.log');
  process.exit(1);
}

for (const u of updates) {
  const ff = git(u.dir, 'merge', '--ff-only', '--quiet', u.target);
  if (!ff.ok) {
    putBack();
    log(`couldn't fast-forward ${u.name} (local edits in the way?): ${ff.err}`);
    process.exit(1);
  }
  u.moved = true;
}
for (const u of updates.filter((x) => x.depsChanged)) {
  const r = install(u.dir);
  if (!r.ok) await rollBack(`${u.name}: npm install failed: ${r.err.split('\n').slice(-2).join(' ')}`, [u]);
}

// Deadair's tests are the deploy gate. A plugin's own tests run too, when it has a test script.
const hasTests = (dir) => {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts?.test; } catch { return false; }
};
const suites = [{ name: 'Deadair', dir: ROOT, blame: core ? [core] : updates },
  ...updates.filter((u) => u.plugin && hasTests(u.dir)).map((u) => ({ name: u.name, dir: u.dir, blame: [u] }))];
for (const s of suites) {
  const tests = run(NPM, ['test'], { cwd: s.dir, timeout: 300000 });
  if (!tests.ok) {
    const failing = `${tests.out}\n${tests.err}`.split('\n').filter((l) => /^not ok/.test(l.trim())).slice(0, 3).join(' | ');
    await rollBack(`${s.name} tests failed${failing ? `: ${failing}` : ''}`, s.blame);
  }
}

const before = pluginFailures().failed;
const restartedAt = Date.now();
restart();
restarted = true;
if (!(await answers())) await rollBack('Deadair didn\'t answer within a minute of restarting');
// A plugin that loaded before and doesn't now: blame its own update, else Deadair's. Another
// plugin's update can't break it, so with neither it's not this deploy's doing. (Only checked
// when this run restarted the server, i.e. the file is from the new start.)
const after = pluginFailures();
if (after.at >= restartedAt) {
  for (const [name, error] of Object.entries(after.failed)) {
    if (name in before) continue;
    const blame = updates.find((u) => u.plugin === name) || core;
    if (blame) await rollBack(`plugin ${name} didn't load: ${error}`, [blame]);
    log(`note: plugin ${name} didn't load (${error}), and wasn't updated just now`);
  }
}

for (const u of updates) {
  Object.assign(u.state, { deployed: u.target.slice(0, 7), subject: u.subject, at: Date.now(), previous: u.head.slice(0, 7) });
  delete u.state.skip;
}
delete state.lastError;
save();
log(`deployed ${updates.map(short).join(', ')}`);
if (core?.changed.includes('scripts/service.mjs')) log('note: the boot services changed; run `npm run service:install` once to apply that part');
