// Plugins: optional features that live outside this repo. Each one is a folder in plugins/
// (usually its own git checkout, which auto-deploy keeps up to date like Deadair itself):
//
//   plugins/<name>/server.js          exports register(deadair), called once at startup
//   plugins/<name>/public/client.js   ES module; its default export gets the browser's plugin API
//   plugins/<name>/public/style.css   loaded on every page (use the theme's colour variables)
//   plugins/<name>/package.json       its own dependencies (npm install in that folder)
//
// Only public/ is served to browsers. A plugin that fails to load is skipped and its error is
// shown in Settings → Server; Deadair runs the same without it. See README → Plugins.
//
// What register(deadair) gets:
//   deadair.api           an Express router under /api, behind login (req.user is set)
//   deadair.local         an Express router under /_plugins/<name>, *before* login. Only for
//                         things on this machine (like ffmpeg reading a relay); check for that.
//   deadair.localUrl(p)   http://127.0.0.1:<port>/_plugins/<name><p>
//   deadair.ownBody(method, path)   that route parses its own body (e.g. a bigger size limit)
//   deadair.castKind(kind, { target(base) -> id | null, stream(id, 'direct' | 'transcode', { start, audio }, req, res) })
//                         lets the Chromecast play what the player streams from `base`
//   deadair.roam(keys)    keys of state.settings that sync to D1 with Deadair's own settings
//   deadair.onStart(fn)   runs once saved data has loaded from D1
//   deadair.requireAdmin, deadair.progressOf(req), deadair.express
//   deadair.core          { config, db, ffmpeg, media, playlog, scanner, parse, keys }
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const CORE_CAST_KINDS = new Set(['item', 'yt']);

const loaded = []; // { name, client, style }, in load order
const failed = []; // { name, error }
const ownBodies = new Set(); // "POST /api/x"
const castKinds = new Map(); // kind -> { target, stream }
const startHooks = [];

// Mounted by server/index.js: api at /api (after login), local at /_plugins and assets at
// /plugins (both before login, like the rest of public/).
const api = express.Router();
const local = express.Router();
const assets = express.Router();

function register(name, dir, core) {
  const router = express.Router();
  const before = express.Router();
  // What the plugin asks for is collected here and only takes effect once register() has
  // succeeded, so a plugin that throws halfway leaves nothing behind.
  const asked = { bodies: [], kinds: new Map(), roam: [], start: [] };
  const deadair = {
    api: router,
    local: before,
    localUrl: (p) => `http://127.0.0.1:${core.config.PORT}/_plugins/${name}${p}`,
    ownBody: (method, p) => asked.bodies.push(`${String(method).toUpperCase()} ${p}`),
    castKind(kind, handler) {
      if (CORE_CAST_KINDS.has(kind) || castKinds.has(kind) || asked.kinds.has(kind)) throw new Error(`cast kind "${kind}" is already taken`);
      asked.kinds.set(kind, handler);
    },
    roam: (keys) => asked.roam.push(...keys),
    onStart: (fn) => asked.start.push({ name, fn }),
    requireAdmin: core.requireAdmin,
    progressOf: core.progressOf,
    express,
    core: core.modules,
  };
  const server = path.join(dir, 'server.js');
  if (fs.existsSync(server)) {
    const plugin = require(server);
    if (typeof plugin.register !== 'function') throw new Error('server.js doesn’t export register()');
    plugin.register(deadair);
  }
  for (const b of asked.bodies) ownBodies.add(b);
  for (const [kind, handler] of asked.kinds) castKinds.set(kind, handler);
  if (asked.roam.length) core.roam(asked.roam);
  startHooks.push(...asked.start);
  api.use(router);
  local.use(`/${name}`, before);
  const pub = path.join(dir, 'public');
  if (fs.existsSync(pub)) assets.use(`/${name}`, express.static(pub));
  return {
    name,
    client: fs.existsSync(path.join(pub, 'client.js')),
    style: fs.existsSync(path.join(pub, 'style.css')),
  };
}

// Load every plugin in `dir`. `core` is what server/index.js hands over (see register above).
function load(core, dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || !fs.statSync(path.join(dir, name)).isDirectory()) continue;
    if (!NAME_RE.test(name)) {
      console.warn(`[plugins] skipped plugins/${name}: use lowercase letters, numbers and dashes in a plugin’s folder name`);
      continue;
    }
    try {
      loaded.push(register(name, path.join(dir, name), core));
      console.log(`plugin: ${name}`);
    } catch (err) {
      failed.push({ name, error: err.message });
      console.error(`[plugins] ${name} didn’t load, so it’s off: ${err.stack || err.message}`);
    }
  }
}

// After D1 has loaded. One plugin's failure doesn't stop the others.
function start() {
  for (const { name, fn } of startHooks) {
    Promise.resolve().then(fn).catch((err) => console.error(`[plugins] ${name} failed to start: ${err.message}`));
  }
}

const parsesOwnBody = (req) => ownBodies.has(`${req.method} ${req.path}`);

// The plugin video a player base URL means, as a cast target, or null.
function castTarget(base) {
  for (const [kind, handler] of castKinds) {
    const id = handler.target(base);
    if (id) return { kind, id };
  }
  return null;
}
const castKind = (kind) => castKinds.get(kind) || null;

// For the browser (which plugins to load) and Settings → Server (which loaded, which failed).
const list = () => loaded.map((p) => ({ ...p }));
const status = () => [...loaded.map(({ name }) => ({ name })), ...failed.map((f) => ({ ...f }))];

module.exports = { load, start, api, local, assets, parsesOwnBody, castTarget, castKind, list, status };
