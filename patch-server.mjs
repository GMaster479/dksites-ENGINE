// Adds /api/upload and /api/import-image to src/api/server.js WITHOUT replacing the file,
// so the fixes already living there (trust proxy, nested lookup paths, deploy-on-generate,
// redeploy-on-edit) survive. Safe to run twice — it detects its own work.
//
//   node patch-server.mjs
//
import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'src/api/server.js';
const UPLOAD_BLOCK = String.raw`
// ---- Upload a logo / menu / photo into a preview -------------------------------
// Base64 JSON rather than multipart: no extra dependency to install on the box, and the
// files are small. Everything lands inside the preview's own images/ dir, so nothing is
// re-downloaded later and the generator can reference it by relative path.
const UPLOAD_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

async function storeUpload(previewId, kind, ext, buf) {
  const { join } = await import('node:path');
  const { mkdir, writeFile, readdir } = await import('node:fs/promises');
  const previewDir = join(config.previewDir, previewId);
  let assetPath;
  if (kind === 'menu') {
    assetPath = 'uploads/menu.' + ext;
  } else if (kind === 'logo') {
    assetPath = 'images/logo-upload.' + ext;
  } else {
    let n = 1;
    try {
      const existing = await readdir(join(previewDir, 'images'));
      n = existing.filter((f) => f.startsWith('upload-')).length + 1;
    } catch {}
    assetPath = 'images/upload-' + n + '.' + ext;
  }
  const full = join(previewDir, assetPath);
  await mkdir(join(previewDir, assetPath.split('/')[0]), { recursive: true });
  await writeFile(full, buf);
  return { assetPath, full };
}

app.post('/api/upload', async (req, res) => {
  try {
    const { previewId, kind, mimeType, dataBase64 } = req.body || {};
    if (!previewId || !kind || !dataBase64) return res.status(400).json({ error: 'previewId, kind and dataBase64 required' });
    if (!['logo', 'menu', 'photo'].includes(kind)) return res.status(400).json({ error: 'kind must be logo, menu or photo' });
    const ext = UPLOAD_EXT[mimeType];
    if (!ext) return res.status(415).json({ error: 'Unsupported file type. Use PNG, JPG, WEBP, GIF or PDF.' });
    if (kind !== 'menu' && ext === 'pdf') return res.status(415).json({ error: 'Logos and photos must be images.' });
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Empty file.' });
    if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'File is too large (12MB max).' });
    const { assetPath, full } = await storeUpload(previewId, kind, ext, buf);
    res.json({ kind, assetPath, path: full, bytes: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import an image the owner already has online. We DOWNLOAD and self-host it — never
// hotlink — so their site can't break when someone else's server changes. If the fetch
// fails we say so plainly and ask them to upload the file instead.
app.post('/api/import-image', async (req, res) => {
  const CANT = 'Could not download that image. Save it to your device and upload it instead.';
  try {
    const { previewId, url, kind = 'photo' } = req.body || {};
    if (!previewId || !url) return res.status(400).json({ error: 'previewId and url required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Use a full http(s) image address.' });
    let r;
    try {
      r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch { return res.status(422).json({ error: CANT }); }
    if (!r.ok) return res.status(422).json({ error: CANT });
    const mimeType = (r.headers.get('content-type') || '').split(';')[0].trim();
    const ext = UPLOAD_EXT[mimeType];
    if (!ext || ext === 'pdf') return res.status(415).json({ error: 'That address is not an image file.' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return res.status(422).json({ error: CANT });
    if (buf.length > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'That image is too large (12MB max).' });
    const { assetPath, full } = await storeUpload(previewId, kind === 'logo' ? 'logo' : 'photo', ext, buf);
    res.json({ kind, assetPath, path: full, bytes: buf.length, importedFrom: url });
  } catch { res.status(422).json({ error: CANT }); }
});

`;

let src = await readFile(FILE, 'utf8');
const steps = [];

if (src.includes("app.post('/api/import-image'")) {
  console.log('- uploads + image import already present, nothing to do.');
  process.exit(0);
}

const anchor = "app.post('/api/apply-edit'";
if (!src.includes(anchor)) {
  console.error('x Could not find the /api/apply-edit route. Nothing written.');
  process.exit(1);
}

if (src.includes("app.post('/api/upload'")) {
  // Older patch already applied — add only the import route.
  const importBlock = UPLOAD_BLOCK.slice(UPLOAD_BLOCK.indexOf('// Import an image'));
  src = src.replace(anchor, importBlock + anchor);
  await writeFile(FILE, src);
  console.log('OK added /api/import-image');
  process.exit(0);
}

const limitRe = /express\.json\(\{\s*limit:\s*'[^']+'\s*\}\)/;
if (limitRe.test(src)) {
  src = src.replace(limitRe, "express.json({ limit: '24mb' })");
  steps.push('raised express.json limit to 24mb');
} else if (src.includes('express.json()')) {
  src = src.replace('express.json()', "express.json({ limit: '24mb' })");
  steps.push('added 24mb express.json limit');
} else {
  console.error('x Could not find the express.json() line. Nothing written.');
  process.exit(1);
}

src = src.replace(anchor, UPLOAD_BLOCK + anchor);
steps.push('inserted /api/upload and /api/import-image');

const destructRe = /const \{ previewId, instruction(?:, slug)? \} = req\.body \|\| \{\};/;
if (!destructRe.test(src)) {
  console.error('x Could not find the apply-edit destructuring. Nothing written.');
  process.exit(1);
}
src = src.replace(destructRe, 'const { previewId, instruction, slug, logoFile, menuFile, photoFiles } = req.body || {};');
steps.push('apply-edit reads logoFile / menuFile / photoFiles');

const callRe = /await applyEdit\(previewId, \{ instruction: instruction \|\| null \}\);/;
if (!callRe.test(src)) {
  console.error('x Could not find the applyEdit(...) call. Nothing written.');
  process.exit(1);
}
src = src.replace(callRe, `await applyEdit(previewId, {
      instruction: instruction || null,
      logoFile: logoFile || null,
      menuFilePath: menuFile?.path || null,
      photoFiles: Array.isArray(photoFiles) ? photoFiles : [],
    });`);
steps.push('applyEdit call forwards the uploads');

await writeFile(FILE, src);
console.log('OK patched src/api/server.js');
for (const s of steps) console.log('   - ' + s);
