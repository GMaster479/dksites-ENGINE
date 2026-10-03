import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One SQLite file on the box. Node 22 ships SQLite built in (node:sqlite), so there is
// nothing to install or compile, and a single file is trivial to back up.
//
// Tables:
//   users         — one row per person (email is the identity; Google links to it)
//   login_tokens  — single-use magic-link tokens (stored HASHED, 15 minute life)
//   sessions      — signed-in browsers (stored HASHED, 30 day life)
//   builds        — previews someone has claimed; unclaimed previews stay anonymous
//   sites         — paid launches: what they bought, when it renews, auto-renew opt-in

const DB_PATH = process.env.DB_PATH || './db/dksites.sqlite';

let db = null;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT,
      google_sub    TEXT UNIQUE,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      return_to  TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS builds (
      preview_id  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug        TEXT,
      name        TEXT,
      preview_url TEXT,
      claimed_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sites (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
      preview_id            TEXT,
      slug                  TEXT,
      domain                TEXT,
      own_domain            INTEGER NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'active',
      amount_cents          INTEGER,
      auto_renew            INTEGER NOT NULL DEFAULT 0,
      stripe_session_id     TEXT UNIQUE,
      stripe_customer_id    TEXT,
      stripe_payment_intent TEXT,
      paid_at               INTEGER,
      renews_at             INTEGER,
      reminder30_at         INTEGER,
      reminder7_at          INTEGER,
      created_at            INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_builds_user ON builds(user_id);
    CREATE INDEX IF NOT EXISTS idx_sites_user  ON sites(user_id);
    CREATE INDEX IF NOT EXISTS idx_sites_renew ON sites(renews_at);
  `);
  return db;
}

export const now = () => Date.now();
export const DAY = 24 * 60 * 60 * 1000;
