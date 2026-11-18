// Chromecast support. A Chromecast fetches the video itself, but it can't use Tailscale and has no
// Deadair login, so it gets its own way in:
//
//   - CAST_DOMAIN (cast.<your domain>) points at this machine's HOME-NETWORK address
//     (scripts/https.mjs keeps the DNS record current), and Caddy serves it only to devices on
//     your home network or tailnet, and only for /cast/… (deploy/Caddyfile).
//   - Every /cast/ link carries a signed token naming one video, the account that started the
//     cast, and an expiry (12 hours). Nothing else can be fetched through it.
//
// The sender (the player in Chrome) asks for a link with POST /api/cast/link, hands it to the
// Chromecast, and keeps controlling playback and recording progress itself.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const DOMAIN = process.env.CAST_DOMAIN || `cast.${process.env.DEADAIR_DOMAIN || 'deadair.example.com'}`;
const LIFETIME_MS = 12 * 60 * 60 * 1000;

const SECRET_FILE = path.join(config.DATA_DIR, 'cast-secret');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const mac = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

// { kind: 'item' | 'yt' | a plugin's kind, id, userId } -> "<payload>.<signature>"
function sign({ kind, id, userId }) {
  const payload = Buffer.from(JSON.stringify({ k: kind, i: id, u: userId, e: Date.now() + LIFETIME_MS })).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

function verify(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return t.e > Date.now() ? { kind: t.k, id: t.i, userId: t.u } : null;
  } catch {
    return null;
  }
}

const linkFor = (target) => `https://${DOMAIN}/cast/${sign(target)}`;

module.exports = { DOMAIN, linkFor, verify };
