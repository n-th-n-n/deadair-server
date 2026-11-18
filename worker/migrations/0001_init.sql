-- Deadair's own data. The file index (paths, codecs) stays on the home server; a scan rebuilds it.

-- Library folders on the home server.
CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Watch history per account, keyed by title ("movie:dune:2021", "ep:futurama:2:1"), not file path.
CREATE TABLE progress (
  user_id TEXT NOT NULL,
  media_key TEXT NOT NULL,
  position REAL NOT NULL,
  duration REAL,
  watched INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_key)
);

-- TMDB matches ("movie:…" / "show:…") as JSON: { meta } or { miss }.
CREATE TABLE matches (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-account session state (revocation records) as JSON.
CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
