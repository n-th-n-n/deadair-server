// Which show or movie each extra belongs to. parse.js records the folder an extra hangs off
// ("extraOf"); the owner is whatever is filed there: the movie sitting directly in it, else the
// show with the most episodes below it, else the only movie below it. Worked out from the file
// index on each request, because what's in a folder changes with every scan. It's one pass over
// the index, a few milliseconds.
const path = require('node:path');
const db = require('./db');
const { movieKey } = require('./keys');

function owners() {
  const extras = Object.values(db.state.items).filter((i) => i.kind === 'extra');
  const dirs = new Map(extras.map((e) => [e.extraOf, { here: [], below: new Map(), shows: new Map() }]));
  if (!dirs.size) return new Map();
  for (const item of Object.values(db.state.items)) {
    if (item.kind !== 'movie' && item.kind !== 'episode') continue;
    let dir = path.dirname(item.path);
    for (let direct = true; ; direct = false) {
      const d = dirs.get(dir);
      if (d && item.kind === 'movie') {
        if (direct) d.here.push(item);
        else d.below.set(movieKey(item), item);
      }
      if (d && item.kind === 'episode') {
        const s = d.shows.get(item.showKey) || { libraryId: item.libraryId, showKey: item.showKey, title: item.show, count: 0 };
        s.count++;
        d.shows.set(item.showKey, s);
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const byDir = new Map();
  for (const [dir, d] of dirs) {
    const show = [...d.shows.values()].sort((a, b) => b.count - a.count)[0];
    if (d.here.length) byDir.set(dir, { kind: 'movie', item: d.here[0] });
    else if (show) byDir.set(dir, { kind: 'show', libraryId: show.libraryId, showKey: show.showKey, title: show.title });
    else if (d.below.size === 1) byDir.set(dir, { kind: 'movie', item: [...d.below.values()][0] });
  }
  return new Map(extras.map((e) => [e.id, byDir.get(e.extraOf) || null]));
}

const order = (a, b) => a.extraGroup.localeCompare(b.extraGroup, undefined, { numeric: true })
  || a.title.localeCompare(b.title, undefined, { numeric: true });

function list(test) {
  const own = owners();
  return Object.values(db.state.items).filter((i) => i.kind === 'extra' && test(own.get(i.id))).sort(order);
}

// Extras of a show, or of a movie (any copy of it).
const forShow = (libraryId, showKey) => list((o) => o?.kind === 'show' && o.libraryId === libraryId && o.showKey === showKey);
const forMovie = (item) => list((o) => o?.kind === 'movie' && movieKey(o.item) === movieKey(item));
// Extras nothing could be found for: still listed under the library's Videos.
const orphans = (libraryId) => list((o) => !o).filter((i) => i.libraryId === libraryId);
const ownerOf = (item) => (item.kind === 'extra' ? owners().get(item.id) || null : null);

module.exports = { forShow, forMovie, orphans, ownerOf };
