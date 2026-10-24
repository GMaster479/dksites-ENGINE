import { extractBusinessFacts } from './extract/index.js';
import { triage } from './triage/triage.js';
import { analyzeBrand } from './analyze/brand.js';
import { generateSite, buildGenerationPrompt } from './generate/generate.js';
import { writePreview } from './generate/writer.js';
import { screenshotPreview } from './qa/screenshot.js';
import { readFile } from 'node:fs/promises';

const log = (...a) => console.log('›', ...a);

/**
 * Full pipeline: extract -> triage -> analyze -> generate -> write -> QA.
 * @param {string} query  business name (+ locality)
 * @param {object} opts   { dryRun, factsFile, skipQA }
 */
export async function runPipeline(query, opts = {}) {
  const { dryRun = false, factsFile = null, skipQA = false, previewId = null, uploads = [], socials = null } = opts;

  // 1. EXTRACT (or load fixture for offline dry runs)
  // opts.facts = the business the owner CONFIRMED in the app (or the greenfield shell for
  // description-only builds). Use it as-is: re-extracting by name could resolve to a
  // different business, and a description is not a searchable business name.
  let facts;
  if (opts.facts) {
    log(`Using confirmed facts for: ${opts.facts.identity?.name || '(description build)'}`);
    facts = structuredClone(opts.facts);
  } else if (factsFile) {
    log(`Loading facts fixture: ${factsFile}`);
    facts = JSON.parse(await readFile(factsFile, 'utf8'));
  } else {
    log(`Extracting business facts for: ${query}`);
    facts = await extractBusinessFacts(query);
  }

  // 2. TRIAGE
  // If they already have a site, read it for real CONTENT — above all the menu, which
  // public APIs never carry and which is the most valuable thing on most old sites.
  if (!dryRun && facts.identity?.website && !facts.knownMenu) {
    try {
      const { readExistingSite } = await import('./extract/site-reader.js');
      log(`Reading their existing site: ${facts.identity.website}`);
      const site = await readExistingSite(facts.identity.website);
      if (site) {
        facts.existingSite = { pages: site.pages, text: site.text.slice(0, 20000) };
        log(`  read ${site.pages.length} page(s)`);
        if (site.knownMenu?._itemCount) {
          facts.knownMenu = site.knownMenu;
          log(`  pulled a real menu from their site: ${site.knownMenu._itemCount} items`);
        } else log('  no menu found on their site');
      } else log('  could not read it');
    } catch (e) { log(`  site read failed: ${e.message}`); }
  }

  // Social profiles the owner confirmed -> footer links + JSON-LD sameAs.
  if (Array.isArray(socials)) {
    const { cleanSocials } = await import('./edit/edit.js');
    facts.identity = { ...facts.identity, sameAs: cleanSocials(socials) };
    if (facts.identity.sameAs.length) log(`Social profiles: ${facts.identity.sameAs.join(', ')}`);
  }

  // Owner uploads from the start of the build (logo, outside/inside shots). They already
  // sit in this preview's folder, so they're never downloaded. The logo anchors the palette.
  const logoUp = uploads.find((u) => u.kind === 'logo' && u.path);
  if (logoUp) {
    facts.assets = { ...facts.assets, logo: logoUp.path, logoAssetPath: logoUp.assetPath, logoUploaded: true };
    log(`Owner logo: ${logoUp.assetPath}`);
  }

  facts = await triage(facts, { vision: !dryRun });

  const photoUps = uploads.filter((u) => u.kind === 'photo' && u.path);
  if (photoUps.length && !dryRun) {
    const added = photoUps.map((u) => ({
      url: null, assetPath: u.assetPath, path: u.path, source: 'upload', score: 7, heroGrade: true,
      ...(u.note ? { ownerNote: u.note, caption: u.note } : {}),
    }));
    try {
      const { describePhotos } = await import('./analyze/vision.js');
      const seen = await describePhotos(added.map((a) => ({ ...a, url: a.path })), {
        name: facts.identity?.name || null,
        type: facts.atmosphere?.primaryTypeDisplayName || null,
        summary: facts.atmosphere?.editorialSummary || null,
      });
      for (const label of seen?.photos || []) {
        const t = added[Number(label.i) - 1];
        if (!t) continue;
        // The owner's own label ("outside", "inside") wins; vision adds detail to it.
        t.caption = t.ownerNote ? `${t.ownerNote} — ${label.caption || ''}`.replace(/ — $/, '') : (label.caption || null);
        t.kind = label.kind || null;
        if (label.activity && (label.confidence ?? 1) >= 0.6) t.activity = label.activity;
      }
    } catch { /* unlabeled uploads still get used */ }
    // Owner photos go FIRST: they're the real place, so they're the best hero candidates.
    facts.triage = { ...facts.triage, rankedPhotos: [...added, ...(facts.triage.rankedPhotos || [])] };
    log(`Owner photos: ${added.length}`);
  }
  log(
    `Triage: ${facts.triage.greenfield ? 'GREENFIELD' : 'standard'} · ${facts.triage.usableCount} usable photos` +
      (facts.triage.labeled ? ' · photos labeled by vision' : '')
  );
  if (facts.triage.photoSummary) log(`Photos: ${facts.triage.photoSummary}`);
  if (facts.triage.labeled) {
    for (const [i, p] of (facts.triage.rankedPhotos || []).slice(0, 10).entries()) {
      log(`  photo-${i + 1}: [${p.activity || 'general'}] ${p.caption || '(unlabeled)'}`);
    }
  }
  if (facts.assets.logoFromPhotos) log('Logo found inside the photo set — using it for the palette.');
  if (facts.triage.suggestedAsks.length) log('Suggested asks:', facts.triage.suggestedAsks);

  if (dryRun) {
    // Don't spend tokens. Show what the brand+generation stages WOULD receive.
    const fakeDecisions = { palette: { dominant: '#?', accent: '#?', rationale: '(dry-run: brand stage skipped)' } };
    const prompt = await buildGenerationPrompt(facts, fakeDecisions);
    log('\n── DRY RUN: generation system prompt (rule spec) loaded:', prompt.system.length, 'chars');
    log('── DRY RUN: generation user payload preview ──\n');
    console.log(prompt.userText.slice(0, 2000) + '\n…(truncated)');
    return { dryRun: true, facts };
  }

  // 3. ANALYZE (brand decisions)
  log('Analyzing brand direction…');
  const decisions = await analyzeBrand(facts);
  log(`Palette: ${decisions.palette?.dominant} / ${decisions.palette?.accent} · Type: ${decisions.typography?.display} + ${decisions.typography?.body}`);
  log(`Signature element: ${decisions.signature_element?.concept}`);

  // 4. GENERATE
  log('Generating site…');
  const generated = await generateSite(facts, decisions);
  log(`Generated ${generated.files.length} files · signature: ${generated.signature_element}`);

  // 5. WRITE + download assets
  const preview = await writePreview(facts, decisions, generated, previewId ? { id: previewId } : {});
  log(`Preview written: ${preview.dir}`);
  log(`Preview URL: ${preview.url}`);

  // 6. QA screenshots (optional — never let a screenshot failure sink a good build)
  if (!skipQA) {
    try {
      const qa = await screenshotPreview(preview.dir);
      if (qa.skipped) log(`QA skipped: ${qa.reason}`);
      else log(`QA screenshots: ${qa.shots.map((s) => s.width).join(', ')}px`);
    } catch (e) {
      log(`QA skipped (screenshot step failed, site is fine): ${String(e.message || e).split('\n')[0]}`);
    }
  }

  return { dryRun: false, facts, decisions, generated, preview };
}
