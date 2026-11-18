// Stable identities for what a video *is*, independent of where the file lives.
// Watch history and TMDB matches are keyed by these (not by file path), so they
// survive moving the library to another folder or another machine.
const { slug } = require('./parse');

// "movie:blade-runner-2049:2017": every copy of a movie shares one key.
const movieKey = (item) => `movie:${slug(item.title)}:${item.year ?? ''}`;

// "show:breaking-bad": TMDB match for a whole show.
const showMatchKey = (showKey) => `show:${showKey}`;

// Watch-history key: the movie, show + season + episode, or the extra by where it sits in the
// library (titles like "Part 1" or "Menu Art" repeat, so the name alone isn't enough).
function mediaKey(item) {
  if (item.kind === 'extra') return `extra:${slug(item.extraPath || item.title)}`;
  if (item.kind !== 'episode') return movieKey(item);
  return `ep:${item.showKey}:${item.season}:${item.episode ?? slug(item.title)}`;
}

module.exports = { movieKey, showMatchKey, mediaKey };
