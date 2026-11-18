-- What is on each library drive, one row per file, so the list survives losing the drive.
-- Written by `npm run inventory` (scripts/inventory.mjs) through /inventory/*; not part of the
-- normal sync and never loaded at startup. Rows not seen in a drive's latest run are removed.
CREATE TABLE inventory (
  drive TEXT NOT NULL,     -- library name, e.g. "Home Drive"
  path TEXT NOT NULL,      -- path inside the library folder
  size INTEGER NOT NULL,   -- bytes
  mtime INTEGER NOT NULL,  -- last modified, ms since epoch
  snapshot TEXT NOT NULL,  -- when the run that last saw it started (ISO time)
  PRIMARY KEY (drive, path)
);
