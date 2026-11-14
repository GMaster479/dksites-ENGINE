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
//   sites         — paid launches: what they bought, when it renews, auto-renew opt-in,
//                   and live launch progress
//   meta          — small key/value facts (last backup)

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

    -- Small key/value store (last backup time, etc.)
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Nov 14: edits are saved jobs, so they finish (and survive a restart) even if the
    -- owner closes the app, and the app can find a running edit when they come back.
    CREATE TABLE IF NOT EXISTS edit_jobs (
      id             TEXT PRIMARY KEY,
      preview_id     TEXT NOT NULL,
      user_id        INTEGER,
      status         TEXT NOT NULL,      -- queued | running | done | error
      stage          TEXT,
      progress       REAL,
      request_json   TEXT NOT NULL,
      result_json    TEXT,
      error          TEXT,
      start_version  INTEGER,
      attempts       INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_polled_at INTEGER,
      notified_at    INTEGER,
      notified_how   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edit_jobs_preview ON edit_jobs(preview_id, created_at);

    -- Phones/browsers that asked to be told when an edit finishes (Web Push).
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keys_json  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);

    -- Facebook Page / Instagram account connected to a build. Tokens are encrypted.
    CREATE TABLE IF NOT EXISTS meta_connections (
      preview_id    TEXT PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fb_user_id    TEXT,
      pages_enc     TEXT,               -- the Pages they could pick from (encrypted, with tokens)
      page_id       TEXT,
      page_name     TEXT,
      page_token_enc TEXT,
      ig_id         TEXT,
      ig_username   TEXT,
      data_json     TEXT,               -- latest profile + posts we read
      fetched_at    INTEGER,
      feed_on       INTEGER NOT NULL DEFAULT 0,
      feed_synced_at INTEGER,
      created_at    INTEGER NOT NULL
    );
  `);
  migrate(db);
  return db;
}

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS", so
// check what's there and add only what's missing. Safe to run on every boot.
const SITE_COLUMNS = {
  launch_status:         'TEXT',    // starting | running | done | needs_attention | error
  launch_steps:          'TEXT',    // JSON [{ key, label, state, detail }]
  launch_error:          'TEXT',
  launch_updated_at:     'INTEGER',
  zone_id:               'TEXT',
  nameservers:           'TEXT',    // JSON array
  registered_at:         'INTEGER', // set once the domain is bought — a retry must never buy it twice
  auto_renew_changed_at: 'INTEGER',
  renew_payment_method:  'TEXT',    // Stripe payment method saved for next year's renewal
};

function migrate(d) {
  const have = new Set(d.prepare('PRAGMA table_info(sites)').all().map((c) => c.name));
  for (const [col, type] of Object.entries(SITE_COLUMNS)) {
    if (!have.has(col)) d.exec(`ALTER TABLE sites ADD COLUMN ${col} ${type}`);
  }
}

export function getMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

export const dbPath = () => DB_PATH;

export const now = () => Date.now();
export const DAY = 24 * 60 * 60 * 1000;
