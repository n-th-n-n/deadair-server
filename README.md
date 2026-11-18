# Deadair

A self-hosted media server for my own films and shows. Point it at folders of movies and TV and it works out what's what, pulls artwork and episode info from TMDB, and streams to any browser at home or over Tailscale.

It's a personal project and still in progress, so expect rough edges.

## What it does

- Classifies each file on its own (movie, episode or extra) from file and folder names, so one folder can mix everything. A Fix match button covers the misses.
- Plays browser-friendly files directly with instant seeking, and transcodes the rest with ffmpeg on the fly. H.264 video is remuxed rather than re-encoded, so it costs very little CPU.
- Drops to adaptive streaming (1080p down to 360p, in 6-second segments made on demand) when the connection can't keep up, without restarting playback.
- Reconnects from where it left off if a stream drops, and logs every dropout.
- Continue watching, next episode, missing episodes, duplicates, and watch history per account.
- Live TV: 24/7 channels built from the library alongside antenna tuners and M3U playlists in one guide, with M3U/XMLTV feeds for IPTV apps.
- Chromecast.
- Plugins: optional features in their own repos, loaded from `plugins/`.

## How it's built

- **Server:** Node.js and Express, with ffprobe for scanning and ffmpeg for streaming. The player uses hls.js.
- **Frontend:** plain ES modules and one stylesheet. No framework, no build step.
- **Logins:** a small Cloudflare Worker (`auth-gateway/`) checks passwords against a D1 `users` table, so the home server never holds a database credential or sees a password hash.
- **Data:** libraries, watch history and TMDB matches sync to Cloudflare D1 through a second Worker (`worker/`). The server works from a local copy, so it stays fast and keeps working when Cloudflare is unreachable.
- **Access:** nothing is exposed to the internet. Other devices reach it over Tailscale, optionally on your own HTTPS domain (Caddy, with DNS pointed at the machine's Tailscale address).
- **Deploys:** on macOS it runs as launchd services. An auto-deploy job pulls new commits, runs the tests, restarts, checks the server and its plugins came back, and rolls back if anything fails.

## Running it

Needs Node.js 22.18+ and ffmpeg.

```bash
brew install node ffmpeg     # macOS
AUTH_DISABLED=1 npm start    # first run installs dependencies and creates .env
```

Then open http://localhost:8420 and add a library in Settings. `AUTH_DISABLED=1` skips logins, which is fine on your own machine.

For logins and synced data, deploy the two Workers to your Cloudflare account:

1. Create a D1 database with a `users` table (`id`, `username`, `password_hash`), and put its id and your account id in `auth-gateway/wrangler.toml`. Put the account id in `worker/wrangler.toml` too.
2. Run `npm run setup:cloud`. It deploys both Workers, sets their secrets and fills in `.env`.
3. Add accounts with `npm run add-user -- <name>`, and list who may sign in in `.env` (`ADMIN_USERS`, `ALLOWED_USERS`).

Every setting lives in `.env`; `.env.example` lists them.

| Command | What it does |
| --- | --- |
| `npm run up` | The app and HTTPS on your domain, together |
| `npm run https` | Points `DEADAIR_DOMAIN` at this machine's Tailscale IP and starts Caddy |
| `npm run service:install` | Starts everything at boot on macOS (app, HTTPS, Tailscale watchdog, auto-deploy) |
| `npm run inventory` | Saves a list of every file on each library drive, in case one dies |
| `npm test` | Filename parsing, missing episodes, media and plugin tests |

### Cloudflare token

`setup:cloud` and `add-user` ask for a token when they run and never save it. Create one in Cloudflare (My Profile → API Tokens) from the "Edit Cloudflare Workers" template, and add Account → D1 → Edit.

### HTTPS on your own domain

Tailscale already encrypts traffic and decides who can connect; this just gives Deadair a real name and certificate. Set `DEADAIR_DOMAIN` and `CF_DNS_API_TOKEN` (an "Edit zone DNS" token for that zone) in `.env`, install Caddy with the `caddy-dns/cloudflare` module from caddyserver.com/download, and run `npm run https`. It points the domain at this machine's Tailscale IP and gets a certificate through Cloudflare DNS, so nothing has to be reachable from the internet.

## Plugins

Optional features live in their own repos, cloned into `plugins/<name>`. Deadair loads them at startup and runs the same if one fails. A plugin can have:

```
server.js          exports register(deadair), called once at startup
public/client.js   default export runs in the browser with Deadair's UI API
public/style.css   loaded on every page
package.json       its own dependencies
```

`register(deadair)` gets an Express router under `/api` (behind login), a router for local-only routes, hooks for Chromecast and settings sync, and Deadair's core modules. In the browser, `ui.nav()` adds a link and `ui.route()` adds a page.

## Organizing media

Anything goes, but these are what it expects:

```
Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv
Breaking Bad (2008)/Season 1/Breaking.Bad.S01E01.Pilot.mkv
Breaking Bad (2008)/Extras/Behind the Scenes.mkv
```

## Layout

```
server/        API, scanning, filename parsing, streaming, TMDB, logins, Live TV, plugins
public/        the browser app
worker/        Cloudflare Worker and D1 migrations for synced data
auth-gateway/  Cloudflare Worker for logins
vendor/        auth-core: PBKDF2 password hashing and JWT sessions
scripts/       setup, HTTPS, services, auto-deploy, drive inventory
test/          node --test suites
```

## License

MIT. See [LICENSE](LICENSE).
