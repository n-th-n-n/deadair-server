// Missing episodes: what TMDB says has aired, minus the files on disk.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'deadair-test-data');
const db = require('../server/db');
const missing = require('../server/missing');

const ep = (season, episode, extra = {}) => ({
  id: `x${season}-${episode}`, kind: 'episode', libraryId: 'lib', showKey: 'show', show: 'Show', path: `/L/Show/S${season}E${episode}.mkv`,
  season, episode, episodeEnd: null, ...extra,
});
const eps = (n, airDate = '2020-01-01') => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { name: `Ep ${i + 1}`, airDate }]));

function setup(items, meta) {
  db.state.items = Object.fromEntries(items.map((i) => [i.id, i]));
  db.state.matches = { 'show:show': { meta: { tmdbId: 1, title: 'Show', status: 'Returning Series', ...meta } } };
  db.state.settings = {};
}

test('gaps, whole seasons, unaired episodes, double episodes and specials', () => {
  setup([ep(1, 1), ep(1, 2, { episodeEnd: 3 }), ep(1, 5), ep(0, 1), ep(2, 1)], {
    seasonList: [
      { number: 0, episodes: 4 },
      { number: 1, episodes: 5 },
      { number: 2, episodes: 4 },
      { number: 3, episodes: 6 },
      { number: 4, episodes: 8 },
    ],
    seasons: {
      1: { episodes: eps(5) },
      2: { episodes: { ...eps(3), 4: { name: 'Ep 4', airDate: '2999-01-01' } } },
    },
    lastAired: { season: 3, episode: 6 },
  });
  const [s] = missing.list().shows;
  assert.equal(s.total, 5 + 3 + 6);
  assert.equal(s.have, 4 + 1);
  assert.deepEqual(s.seasons.map((x) => [x.season, x.whole, x.missing.map((e) => e.episode)]), [
    [1, false, [4]],
    [2, false, [2, 3]], // episode 4 hasn't aired
    [3, true, [1, 2, 3, 4, 5, 6]], // season 4 hasn't started
  ]);
  assert.equal(s.gapCount, 3);
  assert.equal(s.wholeSeasons, 1);
});

test('complete, ignored and unmatched shows', () => {
  setup([ep(1, 1), ep(1, 2)], { seasonList: [{ number: 1, episodes: 2 }], seasons: { 1: { episodes: eps(2) } } });
  assert.equal(missing.list().totals.complete, 1);

  setup([ep(1, 1)], { seasonList: [{ number: 1, episodes: 2 }], seasons: { 1: { episodes: eps(2) } } });
  missing.setIgnored('show', true);
  assert.equal(missing.list().shows.length, 0);
  assert.equal(missing.list().ignored.length, 1);
  assert.equal(missing.forShow('show'), null);

  db.state.settings = {};
  db.state.matches = {};
  assert.equal(missing.list().unchecked[0].reason, 'Not matched on TMDB');
});

test('anime numbered straight through is flagged', () => {
  setup([ep(1, 30)], { seasonList: [{ number: 1, episodes: 24 }, { number: 2, episodes: 24 }], seasons: { 1: { episodes: eps(24) } }, lastAired: { season: 2, episode: 24 } });
  assert.equal(missing.list().shows[0].unknown, 1);
});
