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

  // Debug contact sheet: every downloaded photo next to the label vision gave it.
  // Deployed with the site, so it's viewable at <slug>.dksites.com/_labels.html —
  // the fastest way to see whether a bad placement is a MISLABEL or a placement failure.
  await writeLabelSheet(facts, dir);

  return { id, dir, url: `${config.previewBaseUrl}/${id}/`, written, assets, version };
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function writeLabelSheet(facts, dir) {
  const photos = (facts.triage?.rankedPhotos || []).slice(0, 10);
  if (!photos.length) return;

  const cards = photos
    .map((p, i) => {
      const path = `images/photo-${i + 1}.webp`;
      const conf = p.activityConfidence != null ? ` (${Math.round(p.activityConfidence * 100)}%)` : '';
      const issues = p.issues?.length ? `<div class="row warn">issues: ${esc(p.issues.join(', '))}</div>` : '';
      return `<figure>
  <img src="${path}" alt="" loading="lazy">
  <figcaption>
    <div class="file">${path}</div>
    <div class="act">${p.activity ? esc(p.activity) + esc(conf) : 'general (no activity)'}</div>
    <div class="row">${esc(p.caption || '(unlabeled)')}</div>
    <div class="row dim">kind: ${esc(p.kind || '-')}${p.isHero ? ' · RECOMMENDED HERO' : ''}${p.heroGrade ? ' · hero-grade' : ''}</div>
    ${issues}
  </figcaption>
</figure>`;
    })
    .join('\n');

  const html = `<!doctype html>
<meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photo labels — ${esc(facts.identity?.name || 'preview')}</title>
<style>
  body{background:#111;color:#eee;font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px}
  h1{font-size:1.2rem;margin:0 0 4px}
  .sum{color:#9a958b;margin:0 0 20px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
  figure{margin:0;background:#1c1c1c;border:1px solid #333;border-radius:10px;overflow:hidden}
  img{width:100%;height:190px;object-fit:cover;display:block;background:#000}
  figcaption{padding:10px 12px}
  .file{font-family:ui-monospace,monospace;font-size:.75rem;color:#8a8a8a}
  .act{font-weight:600;color:#E8C17A;margin:2px 0 6px}
  .row{margin:2px 0}
  .dim{color:#9a958b;font-size:.85rem}
  .warn{color:#e0a1a1;font-size:.85rem}
</style>
<h1>Photo labels — ${esc(facts.identity?.name || 'preview')}</h1>
<p class="sum">${esc(facts.triage?.photoSummary || 'No vision summary.')}</p>
<div class="grid">
${cards}
</div>`;

  try { await writeFile(join(dir, '_labels.html'), html, 'utf8'); } catch {}
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
