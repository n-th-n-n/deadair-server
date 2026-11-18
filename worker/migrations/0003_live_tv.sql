-- Live TV. Channel schedules and downloaded guides stay on the home server; these are the settings.

-- Channels made from the library (content + order) as JSON.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Outside channel sources (M3U playlist + XMLTV guide addresses, selected channels) as JSON.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
