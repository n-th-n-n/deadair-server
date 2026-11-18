// Tiny JSON-file store. Plenty for a personal library of a few thousand files,
// and avoids native modules that are painful to build on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const state = { libraries: [], items: {}, progress: {} };

function load() {
  try {
    Object.assign(state, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

let timer = null;
const saveListeners = [];
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 500);
  for (const fn of saveListeners) fn();
}

function flush() {
  clearTimeout(timer);
  timer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

load();

module.exports = { state, save, flush, onSave: (fn) => saveListeners.push(fn) };
