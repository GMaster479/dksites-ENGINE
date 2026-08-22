import { join } from 'node:path';
import { config } from '../config.js';
import { registerDomain, setNameservers } from './namecheap.js';
import { attachDomainToWorker } from './cloudflare.js';
import { deployPreview, mapCustomDomain } from '../deploy/r2.js';

// The launch sequence: paid checkout -> live site.
//
// Order matters. The site is deployed and the route mapped BEFORE DNS is pointed, so that
// the instant the nameservers resolve there is already a real site waiting — no window
// where the domain resolves to an error page.
//
// Every money-spending / irreversible step is gated behind LAUNCH_LIVE (default false).
// In dry-run it logs exactly what it WOULD do and touches nothing.

export async function runLaunch({ domain, slug, previewId, price, years = 1, live } = {}) {
  const isLive = live ?? config.launchLive;
  const steps = [];
  const step = (msg) => { steps.push(msg); console.log('  •', msg); };

  if (!domain || !slug || !previewId) {
    throw new Error(`Launch missing required fields (domain=${domain}, slug=${slug}, previewId=${previewId}).`);
  }

  console.log(`\n🚀 Launch ${domain}  [${isLive ? 'LIVE — real money' : 'DRY-RUN — no charges'}]  slug=${slug}`);
  const result = { domain, slug, previewId, live: isLive, steps };

  // 1. Deploy the approved site first — nothing below is useful without it.
  if (isLive) {
    step(`Deploying site to R2 (clients/${slug})…`);
    const d = await deployPreview(join(config.previewDir, previewId), slug);
    step(`Uploaded ${d.uploaded.length} objects.`);
  } else {
    step(`[dry-run] would deploy preview ${previewId} -> clients/${slug}/`);
  }

  // 2. Map hostname -> slug so the Worker knows what to serve for this domain.
  if (isLive) {
    step(`Mapping ${domain} -> clients/${slug}…`);
    await mapCustomDomain(domain, slug);
    await mapCustomDomain(`www.${domain}`, slug);
    step('Routes written (apex + www).');
  } else {
    step(`[dry-run] would map ${domain} and www.${domain} -> clients/${slug}`);
  }

  // 3. Register the domain — IRREVERSIBLE, costs real money.
  if (isLive) {
    step(`Registering ${domain} for ${years}yr via Namecheap…`);
    const r = await registerDomain(domain, years);
    if (!r.registered) throw new Error(`Namecheap did not confirm registration of ${domain}.`);
    step(`Registered (charged $${r.charged ?? '?'}).`);
    result.registered = true;
    result.charged = r.charged;
  } else {
    step(`[dry-run] would register ${domain} for ${years}yr (~$${price}) via Namecheap`);
  }

  // 4. Add the domain to Cloudflare: zone + proxied apex/www + Worker routes.
  //    This is what makes the Worker answer for the domain, and it issues SSL for free.
  if (isLive) {
    step(`Adding ${domain} to Cloudflare…`);
    const cf = await attachDomainToWorker(domain);
    result.zoneId = cf.zone.id;
    result.nameServers = cf.zone.nameServers;
    step(`Zone ${cf.zone.status} · routes for apex + www · assigned NS: ${cf.zone.nameServers.join(', ')}`);
  } else {
    step(`[dry-run] would create a Cloudflare zone for ${domain}, add proxied @ and www, and route both at the Worker`);
  }

  // 5. Point the registrar at those nameservers. THE step that makes it resolve.
  if (isLive) {
    step(`Pointing ${domain} nameservers at Cloudflare…`);
    const ns = await setNameservers(domain, result.nameServers);
    if (!ns.updated) throw new Error(`Nameservers were not accepted for ${domain}.`);
    step('Nameservers set. DNS propagation is typically 15 minutes to a few hours.');
    result.nameserversSet = true;
  } else {
    step(`[dry-run] would set ${domain} nameservers at Namecheap to the Cloudflare pair`);
  }

  console.log(
    isLive
      ? `✓ ${domain} launched. It goes live as DNS propagates; SSL is issued automatically once the zone is active.`
      : '✓ Dry-run complete — nothing was registered, charged, or deployed.'
  );
  return result;
}
