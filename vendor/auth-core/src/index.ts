// auth-core: dependency-free auth primitives shared by several apps.
//
// Runtime-agnostic: uses only the Web Crypto API (crypto.subtle), so it runs in
// Cloudflare Workers/Pages Functions, the Next.js edge runtime, and Node 18+.
// It deliberately contains no framework glue: no cookie names, no cookie/Request
// helpers, no env access. The consuming app owns those (they legitimately differ).
//
// The session secret is ALWAYS passed in explicitly. Callers read it from wherever
// their runtime exposes env (process.env.JWT_SECRET, context.env.JWT_SECRET, ...).

export const SESSION_EXPIRES_SEC = 60 * 60 * 24; // 1 day

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Base64url / hex ──────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): Uint8Array {
  return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): ArrayBuffer {
  return new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16))).buffer as ArrayBuffer;
}

function secretToKey(secret: string | undefined): ArrayBuffer {
  if (!secret) throw new Error("JWT_SECRET not set");
  return enc.encode(secret).buffer as ArrayBuffer;
}

// ── HMAC (SHA-256) ───────────────────────────────────────────────────────────

async function hmacSign(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

async function hmacVerify(key: ArrayBuffer, sig: ArrayBuffer, data: string): Promise<boolean> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", k, sig, enc.encode(data));
}

// ── Password hashing (PBKDF2) ──────────────────────────────────────────────────
// These parameters MUST stay constant: every app sharing the `users` table relies
// on them to verify hashes written by another app. Do not change without a migration.

async function pbkdf2(password: string, salt: ArrayBuffer): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password).buffer as ArrayBuffer, "PBKDF2", false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    keyMaterial, 256
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer;
  const hash = await pbkdf2(password, salt);
  return `${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  const salt = fromHex(saltHex);
  const hash = await pbkdf2(password, salt);
  return toHex(hash) === hashHex;
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────────

export async function signSession(userId: number, username: string, secret: string): Promise<string> {
  const key     = secretToKey(secret);
  const header  = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(enc.encode(JSON.stringify({
    sub: String(userId), username, iat: now, exp: now + SESSION_EXPIRES_SEC,
  })));
  const signing = `${header}.${payload}`;
  const sig     = await hmacSign(key, signing);
  return `${signing}.${b64url(sig)}`;
}

export async function verifySession(
  token: string,
  secret: string
): Promise<{ sub: string; username: string } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, sigB64] = parts;
    const sig   = b64urlDecode(sigB64).buffer as ArrayBuffer;
    const valid = await hmacVerify(secretToKey(secret), sig, `${header}.${payload}`);
    if (!valid) return null;
    const data  = JSON.parse(dec.decode(b64urlDecode(payload)));
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return { sub: data.sub, username: data.username };
  } catch {
    return null;
  }
}
