import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * Write a generated site to PREVIEW_DIR/<id>/ and (on first build) download referenced
 * assets so the preview is self-contained. On edits, pass the existing id + skipAssets to
 * overwrite the code in place, bump the version, and keep an edit history.
 *
 * @param {object} facts
 * @param {object} decisions  brand design decisions (persisted for the editor)
 * @param {object} generated  { files, signature_element, notes }
 * @param {object} opts        { id, skipAssets, editInstruction }
 */
export async function writePreview(facts, decisions, generated, opts = {}) {
  const { id = randomUUID(), skipAssets = false, editInstruction = null } = opts;
  const dir = join(config.previewDir, id);
  await mkdir(dir, { recursive: true });

  // Load prior build (for version/history) if this is an edit.
  let prior = null;
  const buildPath = join(dir, '_build.json');
  if (existsSync(buildPath)) {
    try { prior = JSON.parse(await readFile(buildPath, 'utf8')); } catch {}
  }

  const written = [];
  for (const file of generated.files) {
    const full = join(dir, file.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.contents, 'utf8');
    written.push(file.path);
  }

  let assets = prior?.assets || [];
  if (!skipAssets) {
    assets = await downloadAssets(facts, dir);
  }

  const version = (prior?.version || 0) + 1;
  const history = prior?.history || [];
  if (editInstruction) history.push({ at: new Date().toISOString(), version, instruction: editInstruction });

  await writeFile(
    buildPath,
    JSON.stringify({ version, history, facts, decisions, generated, assets }, null, 2)
  );

  return { id, dir, url: `${config.previewBaseUrl}/${id}/`, written, assets, version };
}

async function downloadAssets(facts, dir) {
  const assetMap = (facts.triage?.rankedPhotos || facts.assets.photos || [])
    .slice(0, 10)
    .map((p, i) => ({ url: p.url, path: `images/photo-${i + 1}.webp` }));
  if (facts.assets.logo) assetMap.push({ url: facts.assets.logo, path: 'images/logo.png' });
  if (facts.assets.favicon) assetMap.push({ url: facts.assets.favicon, path: 'favicon.ico' });

  const assets = [];
  await mkdir(join(dir, 'images'), { recursive: true });
  for (const a of assetMap) {
    try {
      const res = await fetch(a.url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { assets.push({ path: a.path, ok: false, status: res.status }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const full = join(dir, a.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, buf);
      assets.push({ path: a.path, ok: true, bytes: buf.length });
    } catch (e) {
      assets.push({ path: a.path, ok: false, error: String(e.message || e) });
    }
  }
  return assets;
}
