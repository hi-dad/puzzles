-- One row per puzzle per person. `data` is the puzzle record the app keeps on each
-- device (name, piece count, positions, timer, thumbnail) as JSON. Deleted puzzles
-- keep a tombstone row so other devices learn to delete them too.
CREATE TABLE IF NOT EXISTS puzzles (
  owner      TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  data       TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (owner, id)
);
