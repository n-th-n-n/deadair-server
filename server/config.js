const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Optional .env next to package.json (KEY=value lines). Real env vars take precedence.
if (typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(ROOT, '.env'))) {
  process.loadEnvFile(path.join(ROOT, '.env'));
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

const config = {
  ROOT,
  DATA_DIR,
  THUMB_DIR: path.join(DATA_DIR, 'thumbs'),
  SUB_CACHE_DIR: path.join(DATA_DIR, 'subs'),
  IMAGE_DIR: path.join(DATA_DIR, 'images'),
  PORT: Number(process.env.PORT) || 8420,
  // Only this machine by default; other devices come in through Caddy on the Tailscale address.
  HOST: process.env.HOST || '127.0.0.1',
  // Minutes between automatic library rescans (0 disables).
  SCAN_INTERVAL_MIN: process.env.SCAN_INTERVAL_MIN != null ? Number(process.env.SCAN_INTERVAL_MIN) : 60,
};

for (const dir of [config.DATA_DIR, config.THUMB_DIR, config.SUB_CACHE_DIR, config.IMAGE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = config;
