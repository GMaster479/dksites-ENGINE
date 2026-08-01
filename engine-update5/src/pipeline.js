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
  const { dryRun = false, factsFile = null, skipQA = false } = opts;

  // 1. EXTRACT (or load fixture for offline dry runs)
  let facts;
  if (factsFile) {
    log(`Loading facts fixture: ${factsFile}`);
    facts = JSON.parse(await readFile(factsFile, 'utf8'));
  } else {
    log(`Extracting business facts for: ${query}`);
    facts = await extractBusinessFacts(query);
  }

  // 2. TRIAGE
  facts = await triage(facts, { vision: !dryRun });
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
  const preview = await writePreview(facts, decisions, generated);
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
