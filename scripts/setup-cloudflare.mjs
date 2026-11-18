// One command for everything Deadair needs on Cloudflare. Safe to re-run any time,
// on any machine:
//
//   npm run setup:cloud
//
// It uses ONLY a Cloudflare API token you paste in (or pass as CLOUDFLARE_API_TOKEN).
// wrangler runs in a sealed-off home folder, so any login already on this machine
// (e.g. a work account) is invisible to it. The token is never saved.
//
// 1. Checks the token can reach the account pinned in worker/wrangler.toml
// 2. Creates the deadair-db D1 database if needed, and records its id
// 3. Applies the database migrations
// 4. Deploys deadair-api (worker/) and gives it DEADAIR_API_SECRET
// 5. Deploys auth-gateway/ and gives it AUTH_GATEWAY_SECRET
// 6. Writes both Worker URLs into .env, generating any missing secrets
// 7. Checks both Workers answer with those secrets
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'worker');
const GATEWAY = path.join(ROOT, 'auth-gateway');
const ENV_FILE = path.join(ROOT, '.env');
const DB_NAME = 'deadair-db';
const CF_API = process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4';

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ---------- .env ----------

if (!fs.existsSync(ENV_FILE)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), ENV_FILE);
  console.log('No .env found, created one from .env.example.');
}
let envText = fs.readFileSync(ENV_FILE, 'utf8');
const getEnv = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1].trim() || '';
function setEnv(key, value) {
  const line = `${key}=${value}`;
  envText = new RegExp(`^${key}=.*$`, 'm').test(envText)
    ? envText.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${envText.replace(/\n*$/, '\n')}${line}\n`;
  fs.writeFileSync(ENV_FILE, envText, { mode: 0o600 });
}
function secret(key) {
  if (!getEnv(key)) {
    setEnv(key, crypto.randomBytes(48).toString('base64url'));
    ok(`generated a new ${key} in .env`);
  }
  return getEnv(key);
}

// ---------- token ----------

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

let token = process.env.CLOUDFLARE_API_TOKEN || '';
if (!token) {
  if (!process.stdin.isTTY) fail('Set CLOUDFLARE_API_TOKEN, or run this in a terminal so it can ask for the token.');
  console.log('Paste a Cloudflare API token for your PERSONAL account (it is used for this run only, never saved).');
  console.log('Create one at dash.cloudflare.com → My Profile → API Tokens (see README → "Cloudflare token").');
  token = await askHidden('Cloudflare API token: ');
}
if (!token) fail('No token given.');

async function cf(route, { allow404 = false } = {}) {
  const res = await fetch(CF_API + route, { headers: { authorization: `Bearer ${token}` } }).catch((err) => fail(`Couldn't reach Cloudflare: ${err.message}`));
  const data = await res.json().catch(() => null);
  if (res.status === 404 && allow404) return null;
  if (!res.ok || !data?.success) fail(`Cloudflare rejected the token for ${route}: ${data?.errors?.map((e) => e.message).join('; ') || res.status}`);
  return data.result;
}

// ---------- 1. account ----------

step('Checking the token');
const toml = fs.readFileSync(path.join(WORKER, 'wrangler.toml'), 'utf8');
const accountId = toml.match(/^account_id\s*=\s*"([0-9a-f]{32})"/m)?.[1];
if (!accountId) fail('worker/wrangler.toml has no account_id. Add your Cloudflare account id.');
// Probe D1 on the pinned personal account itself. A token scoped narrowly to D1 can't list
// /accounts (that needs an account-read permission), so we check the exact thing we need
// instead: can this token use D1 on THIS account? Everything the script does targets only
// this pinned account, so a company account is never touched regardless of the token's scope.
const probe = await fetch(`${CF_API}/accounts/${accountId}/d1/database?per_page=1`, { headers: { authorization: `Bearer ${token}` } })
  .catch((err) => fail(`Couldn't reach Cloudflare: ${err.message}`));
const probeData = await probe.json().catch(() => null);
if (!probe.ok || !probeData?.success) {
  fail(`This token can't use D1 on your personal account (${accountId}): ${probeData?.errors?.map((e) => e.message).join('; ') || probe.status}.\n`
    + '  Create the token signed in to your PERSONAL Cloudflare account, with permission\n'
    + '  Account → D1 → Edit, and Account Resources → Include → that account only.');
}
ok(`token can use D1 on account ${accountId}`);

// Also confirm Workers access up front (deploying + setting secrets needs Workers Scripts: Edit),
// so a token missing it fails here instead of after the database is already created.
const wprobe = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts?per_page=1`, { headers: { authorization: `Bearer ${token}` } })
  .catch((err) => fail(`Couldn't reach Cloudflare: ${err.message}`));
if (!wprobe.ok) {
  const wdata = await wprobe.json().catch(() => null);
  fail(`This token can reach D1 but not Workers on your personal account (${accountId}): ${wdata?.errors?.map((e) => e.message).join('; ') || wprobe.status}.\n`
    + '  The token needs BOTH permissions, on your personal account only:\n'
    + '    • Account → Workers Scripts → Edit   (deploy the Workers + set their secrets)\n'
    + '    • Account → D1 → Edit                (the database)\n'
    + '  Easiest: start from the "Edit Cloudflare Workers" template (it includes Workers Scripts),\n'
    + '  then add the D1 permission, and set Account Resources → Include → your personal account.');
}
ok(`token can manage Workers on account ${accountId}`);

// wrangler runs with a throwaway home folder: it sees only this token and account, never a
// login stored on this machine. The npm cache stays shared so wrangler isn't re-downloaded.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'deadair-wrangler-'));
process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const npmCache = spawnSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim();
const wranglerEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot, // Windows needs these two to run anything
  ComSpec: process.env.ComSpec,
  HOME: SANDBOX,
  USERPROFILE: SANDBOX,
  APPDATA: path.join(SANDBOX, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(SANDBOX, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(SANDBOX, '.config'),
  npm_config_cache: npmCache || path.join(os.homedir(), '.npm'),
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CI: '1',
  WRANGLER_SEND_METRICS: 'false',
};

// Runs wrangler non-interactively in `cwd` (so that folder's wrangler.toml applies).
function wrangler(args, { cwd = WORKER, input } = {}) {
  const r = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: wranglerEnv,
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const all = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.error) fail(`Couldn't run npx wrangler: ${r.error.message}. Is Node.js installed?`);
  if (r.status !== 0) fail(`wrangler ${args.join(' ')} failed:\n${all.trim().split('\n').slice(-15).join('\n')}`);
  return { stdout: r.stdout || '', all };
}

// ---------- 2. database ----------

step(`Setting up the ${DB_NAME} database`);
const findDb = () => JSON.parse(wrangler(['d1', 'list', '--json']).stdout).find((d) => d.name === DB_NAME);
let db = findDb();
if (db) ok(`${DB_NAME} already exists`);
else {
  wrangler(['d1', 'create', DB_NAME]);
  db = findDb();
  if (!db) fail(`Created ${DB_NAME} but can't find it in \`wrangler d1 list\`.`);
  ok(`created ${DB_NAME}`);
}
const dbId = db.uuid || db.id || db.database_id;
fs.writeFileSync(path.join(WORKER, 'wrangler.toml'), toml.replace(/^database_id\s*=\s*".*"$/m, `database_id = "${dbId}"`));
ok(`recorded database id ${dbId} in worker/wrangler.toml`);

// ---------- 3. migrations ----------

step('Creating/updating the database tables');
wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote']);
ok('tables are up to date');

// ---------- 4. deadair-api ----------

const deployUrl = (out, name) => out.match(new RegExp(`https://${name}\\.[\\w-]+\\.workers\\.dev`))?.[0];

step('Deploying the deadair-api Worker');
const apiSecret = secret('DEADAIR_API_SECRET');
const apiUrl = deployUrl(wrangler(['deploy']).all, 'deadair-api');
if (!apiUrl) fail('Deployed deadair-api but couldn\'t find its workers.dev URL in the output.');
wrangler(['secret', 'put', 'API_SECRET'], { input: `${apiSecret}\n` });
setEnv('DEADAIR_API_URL', apiUrl);
ok(`deployed at ${apiUrl} and gave it DEADAIR_API_SECRET`);

// ---------- 5. auth-gateway ----------

let gatewayUrl = getEnv('AUTH_GATEWAY_URL');
if (fs.existsSync(path.join(GATEWAY, 'wrangler.toml'))) {
  step('Deploying the auth-gateway Worker');
  const gatewaySecret = secret('AUTH_GATEWAY_SECRET');
  gatewayUrl = deployUrl(wrangler(['deploy'], { cwd: GATEWAY }).all, 'auth-gateway');
  if (!gatewayUrl) fail('Deployed auth-gateway but couldn\'t find its workers.dev URL in the output.');
  wrangler(['secret', 'put', 'GATEWAY_SECRET'], { cwd: GATEWAY, input: `${gatewaySecret}\n` });
  setEnv('AUTH_GATEWAY_URL', gatewayUrl);
  ok(`deployed at ${gatewayUrl} and gave it AUTH_GATEWAY_SECRET`);
} else {
  step('Skipping auth-gateway');
  ok(`auth-gateway/ is missing; keeping AUTH_GATEWAY_URL=${gatewayUrl || '(empty)'}`);
}

// ---------- 6/7. check (self-healing) ----------

step('Checking both Workers answer');

async function tryVerify(url, key, route, body, expect) {
  // A just-set secret can take a few seconds to reach every Cloudflare location.
  for (let i = 0; i < 10; i++) {
    const res = await fetch(url + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${getEnv(key)}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res?.ok && expect(await res.json().catch(() => null))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// If the Worker doesn't accept the secret in .env (they drifted at some point), set a fresh
// secret on BOTH .env and the Worker and retry, so a mismatch fixes itself here instead of
// surfacing as a 401 at runtime that you'd have to clear by hand.
async function verifyOrRotate(name, url, key, putSecret, route, body, expect) {
  if (await tryVerify(url, key, route, body, expect)) return ok(`${name} is working`);
  console.log(`  ! ${name} didn't accept the current secret; rotating it`);
  const fresh = crypto.randomBytes(48).toString('base64url');
  setEnv(key, fresh);
  putSecret(fresh);
  if (await tryVerify(url, key, route, body, expect)) return ok(`${name} is working (rotated its secret)`);
  fail(`${name} at ${url} still isn't answering after rotating its secret.\n`
    + '  Check the token has Account -> Workers Scripts -> Edit, then run this again.');
}

await verifyOrRotate(
  'deadair-api', apiUrl, 'DEADAIR_API_SECRET',
  (v) => wrangler(['secret', 'put', 'API_SECRET'], { input: `${v}\n` }),
  '/data/load', {}, (d) => Array.isArray(d?.progress),
);
if (gatewayUrl && getEnv('AUTH_GATEWAY_SECRET')) {
  await verifyOrRotate(
    'auth-gateway', gatewayUrl, 'AUTH_GATEWAY_SECRET',
    (v) => wrangler(['secret', 'put', 'GATEWAY_SECRET'], { cwd: GATEWAY, input: `${v}\n` }),
    '/status', { id: 0, username: 'setup-check-no-such-user' }, (d) => d?.exists === false,
  );
}

console.log('\nAll set. Restart Deadair (Ctrl+C, then `npm start`) to pick up the new settings.');
