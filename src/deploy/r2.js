import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { config } from '../config.js';

// Pushes a built preview folder to R2 under clients/<slug>/ so the Worker can serve it
// at <slug>.dksites.com. R2 speaks the S3 API; credentials are an R2 access key pair
// (Cloudflare dashboard → R2 → Manage R2 API Tokens), kept in env, never in the repo.

const TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json',
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
  webm: 'video/webm', mp4: 'video/mp4', woff2: 'font/woff2', woff: 'font/woff',
};
const SKIP = (rel) => rel === '_build.json' || rel.startsWith('qa-');

function s3() {
  if (!config.cfAccountId || !config.r2AccessKeyId || !config.r2SecretKey) {
    throw new Error('R2 deploy needs CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in env.');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.cfAccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretKey },
  });
}

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, out);
    else out.push(full);
  }
  return out;
}

function typeFor(path) {
  return TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

/** Upload previewDir -> clients/<slug>/.  Returns the live preview URL + key list. */
export async function deployPreview(previewDir, slug) {
  const client = s3();
  const files = await walk(previewDir);
  const uploaded = [];
  for (const f of files) {
    const rel = relative(previewDir, f).split(sep).join('/');
    if (SKIP(rel)) continue;
    const Key = `clients/${slug}/${rel}`;
    await client.send(new PutObjectCommand({
      Bucket: config.r2Bucket, Key, Body: await readFile(f), ContentType: typeFor(f),
    }));
    uploaded.push(Key);
  }
  return { slug, url: `https://${slug}.${config.previewHost}/`, uploaded };
}

/** Map a live custom domain -> slug, so the Worker serves the right site for it. */
export async function mapCustomDomain(host, slug) {
  const client = s3();
  await client.send(new PutObjectCommand({
    Bucket: config.r2Bucket,
    Key: `routes/${host.toLowerCase()}.json`,
    Body: JSON.stringify({ slug, host, mappedAt: new Date().toISOString() }),
    ContentType: 'application/json',
  }));
  return { host, slug };
}
