// auth-gateway: lets a server outside Cloudflare (e.g. Deadair on the home server) sign
// people in with the shared users-db accounts, without any access to users-db itself.
//
// A caller holding the shared secret (GATEWAY_SECRET) can ask exactly two things:
//   POST /verify  { username, password } -> is this login correct?
//   POST /status  { id, username }      -> does the account still exist, unchanged?
// Callers never see password hashes, other users, or any other table. Password checks use
// the same auth-core as every other app, so the same accounts work everywhere.
import { verifyPassword } from '../../vendor/auth-core/src/index.ts';

interface Env {
  DB: D1Database;
  GATEWAY_SECRET: string;
}

type User = { id: number; username: string; password_hash: string };

// Compared against when the username doesn't exist, so response time doesn't reveal it.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(64)}`;
const enc = new TextEncoder();

const json = (body: unknown, status = 200) => Response.json(body, { status });

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time secret check: compare fixed-length digests, never the raw strings.
async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < 32) return false;
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Opaque token that changes whenever the password does, without revealing the hash.
async function credential(secret: string, passwordHash: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`auth-gateway-credential:${passwordHash}`)));
}

function findUser(env: Env, username: string): Promise<User | null> {
  return env.DB
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?1')
    .bind(username)
    .first<User>();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
    if (!(await authorized(request, env.GATEWAY_SECRET))) return json({ error: 'Unauthorized' }, 401);

    let body: { username?: unknown; password?: unknown; id?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const username = String(body?.username ?? '').trim().toLowerCase();
    if (!username) return json({ error: 'username required' }, 400);

    if (pathname === '/verify') {
      const user = await findUser(env, username);
      const ok = await verifyPassword(String(body.password ?? ''), user?.password_hash || DUMMY_HASH);
      if (!user || !ok) return json({ ok: false });
      return json({ ok: true, id: user.id, username: user.username, credential: await credential(env.GATEWAY_SECRET, user.password_hash) });
    }

    if (pathname === '/status') {
      const user = await findUser(env, username);
      if (!user || String(user.id) !== String(body.id)) return json({ exists: false });
      return json({ exists: true, credential: await credential(env.GATEWAY_SECRET, user.password_hash) });
    }

    return json({ error: 'Not found' }, 404);
  },
};
