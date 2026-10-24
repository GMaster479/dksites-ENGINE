import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { getDb } from './db.js';
import { requireUser, isAdmin } from './accounts.js';

// Oct 24 additions:
//   - preview ids are validated before any route touches the disk with them
//   - uploads are rate-limited (they're anonymous by design)
//   - DELETE /api/builds/:previewId  — an owner removes a preview from their account
//   - GET    /api/socials?website=   — find social profiles on their current site, so the
//                                      app can pre-fill them for JSON-LD sameAs

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

function s3() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.cfAccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretKey },
  });
}

/** Delete every R2 object under a prefix. Returns how many were removed. */
export async function deleteR2Prefix(prefix) {
  if (!prefix || !prefix.endsWith('/') || prefix.length < 10) throw new Error('Refusing to delete an unsafe prefix.');
  const client = s3();
  let removed = 0;
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: config.r2Bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length) {
      await client.send(new DeleteObjectsCommand({ Bucket: config.r2Bucket, Delete: { Objects: keys } }));
      removed += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

const SOCIAL_RE = /https?:\/\/(?:www\.|m\.)?(facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|yelp\.com|linkedin\.com|pinterest\.com|threads\.net)\/[^\s"'<>#?)]+/gi;
const NOT_A_PROFILE = /\/(sharer|share|intent|plugins|dialog|tr|p|reel|reels|watch|status|posts|photo|photos|events|hashtag|explore|embed)(\/|$)|\.(php|js|css|png|jpg)$/i;

/** Pure: pull likely profile links out of a page's HTML. */
export function findSocials(html) {
  const found = new Map(); // one per platform, first wins (usually the header/footer link)
  for (const m of String(html || '').matchAll(SOCIAL_RE)) {
    let url = m[0].replace(/\/+$/, '');
    if (NOT_A_PROFILE.test(new URL(url).pathname)) continue;
    const host = m[1].toLowerCase().replace('twitter.com', 'x.com');
    url = url.replace(/^http:/, 'https:').replace('://m.', '://www.');
    if (!found.has(host)) found.set(host, url);
  }
  return [...found.values()];
}

export function mountBuilds(app) {
  // ---- preview id validation (path-traversal guard) + upload rate limit ----
  const badId = (id) => id != null && id !== '' && !SAFE_ID.test(String(id));
  app.use(['/api/upload', '/api/import-image', '/api/apply-edit', '/api/domain/connect', '/api/generate'], (req, res, next) => {
    if (badId(req.body?.previewId) || badId(req.body?.draftId)) return res.status(400).json({ error: 'Invalid preview id.' });
    next();
  });
  app.use('/api/edit-options/:previewId', (req, res, next) => {
    if (badId(req.params.previewId)) return res.status(400).json({ error: 'Invalid preview id.' });
    next();
  });
  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many uploads from this connection. Try again in a little while.' },
  });
  app.use(['/api/upload', '/api/import-image'], uploadLimiter);

  // ---- delete a preview ----
  app.delete('/api/builds/:previewId', requireUser, async (req, res) => {
    const id = req.params.previewId;
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Invalid preview id.' });
    const db = getDb();
    const b = db.prepare('SELECT * FROM builds WHERE preview_id = ?').get(id);
    if (!b) return res.status(404).json({ error: 'That preview isn’t on your account.' });
    if (b.user_id !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'That preview belongs to another account.' });
    if (db.prepare('SELECT 1 FROM sites WHERE preview_id = ?').get(id)) {
      return res.status(409).json({ error: 'This one is a live site you paid for, so it can’t be deleted here. Email dylan@dksitesllc.com if you want it taken down.' });
    }

    db.prepare('DELETE FROM builds WHERE preview_id = ?').run(id);
    try { await rm(join(config.previewDir, id), { recursive: true, force: true }); } catch {}

    // Take the preview page down — unless the same address is used by a paid site or
    // another saved preview (two builds of the same business share a preview address).
    let removed = 0;
    const slug = b.slug;
    const sharedSlug = slug && (
      db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug) ||
      db.prepare('SELECT 1 FROM builds WHERE slug = ?').get(slug)
    );
    if (slug && !sharedSlug && /^[a-z0-9-]{2,60}$/.test(slug)) {
      try { removed = await deleteR2Prefix(`clients/${slug}/`); }
      catch (e) { console.error('✗ preview R2 delete:', e.message); }
    }
    console.log(`🗑  preview ${id} (${b.name || slug || 'untitled'}) deleted by ${req.user.email}${removed ? ` — ${removed} files removed` : ''}`);
    res.json({ deleted: true, previewId: id });
  });

  // ---- social profiles on their current site ----
  app.get('/api/socials', async (req, res) => {
    try {
      let site = String(req.query.website || '').trim();
      if (!site) return res.json({ socials: [] });
      if (!/^https?:\/\//i.test(site)) site = `https://${site}`;
      const u = new URL(site);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) {
        return res.json({ socials: [] });
      }
      const r = await fetch(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (DK Sites Builder)' } });
      if (!r.ok) return res.json({ socials: [] });
      const html = (await r.text()).slice(0, 600000);
      res.json({ socials: findSocials(html) });
    } catch {
      res.json({ socials: [] });
    }
  });
}
