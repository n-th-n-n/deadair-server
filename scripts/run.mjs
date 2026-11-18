// npm run up: the app and HTTPS together in one terminal. Ctrl+C stops both.
//   [app]    node server/index.js    Deadair on 127.0.0.1:8420
//   [https]  node scripts/https.mjs  points DNS at this machine, runs Caddy
// If HTTPS can't start (e.g. no CF_DNS_API_TOKEN), the app keeps running; if the app stops,
// HTTPS is stopped too.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const color = process.stdout.isTTY;
const label = (name, code) => (color ? `\x1b[${code}m[${name}]\x1b[0m ` : `[${name}] `);

// Same first-run setup as `npm start` (dependencies, .env).
const pre = spawnSync(process.execPath, ['scripts/preflight.mjs'], { cwd: ROOT, stdio: 'inherit' });
if (pre.status) process.exit(pre.status);

function run(name, script, code) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: process.env });
  const prefix = label(name, code);
  for (const stream of [child.stdout, child.stderr]) {
    let partial = '';
    stream.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
    stream.on('end', () => { if (partial) process.stdout.write(prefix + partial + '\n'); });
  }
  return child;
}

const app = run('app', 'server/index.js', 36);
const https = run('https', 'scripts/https.mjs', 35);
const children = [app, https];
let stopping = false;

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  const done = () => children.every((c) => c.exitCode !== null || c.signalCode !== null);
  const wait = setInterval(() => { if (done()) { clearInterval(wait); process.exit(code); } }, 100);
  setTimeout(() => process.exit(code), 5000).unref();
}

app.on('exit', (code) => {
  if (stopping) return;
  console.log(`${label('app', 36)}stopped${code ? ` (exit ${code})` : ''}; stopping HTTPS too.`);
  stopAll(code || 1);
});
https.on('exit', (code) => {
  if (stopping || !code) return;
  console.log(`${label('https', 35)}stopped. The app is still running on this machine (http://localhost:${process.env.PORT || 8420}), but the domain is down. Fix the error above, then restart.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));
