// Adds an account to users-db, the shared login for Deadair and your other apps, or sets a new
// password for an existing one:
//
//   npm run add-user              (asks for the username)
//   npm run add-user -- alice
//
// Like setup:cloud it uses ONLY a Cloudflare API token you paste in (or CLOUDFLARE_API_TOKEN),
// never saves it, and only touches the account and database pinned in auth-gateway/wrangler.toml.
// The password is hashed here with auth-core, exactly like the apps do; only the hash is sent.
// Afterwards it can add the username to Deadair's ALLOWED_USERS in .env.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../vendor/auth-core/src/index.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const CF_API = process.env.CLOUDFLARE_API_BASE_URL || 'https://api.cloudflare.com/client/v4';

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ---------- prompts ----------

// One reader for every question, so piped input works too. Hidden answers aren't echoed.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
const echo = rl._writeToOutput.bind(rl);
let muted = false;
rl._writeToOutput = (s) => { if (!muted) echo(s); };

async function ask(question, { hidden = false } = {}) {
  rl.setPrompt(question);
  rl.prompt();
  muted = hidden;
  const { value = '' } = await lines.next();
  if (hidden) {
    muted = false;
    process.stdout.write('\n');
  }
  return value.trim();
}
const yes = async (question, byDefault) => {
  const a = (await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : byDefault;
};

// ---------- where users-db is ----------

const toml = fs.readFileSync(path.join(ROOT, 'auth-gateway', 'wrangler.toml'), 'utf8');
const accountId = toml.match(/^account_id\s*=\s*"([0-9a-f]{32})"/m)?.[1];
const dbId = toml.match(/^database_id\s*=\s*"([0-9a-f-]{36})"/m)?.[1];
if (!accountId || !dbId) fail('auth-gateway/wrangler.toml needs account_id and the users-db database_id.');

console.log('Adds an account to users-db, the login shared by Deadair and your other apps.');
let token = process.env.CLOUDFLARE_API_TOKEN || '';
if (!token) {
  console.log('Paste a Cloudflare API token for your PERSONAL account (used for this run only, never saved).');
  console.log('It needs Account → D1 → Edit; the one from README → "Cloudflare token" works.');
  token = await ask('Cloudflare API token: ', { hidden: true });
}
if (!token) fail('No token given.');

// Parameterized query through Cloudflare's D1 API (no wrangler, so no other login is involved).
async function d1(sql, params = []) {
  const res = await fetch(`${CF_API}/accounts/${accountId}/d1/database/${dbId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  }).catch((err) => fail(`Couldn't reach Cloudflare: ${err.message}`));
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    fail(`users-db said no: ${data?.errors?.map((e) => e.message).join('; ') || res.status}.\n`
      + `  The token needs Account → D1 → Edit on your personal account (${accountId}).`);
  }
  return data.result[0].results;
}

step('Checking users-db');
const columns = await d1('PRAGMA table_info(users)');
if (!columns.length) fail('users-db has no users table.');
// Columns a new row must fill in besides the username and password (an integer id fills itself).
const required = columns.filter((c) => c.notnull && c.dflt_value == null
  && !['username', 'password_hash'].includes(c.name) && !(c.pk && /int/i.test(c.type)));
ok(`found the users table (${columns.map((c) => c.name).join(', ')})`);

// ---------- the account ----------

// Logins are looked up in lowercase (auth-gateway lowercases what people type).
const username = (process.argv[2] || await ask('\nUsername: ')).toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
  fail('Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores.');
}
const [existing] = await d1('SELECT id FROM users WHERE username = ?1', [username]);
if (existing && !await yes(`"${username}" already exists. Set a new password? It changes in every app that uses users-db.`, false)) {
  fail('Nothing changed.');
}

const password = await ask('Password (at least 8 characters): ', { hidden: true });
if (password.length < 8) fail('That password is too short.');
if (await ask('Same password again: ', { hidden: true }) !== password) fail('The passwords don’t match.');

const extra = {};
if (!existing) for (const c of required) extra[c.name] = await ask(`${c.name}${c.type ? ` (${c.type.toLowerCase()})` : ''}: `);

const hash = await hashPassword(password);
if (existing) {
  await d1('UPDATE users SET password_hash = ?1 WHERE id = ?2', [hash, existing.id]);
  ok(`new password set for ${username} (signed out of Deadair within the hour)`);
} else {
  const cols = ['username', 'password_hash', ...Object.keys(extra)];
  await d1(`INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`,
    [username, hash, ...Object.values(extra)]);
  ok(`added ${username} to users-db`);
}

// ---------- Deadair access ----------

const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
const list = (key) => (envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] || '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
if (list('ADMIN_USERS').includes(username) || list('ALLOWED_USERS').includes(username)) {
  ok(`${username} can already use Deadair`);
} else if (envText && await yes(`\nLet ${username} watch on Deadair (adds them to ALLOWED_USERS in .env)?`, true)) {
  const line = `ALLOWED_USERS=${[...list('ALLOWED_USERS'), username].join(',')}`;
  fs.writeFileSync(ENV_FILE, /^ALLOWED_USERS=.*$/m.test(envText)
    ? envText.replace(/^ALLOWED_USERS=.*$/m, line)
    : `${envText.replace(/\n*$/, '\n')}${line}\n`, { mode: 0o600 });
  ok(`added to ALLOWED_USERS. Restart Deadair (Ctrl+C, then \`npm start\`) to let them in`);
}
rl.close();
