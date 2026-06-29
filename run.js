#!/usr/bin/env node
import { runPipeline } from './src/pipeline.js';
import { assertLiveKeys } from './src/config.js';
import { loadBuild, buildEditOptions, applyEdit } from './src/edit/edit.js';
import { deployPreview } from './src/deploy/r2.js';
import { checkAvailability, getRegisterPrice, tldOf } from './src/launch/namecheap.js';
import { buildQuote, formatQuote } from './src/launch/pricing.js';
import { createCheckout } from './src/launch/stripe.js';

// BUILD a new site:
//   node run.js "Cole's Road Brewing, Wallingford CT"
//   node run.js --dry-run --facts data/sample-business.json
//   node run.js "Cole's Road Brewing" --skip-qa
//
// EDIT an existing preview:
//   node run.js --edit <preview-id> "make the headings a chunky retro slab"
//   node run.js --edit <preview-id> --file rileys-menu.pdf "use the real menu"
//   node run.js --options <preview-id>     # print the editor options (zones A + B)

function parseArgs(argv) {
  const opts = { dryRun: false, factsFile: null, skipQA: false, editId: null, optionsId: null, file: null, deployId: null, slug: null, checkDomain: null, checkoutDomain: null, previewId: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--skip-qa') opts.skipQA = true;
    else if (a === '--facts') opts.factsFile = argv[++i];
    else if (a === '--edit') opts.editId = argv[++i];
    else if (a === '--options') opts.optionsId = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--deploy') opts.deployId = argv[++i];
    else if (a === '--slug') opts.slug = argv[++i];
    else if (a === '--check') opts.checkDomain = argv[++i];
    else if (a === '--checkout') opts.checkoutDomain = argv[++i];
    else if (a === '--preview') opts.previewId = argv[++i];
    else if (a === '--launch') opts.launchDomain = argv[++i];
    else if (a === '--live') opts.live = true;
    else if (a === '--webhook') opts.webhook = true;
    else positional.push(a);
  }
  opts.text = positional.join(' ').trim();
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

try {
  // ---- Start the Stripe webhook receiver ----
  if (opts.webhook) {
    await import('./src/launch/webhook-server.js'); // starts listening on import
  }

  // ---- Manually run the launch sequence (test without Stripe) ----
  else if (opts.launchDomain) {
    const { runLaunch } = await import('./src/launch/launch.js');
    const domain = opts.launchDomain.toLowerCase();
    const avail = await checkAvailability(domain);
    const info = avail.premium
      ? { price: avail.premiumPrice, years: 1 }
      : await getRegisterPrice(tldOf(domain));
    await runLaunch({
      domain, slug: opts.slug, previewId: opts.previewId,
      price: info.price, years: info.years, live: opts.live,
    });
  }

  // ---- Domain availability + itemized quote (free, no charge) ----
  else if (opts.checkDomain) {
    const domain = opts.checkDomain.toLowerCase();
    console.log(`› Checking ${domain}…`);
    const avail = await checkAvailability(domain);
    if (!avail.available) {
      console.log(`✗ ${domain} is NOT available${avail.premium ? ' (premium)' : ''}.`);
    } else {
      const info = avail.premium
        ? { price: avail.premiumPrice, years: 1, estimated: false }
        : await getRegisterPrice(tldOf(domain));
      const quote = buildQuote(info.price, { domain, years: info.years, verified: !info.estimated });
      const tag = info.estimated ? ' ⚠ price ESTIMATED — checkout will refuse until verified' : '';
      console.log(`✓ ${domain} is available${info.years > 1 ? ` (${info.years}-yr minimum term)` : ''}.${tag}\n`);
      console.log(formatQuote(quote));
    }
  }

  // ---- Build quote + create a TEST-MODE Stripe Checkout link ----
  else if (opts.checkoutDomain) {
    const domain = opts.checkoutDomain.toLowerCase();
    const avail = await checkAvailability(domain);
    if (!avail.available) { console.error(`✗ ${domain} is not available — cannot check out.`); process.exit(1); }
    const info = avail.premium
      ? { price: avail.premiumPrice, years: 1, estimated: false }
      : await getRegisterPrice(tldOf(domain));
    // Margin guard: never create a real charge on an unverified/estimated price.
    if (info.estimated) {
      console.error(`✗ Could not verify a real registration price for ${domain} from Namecheap.`);
      console.error(`  Refusing checkout on an estimated price — protects your margin (e.g. .ai is $89.98, not the $13.98 fallback).`);
      process.exit(1);
    }
    const quote = buildQuote(info.price, { domain, years: info.years, verified: true });
    console.log(formatQuote(quote), '\n');
    const session = await createCheckout({ quote, slug: opts.slug, previewId: opts.previewId });
    console.log(`› Stripe TEST checkout created. Pay with test card 4242 4242 4242 4242 (any future expiry, any CVC):`);
    console.log(`  ${session.url}`);
  }

  // ---- Deploy a built preview to R2 (serves at <slug>.dksites.com) ----
  else if (opts.deployId) {
    const slug = opts.slug || opts.deployId.slice(0, 8);
    const dir = `${(await import('./src/config.js')).config.previewDir}/${opts.deployId}`;
    console.log(`› Deploying ${opts.deployId} to R2 as "${slug}"…`);
    const res = await deployPreview(dir, slug);
    console.log(`✓ Uploaded ${res.uploaded.length} objects. Live at: ${res.url}`);
  }

  // ---- Editor: print options (zones A + B) ----
  else if (opts.optionsId) {
    assertLiveKeys({ requirePlaces: false });
    const build = await loadBuild(opts.optionsId);
    const options = await buildEditOptions(build);
    options.previewId = opts.optionsId;
    console.log(JSON.stringify(options, null, 2));
  }

  // ---- Editor: apply an edit (zone C / structured picks / menu upload) ----
  else if (opts.editId) {
    assertLiveKeys({ requirePlaces: false });
    if (!opts.text && !opts.file) {
      console.error('Edit needs an instruction and/or --file. Example:\n  node run.js --edit <id> "use a chunky slab headline"');
      process.exit(1);
    }
    console.log('› Applying edit…');
    const { preview, editInstruction, menuSummary } = await applyEdit(opts.editId, {
      instruction: opts.text || null,
      menuFilePath: opts.file || null,
    });
    if (menuSummary) console.log(`› Menu ingested: ${menuSummary}`);
    console.log(`› Applied: "${editInstruction}"`);
    console.log(`✓ Updated to v${preview.version}. Open: ${preview.url}`);
  }

  // ---- Build a new site ----
  else {
    if (!opts.text && !opts.factsFile) {
      console.error('Usage:\n  build:   node run.js "<business>, <city ST>" [--dry-run] [--facts <file>] [--skip-qa]\n  options: node run.js --options <preview-id>\n  edit:    node run.js --edit <preview-id> [--file <menu>] "<instruction>"');
      process.exit(1);
    }
    if (!opts.factsFile) assertLiveKeys({ requirePlaces: true });
    else if (!opts.dryRun) assertLiveKeys({ requirePlaces: false });

    const result = await runPipeline(opts.text || '(from fixture)', opts);
    if (result.preview) {
      console.log('\n✓ Done. Open the preview:');
      console.log('  npm run serve   # then visit', result.preview.url);
    }
  }
} catch (err) {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
}
