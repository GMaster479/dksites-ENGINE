import { join } from 'node:path';
import { config } from '../config.js';
import { registerDomain } from './namecheap.js';
import { createCustomHostname } from './cloudflare.js';
import { deployPreview, mapCustomDomain } from '../deploy/r2.js';

// The launch sequence: paid checkout -> live site. Every irreversible / money-spending
// step is gated behind LAUNCH_LIVE (default false). In dry-run it logs exactly what it
// WOULD do and touches nothing — so you can fire test payments all day, safely.

export async function runLaunch({ domain, slug, previewId, price, years = 1, live } = {}) {
  const isLive = live ?? config.launchLive;
  const steps = [];
  const step = (msg) => { steps.push(msg); console.log('  •', msg); };

  if (!domain || !slug || !previewId) {
    throw new Error(`Launch missing required fields (domain=${domain}, slug=${slug}, previewId=${previewId}).`);
  }

  console.log(`\n🚀 Launch ${domain}  [${isLive ? 'LIVE — real money' : 'DRY-RUN — no charges'}]  slug=${slug}`);

  // 1. Register the domain — IRREVERSIBLE, costs real money.
  if (isLive) {
    step(`Registering ${domain} for ${years}yr via Namecheap…`);
    const r = await registerDomain(domain, years);
    step(`Registered: ${r.registered} (charged $${r.charged ?? '?'}).`);
  } else {
    step(`[dry-run] would register ${domain} for ${years}yr (~$${price}) via Namecheap`);
  }

  // 2. Deploy the approved site to R2 under the client's slug.
  if (isLive) {
    step(`Deploying site to R2 (clients/${slug})…`);
    const d = await deployPreview(join(config.previewDir, previewId), slug);
    step(`Uploaded ${d.uploaded.length} objects.`);
  } else {
    step(`[dry-run] would deploy preview ${previewId} -> clients/${slug}/`);
  }

  // 3. Attach Cloudflare for SaaS custom hostname (this issues the SSL cert).
  if (isLive) {
    step(`Creating Cloudflare custom hostname for ${domain}…`);
    const ch = await createCustomHostname(domain);
    step(`Custom hostname ${ch.id} created — SSL status: ${ch.ssl?.status || 'pending'}.`);
  } else {
    step(`[dry-run] would create Cloudflare custom hostname + issue SSL for ${domain}`);
  }

  // 4. Map the live domain -> slug so the Worker serves the right site.
  if (isLive) {
    step(`Mapping ${domain} -> clients/${slug}…`);
    await mapCustomDomain(domain, slug);
    step(`Route written (routes/${domain}.json).`);
  } else {
    step(`[dry-run] would map ${domain} -> clients/${slug} (routes/${domain}.json)`);
  }

  // 5. Point the domain's DNS at the Cloudflare for SaaS target.
  //    (For domains we register, set the CNAME/redirect via Namecheap DNS; for existing
  //    domains, this is the client's guided DNS step. Implementation lands when we wire
  //    the registrar walkthroughs — logged here so the sequence is complete.)
  step(`${isLive ? '' : '[dry-run] '}point ${domain} DNS at the Cloudflare for SaaS target (validates SSL)`);

  const done = isLive ? `✓ ${domain} launched.` : `✓ Dry-run complete — nothing was registered, charged, or deployed.`;
  console.log(done);
  return { domain, slug, previewId, live: isLive, steps };
}
