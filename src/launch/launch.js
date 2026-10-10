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
//
// onProgress(key, state, detail) reports each step as it happens so the app's Launching
// screen shows what is REALLY going on (it used to be a timer). Keys, in order:
//   publish -> register -> dns -> nameservers
// state is 'running' | 'done' | 'skipped' | 'warning' | 'error'.
//
// alreadyRegistered: true on a retry after the domain was bought — never buy it twice.
//
// A nameserver step that can't be CONFIRMED does not throw: the domain is paid for and
// the site is deployed, so the launch finishes with needsAttention=true and a human
// checks it. Throwing there is what turned working launches into "failed" ones.

export const LAUNCH_STEPS = [
  { key: 'payment', label: 'Payment confirmed' },
  { key: 'publish', label: 'Publishing your site' },
  { key: 'register', label: 'Registering your domain' },
  { key: 'dns', label: 'Setting up DNS & SSL' },
  { key: 'nameservers', label: 'Pointing your domain at your site' },
  { key: 'live', label: 'Going live worldwide' },
];

export async function runLaunch({ domain, slug, previewId, price, years = 1, live, onProgress, alreadyRegistered = false } = {}) {
  const isLive = live ?? config.launchLive;
  const steps = [];
  const step = (msg) => { steps.push(msg); console.log('  •', msg); };
  const report = (key, state, detail = null) => {
    try { onProgress?.(key, state, detail); } catch (e) { console.error('  (progress report failed)', e.message); }
  };
  // Wrap a step so a throw is reported against the right key before it propagates.
  const run = async (key, fn) => {
    report(key, 'running');
    try { return await fn(); } catch (e) { report(key, 'error', e.message); throw e; }
  };

  if (!domain || !slug || !previewId) {
    throw new Error(`Launch missing required fields (domain=${domain}, slug=${slug}, previewId=${previewId}).`);
  }

  console.log(`\n🚀 Launch ${domain}  [${isLive ? 'LIVE — real money' : 'DRY-RUN — no charges'}]  slug=${slug}`);
  const result = { domain, slug, previewId, live: isLive, steps, needsAttention: false };

  // 1+2. Deploy the approved site, then map hostname -> slug so the Worker serves it.
  await run('publish', async () => {
    if (isLive) {
      step(`Deploying site to R2 (clients/${slug})…`);
      const d = await deployPreview(join(config.previewDir, previewId), slug);
      step(`Uploaded ${d.uploaded.length} objects.`);
      step(`Mapping ${domain} -> clients/${slug}…`);
      await mapCustomDomain(domain, slug);
      await mapCustomDomain(`www.${domain}`, slug);
      step('Routes written (apex + www).');
    } else {
      step(`[dry-run] would deploy preview ${previewId} -> clients/${slug}/ and map ${domain} + www`);
    }
  });
  report('publish', 'done');

  // 3. Register the domain — IRREVERSIBLE, costs real money. Skipped on a retry.
  if (alreadyRegistered) {
    step(`${domain} was already registered on an earlier attempt — not buying it again.`);
    report('register', 'skipped', 'Already registered');
    result.registered = true;
  } else {
    await run('register', async () => {
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
    });
    report('register', 'done', result.registered ? 'registered' : null);
  }

  // 4. Add the domain to Cloudflare: zone + proxied apex/www + Worker routes.
  //    This is what makes the Worker answer for the domain, and it issues SSL for free.
  await run('dns', async () => {
    if (isLive) {
      step(`Adding ${domain} to Cloudflare…`);
      const cf = await attachDomainToWorker(domain);
      result.zoneId = cf.zone.id;
      result.nameServers = cf.zone.nameServers;
      step(`Zone ${cf.zone.status} · routes for apex + www · assigned NS: ${cf.zone.nameServers.join(', ')}`);
    } else {
      step(`[dry-run] would create a Cloudflare zone for ${domain}, add proxied @ and www, and route both at the Worker`);
    }
  });
  report('dns', 'done');

  // 5. Point the registrar at those nameservers. THE step that makes it resolve.
  if (isLive) {
    report('nameservers', 'running');
    step(`Pointing ${domain} nameservers at Cloudflare…`);
    let ns;
    try {
      ns = await setNameservers(domain, result.nameServers);
    } catch (e) {
      ns = { verified: false, lastError: e.message, current: [] };
    }
    if (ns.verified) {
      step(`Nameservers confirmed (${ns.attempts} attempt${ns.attempts === 1 ? '' : 's'}). DNS propagation is typically 15 minutes to a few hours.`);
      result.nameserversSet = true;
      report('nameservers', 'done');
    } else {
      const why = ns.lastError ? ` Last error: ${ns.lastError}` : '';
      const now = ns.current?.length ? ` Namecheap currently shows: ${ns.current.join(', ')}.` : '';
      step(`⚠ Could not confirm the nameservers for ${domain}.${now}${why}`);
      result.nameserversSet = false;
      result.needsAttention = true;
      result.attentionReason =
        `Nameservers for ${domain} could not be confirmed at Namecheap. Set them by hand to: ` +
        `${(result.nameServers || []).join(', ')}.${now}${why}`;
      report('nameservers', 'warning', 'We’re double-checking this step by hand — no action needed from you.');
    }
  } else {
    step(`[dry-run] would set ${domain} nameservers at Namecheap to the Cloudflare pair`);
    report('nameservers', 'done');
  }

  console.log(
    isLive
      ? (result.needsAttention
        ? `⚠ ${domain} launched but NEEDS ATTENTION: ${result.attentionReason}`
        : `✓ ${domain} launched. It goes live as DNS propagates; SSL is issued automatically once the zone is active.`)
      : '✓ Dry-run complete — nothing was registered, charged, or deployed.'
  );
  return result;
}
