// Plugins (server/plugins.js): a plugin's routes, assets and hooks work, and a broken plugin is
// skipped without leaving anything behind.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const plugins = require('../server/plugins');

const ROOT = path.join(__dirname, '..');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('plugins load, serve their routes and assets, and a broken one is skipped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadair-plugins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(dir, 'hello', 'server.js'), `module.exports = { register(deadair) {
    deadair.api.get('/hello', (req, res) => res.json({ hi: req.user.username, admin: typeof deadair.requireAdmin }));
    deadair.ownBody('POST', '/api/hello');
    deadair.api.post('/hello', deadair.express.json({ limit: '2mb' }), (req, res) => res.json({ size: req.body.blob.length }));
    deadair.local.get('/ping', (req, res) => res.send(deadair.localUrl('/ping')));
    deadair.castKind('hi', { target: (base) => (base === '/api/hello/v' ? 'v1' : null), stream: () => {} });
    deadair.roam(['helloKey']);
    deadair.onStart(() => { globalThis.helloStarted = deadair.core.marker; });
  } };`);
  write(path.join(dir, 'hello', 'public', 'client.js'), 'export default () => {};');
  // Asks for things, then throws: none of it may take effect.
  write(path.join(dir, 'broken', 'server.js'), `module.exports = { register(deadair) {
    deadair.castKind('nope', { target: () => 'x', stream: () => {} });
    deadair.roam(['brokenKey']);
    deadair.onStart(() => { globalThis.brokenStarted = true; });
    deadair.api.get('/broken', (req, res) => res.json({}));
    throw new Error('kaboom');
  } };`);
  write(path.join(dir, 'broken', 'public', 'client.js'), 'export default () => {};');
  write(path.join(dir, 'looks-only', 'public', 'style.css'), 'body {}');
  write(path.join(dir, 'Bad Name', 'server.js'), 'throw new Error("should not be loaded")');
  write(path.join(dir, '.hidden', 'server.js'), 'throw new Error("should not be loaded")');

  const roamed = [];
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  plugins.load({
    config: { PORT: 1234 },
    requireAdmin: (req, res, next) => next(),
    progressOf: () => ({}),
    roam: (keys) => roamed.push(...keys),
    modules: { marker: 'core modules' },
  }, dir);

  assert.deepEqual(plugins.list(), [
    { name: 'hello', client: true, style: false },
    { name: 'looks-only', client: false, style: true },
  ]);
  assert.deepEqual(plugins.status().map((p) => [p.name, p.error || null]), [['hello', null], ['looks-only', null], ['broken', 'kaboom']]);
  assert.ok(errors.some((e) => e.includes('broken')), 'a plugin that fails says so in the log');
  assert.deepEqual(roamed, ['helloKey']);
  assert.ok(plugins.parsesOwnBody({ method: 'POST', path: '/api/hello' }));
  assert.ok(!plugins.parsesOwnBody({ method: 'GET', path: '/api/hello' }));
  assert.deepEqual(plugins.castTarget('/api/hello/v'), { kind: 'hi', id: 'v1' });
  assert.equal(plugins.castTarget('/api/items/x'), null);
  assert.equal(plugins.castKind('nope'), null);

  plugins.start();
  await new Promise((ok) => setImmediate(ok));
  assert.equal(globalThis.helloStarted, 'core modules');
  assert.equal(globalThis.brokenStarted, undefined);

  // Mounted the way server/index.js does it.
  const app = express();
  const json = express.json();
  app.use((req, res, next) => (plugins.parsesOwnBody(req) ? next() : json(req, res, next)));
  app.use('/plugins', plugins.assets);
  app.use('/_plugins', plugins.local);
  app.use('/api', (req, res, next) => { req.user = { username: 'alice' }; next(); }, plugins.api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((ok) => server.once('listening', ok));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;

  assert.deepEqual(await (await fetch(url('/api/hello'))).json(), { hi: 'alice', admin: 'function' });
  // Bigger than express.json()'s default 100kb: only works because the route parses its own body.
  const big = await fetch(url('/api/hello'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blob: 'x'.repeat(500000) }) });
  assert.deepEqual(await big.json(), { size: 500000 });
  assert.equal(await (await fetch(url('/_plugins/hello/ping'))).text(), 'http://127.0.0.1:1234/_plugins/hello/ping');
  assert.equal((await fetch(url('/plugins/hello/client.js'))).status, 200);
  assert.equal((await fetch(url('/plugins/looks-only/style.css'))).status, 200);
  // Only public/ is served, and nothing of a plugin that failed.
  assert.equal((await fetch(url('/plugins/hello/server.js'))).status, 404);
  assert.equal((await fetch(url('/plugins/hello/../hello/server.js'))).status, 404);
  assert.equal((await fetch(url('/plugins/broken/client.js'))).status, 404);
  assert.equal((await fetch(url('/api/broken'))).status, 404);
});

test('no plugins folder: nothing loads', () => {
  const before = plugins.list().length;
  plugins.load({}, path.join(os.tmpdir(), 'deadair-no-such-folder'));
  assert.equal(plugins.list().length, before);
});
