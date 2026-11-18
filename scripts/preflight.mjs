// Runs automatically before `npm start` (the "prestart" script), so a copy of this folder
// dropped onto a new machine sets itself up: checks Node, installs dependencies, creates
// .env from .env.example, and says exactly what (if anything) still needs doing.
// Uses only Node built-ins, since dependencies may not be installed yet.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const todo = [];

// Node 22.18+ is needed to load the vendored auth-core TypeScript without a build step.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`\n✗ Deadair needs Node.js 22.18 or newer (this is ${process.versions.node}).`);
  console.error(`  Install it: ${win ? 'winget install OpenJS.NodeJS.LTS' : mac ? 'brew install node' : 'https://nodejs.org'}, then open a new terminal.\n`);
  process.exit(1);
}

// Dependencies (e.g. after copying the folder without node_modules).
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) {
  console.log('Installing dependencies (first run)…');
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: win });
  if (r.status !== 0) process.exit(r.status || 1);
}

// Settings. A missing .env is recreated from the template; secrets come from `npm run setup:cloud`.
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), envFile);
  if (!win) fs.chmodSync(envFile, 0o600);
  console.log('Created .env from .env.example.');
}
const env = fs.readFileSync(envFile, 'utf8');
const has = (key) => new RegExp(`^${key}=\\S`, 'm').test(env);
if (!has('AUTH_GATEWAY_SECRET') || !has('DEADAIR_API_SECRET')) {
  todo.push('Connect this machine to Cloudflare (login + your synced data): run `npm run setup:cloud` and paste your personal Cloudflare API token.');
}

// ffmpeg is optional but most files need it.
const probe = (bin, envVar) => {
  const r = spawnSync(process.env[envVar] || bin, ['-version'], { stdio: 'ignore', shell: false });
  return !r.error && r.status === 0;
};
if (!probe('ffmpeg', 'FFMPEG_PATH') || !probe('ffprobe', 'FFPROBE_PATH')) {
  todo.push(`Install ffmpeg so most videos can play: ${win ? '`winget install Gyan.FFmpeg`, then open a new terminal' : mac ? '`brew install ffmpeg`' : 'your package manager (e.g. `sudo apt install ffmpeg`)'}.`);
}

if (todo.length) {
  console.log('\nTo finish setting up this machine:');
  for (const t of todo) console.log(`  • ${t}`);
  console.log('');
}
