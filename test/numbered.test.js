// Shows numbered straight through ("Bleach 100") are placed on TMDB's seasons; shows whose seasons
// start again at 1 are left alone.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'deadair-test-data');
const db = require('../server/db');
const { placeNumbered } = require('../server/metadata');

// A file in season folder `season` named "Show <n>" (or "Show <n>-<end>").
const ep = (season, n, end = null) => ({
  id: `x${season}-${n}`, kind: 'episode', libraryId: 'lib', showKey: 'show', show: 'Show', path: `/L/Show/Season ${season}/Show ${n}.mkv`,
  season, episode: null, episodeEnd: null, numbered: { season, episode: n, end },
});

function setup(items, seasonList) {
  db.state.items = Object.fromEntries(items.map((i) => [i.id, i]));
  db.state.matches = { 'show:show': { meta: { tmdbId: 1, title: 'Show', seasonList } } };
}
const where = () => Object.values(db.state.items).map((i) => `${i.numbered.episode}:S${i.season}E${i.episode}`);

test('TMDB lists one long season: everything goes into it (Bleach)', () => {
  setup([ep(1, 1), ep(1, 20), ep(2, 21), ep(5, 100)], [{ number: 0, episodes: 4 }, { number: 1, episodes: 366 }, { number: 2, episodes: 50 }]);
  assert.equal(placeNumbered(), true);
  assert.deepEqual(where(), ['1:S1E1', '20:S1E20', '21:S1E21', '100:S1E100']);
  assert.equal(placeNumbered(), false); // already in place
});

test('TMDB splits it into seasons: counted across them', () => {
  setup([ep(1, 20), ep(2, 21), ep(2, 40, 41), ep(3, 42), ep(3, 70)], [{ number: 1, episodes: 20 }, { number: 2, episodes: 21 }, { number: 3, episodes: 22 }]);
  placeNumbered();
  // 70 is past the 63 episodes TMDB lists: left where the file says, without a number.
  assert.deepEqual(where(), ['20:S1E20', '21:S2E1', '40:S2E20', '42:S3E1', '70:S3Enull']);
  assert.equal(db.state.items['x2-40'].episodeEnd, 21);
});

test('seasons that start again at 1 are left alone', () => {
  setup([ep(1, 1), ep(1, 2), ep(2, 1), ep(2, 2)], [{ number: 1, episodes: 2 }, { number: 2, episodes: 2 }]);
  assert.equal(placeNumbered(), false);
  setup([ep(1, 5), ep(1, 9)], [{ number: 1, episodes: 3 }, { number: 2, episodes: 10 }]); // one folder: nothing to go on
  assert.equal(placeNumbered(), false);
});
