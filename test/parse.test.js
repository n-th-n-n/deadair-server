// How file and folder names are understood, using real-world names from the library.
// Add a case here whenever a new naming style shows up, so a fix for one can't break another.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'deadair-test-data'); // parse.js pulls in config
const { parseMedia } = require('../server/parse');

const LIB = { path: '/L' };
const parse = (rel) => parseMedia(path.join('/L', ...rel.split('/')), LIB);

function movie(rel, title, year) {
  test(`movie: ${rel}`, () => {
    const m = parse(rel);
    assert.equal(m.kind, 'movie');
    assert.equal(m.title, title);
    assert.equal(m.year, year);
  });
}

function episode(rel, show, season, ep, title) {
  test(`episode: ${rel}`, () => {
    const m = parse(rel);
    assert.equal(m.kind, 'episode', `detected as ${m.kind}: ${m.title}`);
    assert.equal(m.show, show);
    assert.equal(m.season, season);
    assert.equal(m.episode, ep);
    if (title !== undefined) assert.equal(m.title, title);
  });
}

// ---------- movies ----------
movie('Movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv', 'Blade Runner 2049', 2017);
movie('The.Matrix.1999.1080p.BluRay.x264-GRP.mkv', 'The Matrix', 1999);
movie('Inception (2010)/movie.mkv', 'Inception', 2010);
movie('Home Videos/Beach Trip 2019.mp4', 'Beach Trip', 2019);
movie("Futurama S01-S07 (1999-) + 4 Movies (2007-2009)/Futurama S05M01 Bender's Big Score (2007 360p re-blurip).mp4", "Futurama Bender's Big Score", 2007);

// ---------- Plex-style TV ----------
episode('Breaking Bad (2008)/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.720p.WEB-DL.mkv', 'Breaking Bad', 1, 2, 'Cats in the Bag');
episode('The Office (US)/Season 2/the.office.us.s02e01.mkv', 'The Office (US)', 2, 1);
episode('Friends/Season 3/Episode 7.mkv', 'Friends', 3, 7);
episode('Show.Name.3x05.HDTV.mkv', 'Show Name', 3, 5);
episode('misc/Severance.S01E01.mkv', 'Severance', 1, 1);
episode('Star Trek - The Next Generation/Season 1/Star.Trek.TNG.S01E01.mkv', 'Star Trek - The Next Generation', 1, 1);

// ---------- season packs and download folders ----------
episode('Futurama S01-S07 (1999-) + 4 Movies (2007-2009)/Futurama S02 (360p re-dvdrip)/Futurama S02E01 A Flight To Remember.mp4', 'Futurama', 2, 1, 'A Flight To Remember');
episode('Futurama S01-S07 (1999-) + 4 Movies (2007-2009)/Futurama S07 (360p re-webrip)/Futurama S07X01 Simpsorama (The Simpsons S26E06).mp4', 'Futurama', 0, null);
episode('better call saul/Better Call Saul - Season 4 (2018) [720p]/Better Call Saul - S04E06 - Pinata.mkv', 'Better Call Saul', 4, 6, 'Pinata');
episode('better call saul/Better Call Saul Season 3 Complete 720p HDTV x264 [i_c]/Better Call Saul S03E07 Expenses.mkv', 'Better Call Saul', 3, 7, 'Expenses');
episode('[CBM] Neon Genesis Evangelion 1-26 Complete (Dual Aduio) [BDRip 720p 8bit]/[CBM]_Neon_Genesis_Evangelion_-_11_-_In_the_Still_Darkness_[720p]_[9BA0A75A].mkv', 'Neon Genesis Evangelion', 1, 11, 'In the Still Darkness');

// NewsRadio: "<absolute number> - sNeNN - Title", in a folder with release tags after the name.
episode('tv/NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras/Season 01/01 - s1e01 - Pilot.mkv', 'NewsRadio', 1, 1, 'Pilot');
episode("tv/NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras/Season 02/08 - s2e01 - No, This Is Not Based Entirely on Julie's Life.mkv", 'NewsRadio', 2, 1, "No, This Is Not Based Entirely on Julie's Life");
episode('tv/NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras/Season 03/Season 3 Bloopers.mkv', 'NewsRadio', 3, null);

// The Sopranos: a box-set folder whose name lists seasons, and "Season N Episode NN - Title" files.
episode('tv/The Sopranos - The Complete Series (Season 1, 2, 3, 4, 5 & 6) + Extras/Season 1/The Sopranos Season 1 Episode 01 - Pilot.avi', 'The Sopranos', 1, 1, 'Pilot');
episode('tv/The Sopranos - The Complete Series (Season 1, 2, 3, 4, 5 & 6) + Extras/Season 1/The Sopranos Season 1 Episode 03 - Denial, Anger, Acceptance.avi', 'The Sopranos', 1, 3, 'Denial, Anger, Acceptance');
episode('TV Shows/Seasons 1-3 Pack/Show.Name.S02E04.mkv', 'Show Name', 2, 4);

// Trailer Park Boys: bare "S01E01.mkv" files under a "Seasons 1-10" box-set folder.
episode('tv/Trailer Park Boys S01-S10 + Movies + Specials + Extras [Ultimate Collection]-GRP/Seasons 1-10/Season 1/S01E01.mkv', 'Trailer Park Boys', 1, 1);
episode('tv/Trailer Park Boys S01-S10 + Movies + Specials + Extras [Ultimate Collection]-GRP/Seasons 1-10/Trailer Park Boys S05 Season 5 + Extras [480p DVDRip x264]/S05E01.mkv', 'Trailer Park Boys', 5, 1);

// Home Improvement: season and episode run together ("207" is S2E07).
episode('tv/Home Improvement/Home Improvement Season 2/Home Improvement - 207 - Roomie For Improvement.avi', 'Home Improvement', 2, 7, 'Roomie For Improvement');
episode('tv/Home Improvement/Home Improvement Season 1/Home Improvement - 101 - Pilot.avi', 'Home Improvement', 1, 1, 'Pilot');
// NewsRadio: bonus shorts in a season folder of a show numbered s5e01 aren't episodes 1-3.
episode('tv/NewsRadio [.x264 DVD Rips] Commentaries, Subtitles, Extras/Season 05/One Man NewsRadio - Joe Furey 01.mkv', 'NewsRadio', 5, null);

// Bleach: a season folder with a typo after the number ("05l" for "05;").
// Its files are numbered straight through ("Bleach 100"); metadata.js places them on TMDB's seasons.
episode('tv/Bleach Complete Series + Movies/Season 05l The Assault/Bleach 100.mkv', 'Bleach', 5, null);
episode('tv/Bleach Complete Series + Movies/Season 13; Zanpaktu; The Alternate Tale/Bleach 230.mkv', 'Bleach', 13, null);
test('a bare name and number in a season folder is a hint, not yet an episode number', () => {
  assert.deepEqual(parse('tv/Bleach Complete Series + Movies/Season 02; The Entry/Bleach 21.mkv').numbered, { season: 2, episode: 21, end: null });
  assert.deepEqual(parse('tv/Bleach Complete Series + Movies/Season 09; The New Captain Shusuke Amagai/Bleach 176-177.mkv').numbered, { season: 9, episode: 176, end: 177 });
  assert.equal(parse('tv/The Bear/Season 2/Part 1.mkv').show, 'The Bear'); // not a show called "Part"
  assert.equal(parse('Movies/Ocean\'s 11.mkv').kind, 'movie');
});

// ---------- extras ----------
// Behind the scenes, deleted scenes, featurettes and DVD bonus material belong to the show or
// movie in the folder above them: never their own movie, show or season.
function extra(rel, of, group) {
  test(`extra: ${rel}`, () => {
    const m = parse(rel);
    assert.equal(m.kind, 'extra', `detected as ${m.kind}: ${m.title}`);
    assert.equal(m.extraOf, path.join('/L', ...of.split('/').filter(Boolean)));
    if (group !== undefined) assert.equal(m.extraGroup, group);
  });
}

const TPB = 'tv/Trailer Park Boys S01-S10 + Movies + Specials + Extras [Ultimate Collection]-GRP';
extra(`${TPB}/Extras/Bubbles on Hockey Night in Canada.mp4`, TPB, 'Extras');
extra(`${TPB}/Extras/On-Set_Behind the Scenes/Season 10 On-Set_Behind the Scenes [720p] [Swearnet WEB-DL]/Ask Us Fucking Anything/Ask John Dunsworth Anything/Part 1.mp4`, TPB,
  'On-Set Behind the Scenes › Season 10 On-Set Behind the Scenes › Ask Us Fucking Anything › Ask John Dunsworth Anything');
// Numbered things inside extras folders are still extras, not episodes of the show.
extra(`${TPB}/Extras/On-Set_Behind the Scenes/Season 8 On-Set_Behind the Scenes [720p] [Swearnet WEB-DL]/Bonus Video - Orange Thunder.mp4`, TPB);
extra(`${TPB}/Extras/Dear Julian (TPB Extra) [E01-22] [720p] [Swearnet WEB-DL]/E01.Government Discount.mp4`, TPB);
extra(`${TPB}/Seasons 1-10/Season 2/S01&S02 DVD Special Features/Lost Interviews/Ricky (Lost Interview).mkv`, `${TPB}/Seasons 1-10/Season 2`, 'Season 2 › Lost Interviews');
extra(`${TPB}/Seasons 1-10/Season 3/S03 DVD Special Features/Bloopers_Gag Reel.mp4`, `${TPB}/Seasons 1-10/Season 3`, 'Season 3 › S03 DVD Special Features');
extra(`${TPB}/Movies/Countdown to Liquor Day (2009) [1080p BluRay x265_HEVC] [Eng_Fre]/DVD Special Features/Deleted Scenes/Lucy on Barb (Deleted Scene).mkv`,
  `${TPB}/Movies/Countdown to Liquor Day (2009) [1080p BluRay x265_HEVC] [Eng_Fre]`, 'Deleted Scenes');
extra(`${TPB}/Specials/Christmas Special + Commentary & DVD Bonus Features/DVD Bonus Features/Alternate Takes/Bird Suckin' (Alternate Take).mkv`,
  `${TPB}/Specials/Christmas Special + Commentary & DVD Bonus Features`, 'Alternate Takes');
extra('tv/Freaks and Geeks (1999) Season 1 S01 (1080p BluRay x265 HEVC 10bit AAC 2.0 Silence)/Featurettes/Season 1/Deleted Scenes/S01E01 Pilot Deleted Scenes.mkv',
  'tv/Freaks and Geeks (1999) Season 1 S01 (1080p BluRay x265 HEVC 10bit AAC 2.0 Silence)', 'Season 1 › Deleted Scenes');
extra('tv/Futurama (1999) Season 1-7 S01-S07 + Extras (Mixed x265 HEVC 10bit AAC 5.1 RCVR) REPACK/Season 6/Featurettes/Delivery Boy Man Episode 1.mkv',
  'tv/Futurama (1999) Season 1-7 S01-S07 + Extras (Mixed x265 HEVC 10bit AAC 5.1 RCVR) REPACK/Season 6', 'Season 6 › Featurettes');
extra('filmz/tarantino/Kill Bill Vol. 1 (2003) (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)/Featurettes/Kill Bill Vol. 2 (teaser).mkv',
  'filmz/tarantino/Kill Bill Vol. 1 (2003) (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence)', 'Featurettes');
extra('Movies/Heat (1995)/Heat (1995)-trailer.mkv', 'Movies/Heat (1995)');
extra('docs/Symbiopsychotaxiplasm - Two Takes by William Greaves/Theatrical Trailer.avi', 'docs/Symbiopsychotaxiplasm - Two Takes by William Greaves');

// Folders that only mention extras in their name are the show or movie itself.
movie('tv/Trailer Park Boys S01-S10 + Movies + Specials + Extras [Ultimate Collection]-GRP/Movies/TPB The Movie (2006) [1080p] [HEVC] [BluRay]/TPB The Movie (2006) [1080p] [HEVC] [BluRay].mkv', 'TPB The Movie', 2006);
movie('filmz/thriller_drama/Network (1976) + Extras (1080p BluRay x265 HEVC 10bit AAC 1.0 afm72)/Network (1976).mkv', 'Network', 1976);
// Plex's "Other" folder is not treated as extras: here it holds the Futurama movies.
movie("tv/Futurama (1999) Season 1-7 S01-S07 + Extras (Mixed x265 HEVC 10bit AAC 5.1 RCVR) REPACK/Other/Futurama Bender's Big Score (2008)/Futurama Bender's Big Score (2008) (1080p WEB-DL x265 RCVR).mkv", "Futurama Bender's Big Score", 2008);
movie('Movies/Trailer Park Boys Countdown to Liquor Day (2009).mkv', 'Trailer Park Boys Countdown to Liquor Day', 2009);
// Numbered specials filed under Extras stay episodes.
episode('tv/South Park  (1080p x265 q22 Joy)/Extras/South Park S00E01 Jesus vs. Frosty.mkv', 'South Park', 0, 1);
