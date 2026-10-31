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

-- One row per signed-in device. Only a hash of the session token is stored, so a copy of
-- this table can't be used to sign in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  owner      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (owner);

-- Display names other players see when playing a puzzle together.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name  TEXT
);

-- Apple refresh tokens, kept only so deleting an account can disconnect Sign in with Apple.
CREATE TABLE IF NOT EXISTS apple_tokens (
  email         TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  PRIMARY KEY (email, client_id)
);
