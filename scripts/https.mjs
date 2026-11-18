// HTTPS for the private custom domain (npm run https):
// 1. Points the domain's DNS record at THIS machine's Tailscale address, so moving Deadair
//    to another machine needs no DNS changes by hand. Also points cast.<domain> at this
//    machine's home-network address, for Chromecasts (see server/cast.js).
// 2. Runs Caddy, which gets/renews the certificate and forwards to Deadair on port 8420.
//
//   npm run https                 update DNS if needed, then run Caddy
//   npm run https -- --dns-only   just update DNS
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const CF_API = process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4';
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const domain = process.env.DEADAIR_DOMAIN || 'deadair.example.com';
const castDomain = process.env.CAST_DOMAIN || `cast.${domain}`;
const token = process.env.CF_DNS_API_TOKEN;
if (!token) fail('Add CF_DNS_API_TOKEN to .env: a Cloudflare token from the "Edit zone DNS" template, for your domain\'s zone.');

// ---------- 1. DNS -> this machine's Tailscale IP ----------

function tailscaleIp() {
  const bins = ['tailscale', mac && '/Applications/Tailscale.app/Contents/MacOS/Tailscale', win && 'C:\\Program Files\\Tailscale\\tailscale.exe'].filter(Boolean);
  for (const bin of bins) {
    const r = spawnSync(bin, ['ip', '-4'], { encoding: 'utf8' });
    const ip = !r.error && r.status === 0 && r.stdout.trim().split('\n')[0];
    if (ip) return ip;
  }
  return null;
}

async function cf(route, init = {}) {
  const res = await fetch(CF_API + route, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  }).catch((err) => fail(`Couldn't reach Cloudflare: ${err.message}`));
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) fail(`Cloudflare ${route}: ${data?.errors?.map((e) => e.message).join('; ') || res.status}`);
  return data.result;
}

// Deadair is Tailscale-only: without a Tailscale address there's nothing to listen on.
// At boot this can start before Tailscale is up, so wait for it rather than failing.
let ip = tailscaleIp();
if (!ip) {
  console.log('Waiting for Tailscale to come up…');
  for (let i = 0; i < 60 && !ip; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    ip = tailscaleIp();
  }
}
if (!ip) fail('Tailscale isn\'t running on this machine. Install it and sign in, then run this again.');
const zoneName = domain.split('.').slice(-2).join('.');
const [zone] = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
if (!zone) fail(`The token can't see the ${zoneName} zone.`);

async function pointAt(name, address) {
  const [record] = await cf(`/zones/${zone.id}/dns_records?type=A&name=${encodeURIComponent(name)}`);
  const body = JSON.stringify({ type: 'A', name, content: address, ttl: 1, proxied: false });
  if (!record) {
    await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body });
    console.log(`✓ ${name} → ${address} (created DNS record)`);
  } else if (record.content !== address || record.proxied) {
    await cf(`/zones/${zone.id}/dns_records/${record.id}`, { method: 'PATCH', body });
    console.log(`✓ ${name} → ${address} (was ${record.content}; can take a minute to reach every device)`);
  } else {
    console.log(`✓ ${name} already points at this machine (${address})`);
  }
}
await pointAt(domain, ip);

// This machine's address on the home network (Wi-Fi or Ethernet), for Chromecasts.
function homeIp() {
  const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const nets = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((n) => ({ name, ...n })))
    .filter((n) => n.family === 'IPv4' && !n.internal && isPrivate(n.address));
  // en0/en1 (built-in Ethernet / Wi-Fi) before VPNs, bridges and VMs.
  return (nets.find((n) => /^en\d$/.test(n.name)) || nets[0])?.address || null;
}
const lan = homeIp();
if (lan) await pointAt(castDomain, lan);
else console.log(`! No home-network address found, so ${castDomain} wasn't updated (casting needs this machine on the same network as the Chromecast)`);

if (process.argv.includes('--dns-only')) process.exit(0);

// ---------- 2. Caddy ----------

const caddy = spawnSync('caddy', ['list-modules'], { encoding: 'utf8' });
if (caddy.error || caddy.status !== 0) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const dest = mac && fs.existsSync('/opt/homebrew/bin') ? '/opt/homebrew/bin/caddy' : '/usr/local/bin/caddy';
  fail(`Caddy isn't installed. Get a build with the Cloudflare module:\n  ${mac
    ? `curl -Lo ${dest} "https://caddyserver.com/api/download?os=darwin&arch=${arch}&p=github.com%2Fcaddy-dns%2Fcloudflare" && chmod +x ${dest}`
    : 'https://caddyserver.com/download → tick caddy-dns/cloudflare → put caddy on your PATH'}`);
}
if (!caddy.stdout.includes('dns.providers.cloudflare')) fail('This Caddy build has no Cloudflare DNS module; download one from caddyserver.com/download with caddy-dns/cloudflare ticked.');

const child = spawn('caddy', ['run', '--config', path.join('deploy', 'Caddyfile'), '--envfile', '.env'], {
  cwd: ROOT,
  env: { ...process.env, CAST_DOMAIN: castDomain },
  stdio: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
