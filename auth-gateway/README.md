# auth-gateway

A small Cloudflare Worker that lets a server outside Cloudflare check logins against a shared `users` table in D1, without that server holding a database credential or ever seeing a password hash.

Callers send a shared secret (`Authorization: Bearer <GATEWAY_SECRET>`) and can ask two things:

| Route | Body | Answer |
| --- | --- | --- |
| `POST /verify` | `{ username, password }` | `{ ok, id, username, credential }` |
| `POST /status` | `{ id, username }` | `{ exists, credential }` |

`credential` is an opaque value that changes whenever the password changes, so a caller can end sessions after a password change without seeing the hash. Wrong passwords and unknown usernames get the same answer in the same time.

Password hashing comes from `vendor/auth-core`.

## Deploy

```bash
npx wrangler deploy
npx wrangler secret put GATEWAY_SECRET
```

Use a long random secret (`openssl rand -base64 48`) and give Deadair the same value as `AUTH_GATEWAY_SECRET`. `npm run setup:cloud` in the project root does all of this for you.
