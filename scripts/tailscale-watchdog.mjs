// Keeps this machine on the tailnet. launchd runs it every minute as root (com.deadair.tailscale,
// installed by `npm run service:install`), so a stray "Disconnect" in the Tailscale menu can't
// strand a remote server:
//
//   Stopped (someone hit Disconnect / `tailscale down`)  -> `tailscale up` (keeps all settings)
//   tailscaled not answering                             -> restart the tailscaled daemon
//   Logged out / needs approval                          -> logged only; that needs a person
//
// To disconnect on purpose for a while, create data/tailscale-hold (delete it to resume).
// `node scripts/tailscale-watchdog.mjs --check` shows what it would do, without doing it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOLD = path.join(ROOT, 'data', 'tailscale-hold');
const check = process.argv.includes('--check');

const CLI = ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find((p) => fs.existsSync(p));
const log = (msg) => console.log(`${new Date().toLocaleString('sv')} ${msg}`);
const run = (args) => spawnSync(CLI, args, { encoding: 'utf8', timeout: 20000 });

function backendState() {
  const r = run(['status', '--json']);
  try {
    return JSON.parse(r.stdout).BackendState || null;
  } catch {
    return null; // tailscaled isn't answering
  }
}

function act(what, fn) {
  if (check) return log(`[check] would ${what}`);
  log(what);
  fn();
}

if (!CLI) {
  if (check) log('tailscale CLI not found; nothing to watch');
  process.exit(0);
}
if (fs.existsSync(HOLD)) {
  if (check) log(`on hold (${HOLD} exists); leaving Tailscale alone`);
  process.exit(0);
}

const state = backendState();
if (check) log(`Tailscale state: ${state ?? 'not answering'}`);

if (state === 'Stopped') {
  act('Tailscale was disconnected; reconnecting with `tailscale up`', () => {
    const r = run(['up']);
    log(r.status === 0 ? `reconnected (now ${backendState()})` : `tailscale up failed: ${(r.stderr || r.stdout).trim()}`);
  });
} else if (state === null) {
  act('tailscaled is not answering; restarting it', () => {
    // `brew services` names it sh.brew.tailscale (homebrew.mxcl.tailscale on older Homebrew); `tailscaled install-system-daemon` uses com.tailscale.tailscaled.
    const label = ['sh.brew.tailscale', 'homebrew.mxcl.tailscale', 'com.tailscale.tailscaled'].find((l) => spawnSync('launchctl', ['print', `system/${l}`]).status === 0);
    if (!label) return log("couldn't find the tailscaled service to restart (is Tailscale the app rather than the daemon?)");
    const r = spawnSync('launchctl', ['kickstart', '-k', `system/${label}`], { encoding: 'utf8' });
    log(r.status === 0 ? `restarted tailscaled (${label})` : `couldn't restart tailscaled: ${(r.stderr || r.stdout).trim()}`);
  });
} else if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') {
  log(`Tailscale is ${state}; that needs someone to sign in or approve it in the admin console`);
}
