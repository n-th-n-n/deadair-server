// Login with the shared users-db accounts (the same ones as your other apps).
//
// The home server never touches users-db itself. It asks the `auth-gateway` Worker
// (auth-gateway/), which only answers "is this login correct?" and "does this account
// still exist, unchanged?". Deadair holds just the secret for that Worker, so it can't
// read password hashes or any other users-db data. The Worker is called at login and about once
// an hour per active account; other requests only verify Deadair's own session cookie.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const express = require('express');
const { ROOT, DATA_DIR } = require('./config');
const db = require('./db');
const { gateway } = require('./worker');

const COOKIE = 'deadair_session';
const DISABLED = process.env.AUTH_DISABLED === '1';

// users-db holds accounts for all your apps, so Deadair only admits the ones listed here.
// Admins manage libraries and settings; ALLOWED_USERS can only browse and watch.
const userList = (name) => new Set(String(process.env[name] || '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean));
const ADMINS = userList('ADMIN_USERS');
const VIEWERS = userList('ALLOWED_USERS');
const isAdmin = (username) => DISABLED || ADMINS.has(String(username).toLowerCase());
const hasAccess = (username) => isAdmin(username) || VIEWERS.has(String(username).toLowerCase());

// Active accounts are re-checked against users-db this often, so deleting an account or
// changing its password ends its Deadair sessions.
const RECHECK_MS = (process.env.AUTH_RECHECK_MIN != null ? Number(process.env.AUTH_RECHECK_MIN) : 60) * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

// auth-core is raw TypeScript (vendored like the other apps' submodule); Node >= 22.18 strips types natively.
let corePromise;
const core = () => (corePromise ||= import(pathToFileURL(path.join(ROOT, 'vendor', 'auth-core', 'src', 'index.ts')).href));

// Deadair's own signing secret, so a leak here can't mint sessions for the other apps.
const SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
})();

const loginConfigured = () => DISABLED || gateway.configured();

// ---------- cookies ----------

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function setSessionCookie(req, res, token, maxAge) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (req.secure) flags.splice(1, 0, 'Secure');
  res.append('Set-Cookie', `${COOKIE}=${token}; ${flags.join('; ')}`);
}

function tokenIssuedAt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).iat || 0;
  } catch {
    return 0;
  }
}

// ---------- login throttling ----------

const failures = new Map(); // ip -> { count, resetAt }
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

function throttled(ip) {
  const f = failures.get(ip);
  if (f && f.resetAt < Date.now()) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, resetAt: Date.now() + WINDOW_MS };
  f.count++;
  failures.set(ip, f);
}

// ---------- account revocation ----------
//
// auth-core sessions are stateless, so Deadair keeps a small record per account:
//   cred       - opaque value from the Worker that changes whenever the password does
//   validAfter - sessions issued at or before this second (unix time) are void
//   checkedAt  - when users-db was last consulted
// If the account disappears or its password hash changes, every older session is voided.

const accounts = () => (db.state.accounts ||= {});
const nowSec = () => Math.floor(Date.now() / 1000);

async function checkAccount(userId, username, acct) {
  try {
    const status = await gateway.call('/status', { id: userId, username });
    const cred = status.exists ? status.credential : null;
    const valid = !!cred && (!acct.cred || acct.cred === cred);
    if (!valid) acct.validAfter = nowSec();
    Object.assign(acct, { username, cred: cred || acct.cred, checkedAt: Date.now() });
    delete acct.retryAt;
    delete acct.pwf; // from before the Worker
    db.save();
    if (!valid) console.log(`[auth] ${username}: ${cred ? 'password changed' : 'account removed'}, signed out everywhere`);
    return valid;
  } catch (err) {
    // users-db unreachable: keep existing sessions working, try again shortly.
    console.warn(`[auth] could not re-check ${username}: ${err.message}`);
    acct.retryAt = Date.now() + RETRY_MS;
    return true;
  }
}

const rechecks = new Map(); // userId -> pending check, so parallel requests share one Worker call

function recheck(userId, username) {
  const acct = (accounts()[userId] ||= { username });
  const now = Date.now();
  if (now - (acct.checkedAt || 0) < RECHECK_MS || (acct.retryAt || 0) > now) return true;
  let pending = rechecks.get(userId);
  if (!pending) {
    pending = checkAccount(userId, username, acct).finally(() => rechecks.delete(userId));
    rechecks.set(userId, pending);
  }
  return pending;
}

// ---------- sessions ----------

async function sessionUser(req, res) {
  if (DISABLED) return { id: 'local', username: 'local', admin: true };
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const auth = await core();
  const session = await auth.verifySession(token, SECRET);
  const userId = session && String(session.sub);
  const valid = !!session
    && hasAccess(session.username)
    && tokenIssuedAt(token) > (accounts()[userId]?.validAfter || 0)
    && await recheck(userId, session.username);
  if (!valid) {
    setSessionCookie(req, res, '', 0); // drop the dead cookie
    return null;
  }
  // Sliding session: auth-core tokens last SESSION_EXPIRES_SEC, so re-issue once one is
  // half used. Anyone who opens Deadair at least that often stays signed in.
  if (Date.now() / 1000 - tokenIssuedAt(token) > auth.SESSION_EXPIRES_SEC / 2) {
    setSessionCookie(req, res, await auth.signSession(Number(session.sub), session.username, SECRET), auth.SESSION_EXPIRES_SEC);
  }
  return { id: userId, username: session.username, admin: isAdmin(session.username) };
}

async function requireAuth(req, res, next) {
  const user = await sessionUser(req, res);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Only an admin can do that' });
  next();
}

// ---------- IPTV links ----------
//
// IPTV apps (TiviMate, VLC, Channels, Jellyfin, …) can't sign in, so each account can have one
// secret link for its playlist, guide and streams. Only a hash is kept, in the account record, so
// it follows Deadair to a new machine. It stops working when the account loses access to Deadair,
// is deleted, or changes its password (like a session), and can be replaced or turned off anytime.

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function createIptvToken(user) {
  const token = crypto.randomBytes(24).toString('base64url');
  const acct = (accounts()[user.id] ||= { username: user.username });
  acct.iptv = { hash: tokenHash(token), createdAt: Date.now() };
  db.save();
  return token;
}

function revokeIptvToken(user) {
  delete accounts()[user.id]?.iptv;
  db.save();
}

const iptvCreatedAt = (user) => accounts()[user.id]?.iptv?.createdAt || null;

async function iptvUser(token) {
  if (!token) return null;
  const hash = tokenHash(token);
  const found = Object.entries(accounts()).find(([, a]) => a.iptv?.hash === hash);
  if (!found) return null;
  const [userId, acct] = found;
  if (DISABLED) return { id: userId, username: acct.username, admin: true };
  const valid = hasAccess(acct.username)
    && acct.iptv.createdAt > (acct.validAfter || 0) * 1000
    && await recheck(userId, acct.username)
    && acct.iptv.createdAt > (acct.validAfter || 0) * 1000; // the recheck may have just voided it
  return valid ? { id: userId, username: acct.username, admin: isAdmin(acct.username) } : null;
}

// For /iptv/:token/… routes. Wrong links count toward the same lockout as failed sign-ins.
async function requireIptv(req, res, next) {
  if (throttled(req.ip)) return res.status(429).end();
  const user = await iptvUser(req.params.token);
  if (!user) {
    recordFailure(req.ip);
    return res.status(404).end();
  }
  req.user = user;
  next();
}

// ---------- routes ----------

const loginHandlers = [];
const router = express.Router();

router.post('/login', async (req, res) => {
  if (DISABLED) return res.json({ ok: true, username: 'local' });
  if (!loginConfigured()) {
    return res.status(503).json({ error: 'Login is not configured on this server. Set AUTH_GATEWAY_URL and AUTH_GATEWAY_SECRET in .env.' });
  }
  if (throttled(req.ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  let result;
  try {
    result = await gateway.call('/verify', { username, password });
  } catch (err) {
    console.error('[auth]', err.message);
    return res.status(502).json({ error: 'Could not reach the account service. Try again shortly.' });
  }
  if (!result.ok) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = { id: result.id, username: result.username };
  failures.delete(req.ip);
  if (!hasAccess(user.username)) {
    return res.status(403).json({
      error: ADMINS.size ? 'This account doesn’t have access to Deadair.' : 'No accounts have access yet. Add your username to ADMIN_USERS in the server’s .env.',
    });
  }

  const userId = String(user.id);
  const acct = (accounts()[userId] ||= {});
  // Password changed since Deadair last saw this account: void sessions issued before now.
  if (acct.cred && acct.cred !== result.credential) acct.validAfter = nowSec();
  Object.assign(acct, { username: user.username, cred: result.credential, checkedAt: Date.now() });
  delete acct.retryAt;
  delete acct.pwf;
  db.save();

  const auth = await core();
  // Revocation works in whole seconds (auth-core's iat), so issue this session after that second.
  const wait = (acct.validAfter || 0) + 1 - Date.now() / 1000;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  const token = await auth.signSession(user.id, user.username, SECRET);
  setSessionCookie(req, res, token, auth.SESSION_EXPIRES_SEC);
  for (const fn of loginHandlers) fn({ id: String(user.id), username: user.username });
  res.json({ ok: true, username: user.username });
});

router.post('/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const user = await sessionUser(req, res);
  if (!user) return res.status(401).json({ error: 'Unauthorized', configured: loginConfigured() });
  res.json({ id: user.id, username: user.username, admin: user.admin, authDisabled: DISABLED });
});

module.exports = {
  router,
  requireAuth,
  requireAdmin,
  requireIptv,
  createIptvToken,
  revokeIptvToken,
  iptvCreatedAt,
  DISABLED,
  loginConfigured,
  access: () => ({ admins: [...ADMINS], viewers: [...VIEWERS] }),
  onLogin: (fn) => loginHandlers.push(fn),
};
