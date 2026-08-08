// DK Sites engine HTTP API — the bridge between app.dksites.com (React front end) and
// the pipeline. Also hosts the Stripe webhook (same always-on process, same static IP
// that Namecheap whitelists). Host-agnostic Express; runs anywhere Node runs.
//
//   PUBLIC (browser, CORS-locked to the app origin, rate-limited):
//     POST /api/lookup            { name, city }            -> business candidate
//     POST /api/generate          { mode, business|description } -> { jobId }
//     GET  /api/status/:jobId                                -> { status, stage, result }
//     GET  /api/edit-options/:previewId                      -> zones A+B options
//     POST /api/apply-edit        { previewId, instruction } -> { version }
//     GET  /api/check?domain=     domain availability + quote
//     POST /api/checkout          { domain, slug, previewId } -> { url }
//   STRIPE (raw body, signature-verified):
//     POST /api/webhook
//
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { loadBuild, buildEditOptions, applyEdit } from '../edit/edit.js';
import { checkAvailability, getRegisterPrice, tldOf } from '../launch/namecheap.js';
import { buildQuote } from '../launch/pricing.js';
import { createCheckout, constructEvent } from '../launch/stripe.js';
import { runLaunch } from '../launch/launch.js';
import { deployPreview } from '../deploy/r2.js';
import { createJob, updateJob, getJob } from './jobs.js';

const app = express();
app.set('trust proxy', 1); // behind Caddy — lets express-rate-limit read the real client IP
const ORIGIN = config.appOrigin || 'https://app.dksites.com';

// ---- Stripe webhook FIRST: needs the raw body, so it must precede express.json() ----
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('✗ Webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  res.json({ received: true });
  if (event.type === 'checkout.session.completed') {
    const m = event.data.object.metadata || {};
    console.log(`\n💸 Payment complete: ${m.domain} — $${(event.data.object.amount_total / 100).toFixed(2)}`);
    runLaunch({ domain: m.domain, slug: m.slug, previewId: m.previewId, price: m.domainPrice, years: parseInt(m.years || '1', 10) })
      .catch((e) => console.error('✗ Launch error:', e.message));
  }
});

// ---- Everything else: JSON + CORS locked to the app, plus a health check ----
app.use(cors({ origin: ORIGIN }));
app.use(express.json({ limit: '24mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Rate limit the money-costing path (generation). Anonymous is fine; this just stops abuse.
const genLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sites generated from this address. Try again later.' } });

// ---- Lookup (Google Places via the engine extractor is heavy; here we expose a light
//      candidate resolve. For now reuse extract through the pipeline's first stage. ----
app.post('/api/lookup', async (req, res) => {
  try {
    const { name, city } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const { extractBusinessFacts } = await import('../extract/index.js');
    const facts = await extractBusinessFacts(`${name}${city ? `, ${city}` : ''}`);
    res.json({
      name: facts.identity?.name || null,
      address: facts.identity?.address || null,
      rating: facts.socialProof?.rating || null,
      userRatingCount: facts.socialProof?.userRatingCount || null,
      primaryType: facts.atmosphere?.primaryTypeDisplayName || null,
      photo: facts.assets?.photos?.[0]?.url || null,
      facts, // front end keeps this to pass into generate
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Generate: kick off a background job, return jobId for polling ----
// The facts handoff: if the request carries the facts from /api/lookup (either top-level
// or nested under business.facts), the pipeline builds from that CONFIRMED data — no
// re-extraction, no duplicate Places call, no resolving to the wrong business.
function slugify(name, fallback) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/['’]/g, '')                 // apostrophes vanish: Riley's -> rileys
    .replace(/[^a-z0-9]+/g, '-')          // runs of anything else -> single dash
    .replace(/^-+|-+$/g, '')              // trim edge dashes
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || (fallback || 'preview').slice(0, 8);
}

// Minimal-but-complete facts shape for description-only (greenfield) builds, so triage
// and brand analysis run without a Places extraction that would fail or mis-resolve.
function greenfieldFacts(description, name) {
  return {
    query: description,
    fetchedAt: new Date().toISOString(),
    identity: { placeId: null, name: name || null, address: null, location: null, phone: null, website: null },
    operational: { hours: null, priceLevel: null },
    atmosphere: { editorialSummary: description, primaryType: null, primaryTypeDisplayName: null, types: [], attributes: {} },
    socialProof: { rating: null, userRatingCount: 0, reviews: [] },
    assets: { photos: [], logo: null, favicon: null, legacyColors: [] },
    launch: { registrar: null, walkthroughKey: 'generic', transferLocked: null, nameservers: [] },
    attributions: [],
    _sources: { google: false, greenfield: true },
  };
}

app.post('/api/generate', genLimiter, async (req, res) => {
  const { business, description } = req.body || {};
  const facts = req.body?.facts || business?.facts || null; // accept both shapes
  const jobId = createJob();
  res.json({ jobId });

  (async () => {
    try {
      const bizName = facts?.identity?.name || business?.name || null;
      updateJob(jobId, { status: 'running', stage: bizName ? `Reading ${bizName}…` : 'Reading your description…', progress: 0.1 });

      const opts = {};
      if (facts?.identity) {
        opts.facts = facts;                              // confirmed-business handoff
      } else if (description) {
        opts.facts = greenfieldFacts(description, bizName); // description-only build
      } else if (!bizName) {
        throw new Error('Nothing to build from — no business facts and no description.');
      }
      // (If only a name arrived with no facts, the pipeline falls back to extraction.)

      updateJob(jobId, { stage: 'Designing your site…', progress: 0.35 });
      const result = await runPipeline(bizName || description, opts);

      updateJob(jobId, { stage: 'Publishing your live preview…', progress: 0.85 });
      const slug = slugify(bizName || description, result.preview.id);
      const deployed = await deployPreview(result.preview.dir, slug);

      updateJob(jobId, {
        status: 'done', stage: 'Live preview ready', progress: 1,
        result: {
          previewId: result.preview.id,
          slug: deployed.slug,
          previewUrl: deployed.url,               // real https://<slug>.dksites.com/
          version: result.preview.version,
          decisions: result.decisions,
          suggestedAsks: result.facts?.triage?.suggestedAsks || [],
        },
      });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    }
  })();
});

app.get('/api/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json({ status: job.status, stage: job.stage, progress: job.progress, result: job.result, error: job.error });
});

// ---- Editor options (zones A + B) ----
app.get('/api/edit-options/:previewId', async (req, res) => {
  try {
    const build = await loadBuild(req.params.previewId);
    const options = await buildEditOptions(build);
    options.previewId = req.params.previewId;
    res.json(options);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Apply an edit (prompt / palette / font / menu) — regenerates in place ----

// ---- Upload a logo / menu / photo into a preview -------------------------------
// Base64 JSON rather than multipart: no extra dependency to install on the box, and the
// files are small. Everything lands inside the preview's own images/ dir, so nothing is
// re-downloaded later and the generator can reference it by relative path.
const UPLOAD_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'application/pdf': 'pdf',
};
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

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

    const { join } = await import('node:path');
    const { mkdir, writeFile, readdir } = await import('node:fs/promises');
    const previewDir = join(config.previewDir, previewId);

    let assetPath;
    if (kind === 'menu') {
      assetPath = `uploads/menu.${ext}`;
    } else if (kind === 'logo') {
      assetPath = `images/logo-upload.${ext}`;
    } else {
      let n = 1;
      try {
        const existing = await readdir(join(previewDir, 'images'));
        n = existing.filter((f) => f.startsWith('upload-')).length + 1;
      } catch {}
      assetPath = `images/upload-${n}.${ext}`;
    }

    const full = join(previewDir, assetPath);
    await mkdir(join(previewDir, assetPath.split('/')[0]), { recursive: true });
    await writeFile(full, buf);

    res.json({ kind, assetPath, path: full, bytes: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/apply-edit', async (req, res) => {
  try {
    const { previewId, instruction, slug, logoFile, menuFile, photoFiles } = req.body || {};
    if (!previewId) return res.status(400).json({ error: 'previewId required' });
    const { preview, editInstruction } = await applyEdit(previewId, {
      instruction: instruction || null,
      logoFile: logoFile || null,
      menuFilePath: menuFile?.path || null,
      photoFiles: Array.isArray(photoFiles) ? photoFiles : [],
    });
    // Redeploy so the live <slug>.dksites.com preview reflects the edit immediately.
    let liveUrl = preview.url;
    if (slug) {
      const { join } = await import('node:path');
      const deployed = await deployPreview(join(config.previewDir, previewId), slug);
      liveUrl = deployed.url;
    }
    res.json({ version: preview.version, url: liveUrl, applied: editInstruction });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Domain availability + verified quote ----
app.get('/api/check', async (req, res) => {
  try {
    const domain = String(req.query.domain || '').toLowerCase();
    if (!domain) return res.status(400).json({ error: 'domain required' });
    const avail = await checkAvailability(domain);
    if (!avail.available) return res.json({ domain, available: false });
    const info = avail.premium ? { price: avail.premiumPrice, years: 1, estimated: false } : await getRegisterPrice(tldOf(domain));
    const quote = buildQuote(info.price, { domain, years: info.years, verified: !info.estimated });
    res.json({ domain, available: true, estimated: info.estimated, years: info.years, lineItems: quote.lineItems, total: quote.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Create Stripe Checkout (margin guard: refuse estimated prices) ----
app.post('/api/checkout', async (req, res) => {
  try {
    const { domain, slug, previewId } = req.body || {};
    const d = String(domain || '').toLowerCase();
    const avail = await checkAvailability(d);
    if (!avail.available) return res.status(400).json({ error: 'domain not available' });
    const info = avail.premium ? { price: avail.premiumPrice, years: 1, estimated: false } : await getRegisterPrice(tldOf(d));
    if (info.estimated) return res.status(409).json({ error: 'price not verified; refusing checkout' });
    const quote = buildQuote(info.price, { domain: d, years: info.years, verified: true });
    const session = await createCheckout({ quote, slug, previewId });
    res.json({ url: session.url, total: quote.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(config.port, () => {
  console.log(`DK Sites API on :${config.port}  origin=${ORIGIN}  LAUNCH_LIVE=${config.launchLive}`);
});
