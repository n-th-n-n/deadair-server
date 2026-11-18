-- App settings that should follow Deadair between machines (e.g. the TMDB key).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
