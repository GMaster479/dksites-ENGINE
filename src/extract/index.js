import { fetchGoogle } from './places.js';
import { fetchYelp } from './yelp.js';
import { scrapeLegacySite } from './scraper.js';
import { detectRegistrar } from './whois.js';

/**
 * Build the unified `business_facts` artifact from all sources concurrently.
 * Google is the spine (required). Yelp, legacy scrape, and WHOIS are best-effort
 * fan-out runners — any one can fail without sinking the build.
 *
 * @param {string} query  e.g. "Cole's Road Brewing, Wallingford CT"
 */
export async function extractBusinessFacts(query) {
  const google = await fetchGoogle(query); // required — let this throw if it fails

  // Fan out the supplementary runners against what Google gave us.
  const [yelp, legacy, registrar] = await Promise.allSettled([
    fetchYelp({ name: google.name, address: google.address, location: google.location }),
    scrapeLegacySite(google.website),
    detectRegistrar(google.website),
  ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : { error: String(x.reason) })));

  // Merge photos from all sources, dedupe by url.
  const allPhotos = [...(google.photos || []), ...((yelp.photos) || []), ...((legacy.assets || []).filter((a) => a.role === 'hero'))];
  const photos = dedupeBy(allPhotos, (p) => p.url);

  // Collect attributions (Google review/photo + Yelp) for invisible footer compliance.
  const attributions = collectAttributions(google, yelp);

  const facts = {
    query,
    fetchedAt: new Date().toISOString(),

    identity: {
      placeId: google.placeId,
      name: google.name,
      address: google.address,
      location: google.location,
      phone: google.phone,
      website: google.website,
    },

    operational: {
      hours: google.hours, // weekdayDescriptions[] + periods[]
      priceLevel: google.priceLevel,
    },

    atmosphere: {
      editorialSummary: google.editorialSummary,
      primaryType: google.primaryType,
      primaryTypeDisplayName: google.primaryTypeDisplayName,
      types: google.types,
      attributes: google.attributes, // booleans -> drive layout components
    },

    socialProof: {
      rating: google.rating,
      userRatingCount: google.userRatingCount,
      reviews: google.reviews,
    },

    assets: {
      photos, // [{source,url,widthPx,heightPx,role?,attributions}]
      logo: (legacy.assets || []).find((a) => a.role === 'logo')?.url || null,
      favicon: (legacy.assets || []).find((a) => a.role === 'favicon')?.url || null,
      legacyColors: legacy.colors || [],
    },

    launch: {
      registrar: registrar.registrar || null,
      walkthroughKey: registrar.walkthroughKey || 'generic',
      transferLocked: registrar.transferLocked ?? null,
      nameservers: registrar.nameservers || [],
    },

    attributions, // piped invisibly into the generated site's footer

    _sources: {
      google: true,
      yelp: yelp.matched || false,
      legacy: legacy.reachable || false,
      registrar: !!registrar.registrar,
    },
  };

  return facts;
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function collectAttributions(google, yelp) {
  const out = [];
  for (const p of google.photos || []) for (const a of p.attributions || []) out.push(a);
  for (const r of google.reviews || []) if (r.attribution) out.push(r.attribution);
  if (yelp.matched) out.push({ displayName: 'Yelp', uri: yelp.yelpUrl });
  // dedupe by displayName
  const seen = new Set();
  return out.filter((a) => {
    const k = a.displayName || a.uri;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
