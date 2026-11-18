// Run Deadair at boot on macOS, before anyone logs in, so it comes back by itself after a
// restart or power cut (alongside the tailscaled system daemon).
//
//   npm run service:install     install + start both services (asks for your password once)
//   npm run service:uninstall   stop and remove them
//   npm run service:status      is it up? plus the last log lines
//
// LaunchDaemons; the first two run as YOU (not root) and are restarted if they ever exit:
//   com.deadair.server     node server/index.js              (the app, on 127.0.0.1:8420)
//   com.deadair.https      node scripts/https.mjs            (points DNS at this machine, runs Caddy)
//   com.deadair.deploy     node scripts/autodeploy.mjs       (root, every 5 minutes: pulls new commits,
//                          tests them, restarts Deadair; rolls back if that fails)
//   com.deadair.tailscale  node scripts/tailscale-watchdog.mjs  (root, every minute: reconnects
//                          Tailscale if someone hit Disconnect, so a remote server can't get stranded)
//   com.deadair.inventory  node scripts/inventory.mjs     (you, daily at 4:30: saves each library
//                          drive's file list to D1; a missed run happens on wake)
// Logs go to data/logs/. Add --dry-run to print the plists and commands without installing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'data', 'logs');
const DAEMONS = '/Library/LaunchDaemons';
const cmd = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
if (process.platform !== 'darwin') fail('This sets up macOS LaunchDaemons. On Windows, use Task Scheduler to run `node server\\index.js` at startup.');

const user = os.userInfo().username;
if (user === 'root') fail('Run this as your normal user (it asks for sudo itself), not with sudo.');
const node = process.execPath;
const envFile = path.join(ROOT, '.env');
const hasDnsToken = fs.existsSync(envFile) && /^CF_DNS_API_TOKEN=\S/m.test(fs.readFileSync(envFile, 'utf8'));

// LaunchDaemons start with a bare PATH; give them where node, caddy, tailscale and ffmpeg live.
const PATH = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// every: seconds between runs; at: { hour, minute } once a day; neither: keep running.
function plist(label, script, log, { root = false, every = 0, at = null } = {}) {
  const schedule = at
    ? `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key><integer>${at.hour}</integer>\n    <key>Minute</key><integer>${at.minute}</integer>\n  </dict>`
    : every
      ? `  <key>StartInterval</key><integer>${every}</integer>`
      : '  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
${root ? '' : `  <key>UserName</key><string>${xml(user)}</string>\n`}  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH)}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key>${at ? '<false/>' : '<true/>'}
${schedule}
  <key>StandardOutPath</key><string>${xml(path.join(LOGS, log))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOGS, log))}</string>
</dict>
</plist>
`;
}

const services = [
  { label: 'com.deadair.server', script: 'server/index.js', log: 'server.log' },
  ...(hasDnsToken ? [{ label: 'com.deadair.https', script: 'scripts/https.mjs', log: 'https.log' }] : []),
  { label: 'com.deadair.tailscale', script: 'scripts/tailscale-watchdog.mjs', log: 'tailscale-watchdog.log', root: true, every: 60 },
  { label: 'com.deadair.deploy', script: 'scripts/autodeploy.mjs', log: 'deploy.log', root: true, every: 300 },
  { label: 'com.deadair.inventory', script: 'scripts/inventory.mjs', log: 'inventory.log', at: { hour: 4, minute: 30 } },
];
const ALL_LABELS = ['com.deadair.server', 'com.deadair.https', 'com.deadair.tailscale', 'com.deadair.deploy', 'com.deadair.inventory'];

const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function sudo(script, hint) {
  if (dryRun) {
    console.log(`\n[dry run] would run with sudo:\n${script}`);
    return;
  }
  const r = spawnSync('sudo', ['/bin/sh', '-c', script], { stdio: 'inherit' });
  if (r.status !== 0) fail(`That didn't work (see above).${hint ? `\n  ${hint}` : ''}`);
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.setTimeout(1000);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('timeout', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(false));
});

function tail(file, lines = 8) {
  if (!fs.existsSync(file)) return '  (no log yet)';
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).map((l) => `  ${l}`).join('\n');
}

if (cmd === 'install') {
  const installed = ALL_LABELS.some((l) => fs.existsSync(path.join(DAEMONS, `${l}.plist`)));
  if (!installed && !dryRun && await portOpen(8420)) {
    fail('Deadair is already running on port 8420. Stop it first (Ctrl+C in its terminal, and in the `npm run https` one), then run this again.');
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) fail('Run `npm install` (or `npm start` once) first.');
  fs.mkdirSync(LOGS, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deadair-launchd-'));
  for (const s of services) fs.writeFileSync(path.join(tmp, `${s.label}.plist`), plist(s.label, s.script, s.log, s));
  if (dryRun) for (const s of services) console.log(`\n----- ${s.label}.plist -----\n${fs.readFileSync(path.join(tmp, `${s.label}.plist`), 'utf8')}`);

  console.log(`Installing ${services.map((s) => s.label).join(' + ')} (asks for your password)…`);
  // bootout returns before the old job has fully unloaded, and bootstrapping over it fails with
  // "5: Input/output error", so wait for it to go. A job switched off (launchctl disable, or
  // "Allow in the Background" in System Settings) fails the same way, so switch it back on.
  sudo(services.map((s) => {
    const dest = `${DAEMONS}/${s.label}.plist`;
    return `( launchctl bootout system/${s.label} 2>/dev/null; `
      + `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do launchctl print system/${s.label} >/dev/null 2>&1 || break; sleep 0.5; done; `
      + [
        `cp ${sh(path.join(tmp, `${s.label}.plist`))} ${sh(dest)}`,
        `chown root:wheel ${sh(dest)}`,
        `chmod 644 ${sh(dest)}`,
        `launchctl enable system/${s.label}`,
        `launchctl bootstrap system ${sh(dest)}`,
      ].join(' && ')
      + ` || { echo "✗ ${s.label} didn't start. plutil says: $(plutil -lint ${sh(dest)})"; exit 1; } )`;
  }).join(' && '), 'If it says "5: Input/output error": System Settings → General → Login Items & Extensions → under "Allow in the Background", switch on node / deadair, then run this again.');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (dryRun) process.exit(0);

  console.log('✓ Installed. Deadair now starts at boot, before login, and restarts if it stops.');
  console.log('  Tailscale watchdog: reconnects within a minute if it\'s ever disconnected (pause: touch data/tailscale-hold).');
  console.log('  Auto-deploy: pulls, tests and restarts within 5 minutes of a push; rolls back if that fails (pause: touch data/deploy-hold).');
  console.log('  Drive inventory: saves each library drive\'s file list to D1 every day at 4:30 (log: data/logs/inventory.log).');
  if (!hasDnsToken) console.log('! No CF_DNS_API_TOKEN in .env, so HTTPS (Caddy + DNS) was not installed. Add it and run this again.');
  console.log(`  Logs: ${LOGS}`);
  console.log('  Check: npm run service:status');
} else if (cmd === 'uninstall') {
  sudo(ALL_LABELS.map((l) => `launchctl bootout system/${l} 2>/dev/null; rm -f ${DAEMONS}/${l}.plist`).join('; '));
  if (!dryRun) console.log('✓ Removed. Start it by hand again with `npm start` (and `npm run https`).');
} else if (cmd === 'status') {
  const installed = ALL_LABELS.filter((l) => fs.existsSync(path.join(DAEMONS, `${l}.plist`)));
  console.log(`Installed services: ${installed.join(', ') || 'none'}`);
  console.log(`App (127.0.0.1:8420): ${await portOpen(8420) ? 'up' : 'DOWN'}`);
  if (installed.includes('com.deadair.https')) console.log(`HTTPS (port 443): ${await portOpen(443) ? 'up' : 'DOWN'}`);
  console.log(`\nLast lines of data/logs/server.log:\n${tail(path.join(LOGS, 'server.log'))}`);
  if (installed.includes('com.deadair.https')) console.log(`\nLast lines of data/logs/https.log:\n${tail(path.join(LOGS, 'https.log'))}`);
  if (installed.includes('com.deadair.tailscale')) console.log(`\nTailscale watchdog (only logs when it acts):\n${tail(path.join(LOGS, 'tailscale-watchdog.log'))}`);
  if (installed.includes('com.deadair.deploy')) console.log(`\nAuto-deploy (only logs when it acts; pause with touch data/deploy-hold):\n${tail(path.join(LOGS, 'deploy.log'))}`);
  if (installed.includes('com.deadair.inventory')) console.log(`\nDrive inventory (daily at 4:30):\n${tail(path.join(LOGS, 'inventory.log'))}`);
} else {
  fail('Usage: npm run service:install | service:uninstall | service:status');
}
