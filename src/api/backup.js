import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../config.js';
import { getDb, getMeta, setMeta, dbPath } from './db.js';
import { requireUser, requireAdmin } from './accounts.js';

// NIGHTLY DATABASE BACKUP -> R2
//
// Every account, sale, renewal date and auto-renew choice lives in ONE file on the box.
// If the box dies, that file is the business. So once a day:
//   1. VACUUM INTO a snapshot — SQLite's own consistent copy, safe while the API is running
//   2. gzip it and upload to R2 at backups/db/YYYY-MM-DD.sqlite.gz
//   3. keep 30 days in R2 and 3 days on the box (db/backups/)
//
// Bucket: R2_BACKUP_BUCKET if set, otherwise the same bucket as the sites. That is safe:
// the Worker only ever serves keys under clients/<slug>/ and routes/, never backups/.
// (Keep the bucket's public r2.dev URL turned off — it is off unless someone enabled it.)
//
// Runs ~3:30 AM Eastern (07:30 UTC). Checks hourly; skips if today's is already done.

const KEEP_REMOTE_DAYS = 30;
const KEEP_LOCAL = 3;
const RUN_AFTER_UTC_HOUR = 7;
const PREFIX = 'backups/db/';

const bucket = () => process.env.R2_BACKUP_BUCKET || config.r2Bucket;
const today = () => new Date().toISOString().slice(0, 10);

function s3() {
  if (!config.cfAccountId || !config.r2AccessKeyId || !config.r2SecretKey) {
    throw new Error('Backups need CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in env.');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.cfAccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretKey },
  });
}

/** Make the snapshot, upload it, prune old ones. Returns what happened. */
export async function runBackup({ reason = 'nightly' } = {}) {
  const started = Date.now();
  const day = today();
  const localDir = join(dirname(dbPath()), 'backups');
  mkdirSync(localDir, { recursive: true });
  const snap = join(localDir, `${day}.sqlite`);
  if (existsSync(snap)) rmSync(snap); // VACUUM INTO refuses to overwrite

  getDb().exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  const gz = gzipSync(readFileSync(snap), { level: 9 });
  rmSync(snap);
  writeFileSync(`${snap}.gz`, gz);

  const client = s3();
  const Key = `${PREFIX}${day}.sqlite.gz`;
  await client.send(new PutObjectCommand({
    Bucket: bucket(), Key, Body: gz, ContentType: 'application/gzip',
    Metadata: { reason, created: new Date().toISOString() },
  }));

  // Prune R2: anything older than KEEP_REMOTE_DAYS.
  const cutoff = new Date(Date.now() - KEEP_REMOTE_DAYS * 86400000).toISOString().slice(0, 10);
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: PREFIX }));
  const old = (listed.Contents || []).filter((o) => {
    const d = o.Key.slice(PREFIX.length, PREFIX.length + 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff;
  });
  if (old.length) {
    await client.send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: old.map((o) => ({ Key: o.Key })) } }));
  }

  // Prune the box: newest KEEP_LOCAL only.
  const locals = readdirSync(localDir).filter((f) => f.endsWith('.sqlite.gz')).sort().reverse();
  for (const f of locals.slice(KEEP_LOCAL)) rmSync(join(localDir, f));

  const info = {
    key: Key, bucket: bucket(), bytes: gz.length, at: Date.now(), ms: Date.now() - started, reason,
    pruned: old.length, remoteCount: (listed.Contents || []).length - old.length,
  };
  setMeta('last_backup', JSON.stringify(info));
  setMeta('last_backup_error', null);
  console.log(`💾 DB backup ${Key} (${(gz.length / 1024).toFixed(1)} KB) -> R2 ${bucket()}`);
  return info;
}

export function lastBackup() {
  try { return JSON.parse(getMeta('last_backup')) || null; } catch { return null; }
}

async function tick() {
  const last = lastBackup();
  const lastDay = last ? new Date(last.at).toISOString().slice(0, 10) : null;
  if (lastDay === today()) return;
  if (new Date().getUTCHours() < RUN_AFTER_UTC_HOUR && last) return; // wait for the quiet hours…
  // …unless there has never been a backup at all: then take one right away.
  try { await runBackup({ reason: last ? 'nightly' : 'first' }); }
  catch (e) {
    setMeta('last_backup_error', JSON.stringify({ at: Date.now(), message: e.message }));
    console.error('✗ DB backup failed:', e.message);
  }
}

export function mountBackups(app) {
  setTimeout(tick, 90 * 1000).unref();
  setInterval(tick, 60 * 60 * 1000).unref();

  app.get('/api/admin/backups', requireUser, requireAdmin, async (_req, res) => {
    let error = null;
    try { error = JSON.parse(getMeta('last_backup_error')); } catch {}
    let local = [];
    try {
      const dir = join(dirname(dbPath()), 'backups');
      local = readdirSync(dir).filter((f) => f.endsWith('.gz')).sort().reverse()
        .map((f) => ({ file: f, bytes: statSync(join(dir, f)).size }));
    } catch {}
    res.json({ last: lastBackup(), error, local, bucket: bucket(), prefix: PREFIX });
  });

  app.post('/api/admin/backup-now', requireUser, requireAdmin, async (_req, res) => {
    try { res.json(await runBackup({ reason: 'manual' })); }
    catch (e) {
      setMeta('last_backup_error', JSON.stringify({ at: Date.now(), message: e.message }));
      res.status(500).json({ error: e.message });
    }
  });
}
