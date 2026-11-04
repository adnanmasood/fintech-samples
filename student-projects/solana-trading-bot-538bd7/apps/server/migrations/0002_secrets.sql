-- Encrypted secrets, one row per name. The value is never stored in the clear
-- and is never part of the settings document that the API serves.
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
