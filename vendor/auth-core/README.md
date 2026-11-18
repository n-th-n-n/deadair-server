# auth-core

Dependency-free auth primitives on Web Crypto. Runs in Cloudflare Workers, Pages Functions, edge runtimes and Node 18+.

- `hashPassword(password)` / `verifyPassword(password, stored)`: PBKDF2-SHA256, 100k iterations, 16-byte salt, stored as `salt:hash` hex.
- `signSession(userId, username, secret)` / `verifySession(token, secret)`: HS256 JWT.
- `SESSION_EXPIRES_SEC`: session lifetime (one day).

The secret is always passed in, so each app reads it however its runtime exposes env.

Several apps share one `users` table, which is why the hashing parameters live in one place. Don't change them: every stored hash depends on them, so a change needs a migration.
