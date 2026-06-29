import { config } from '../config.js';

const YELP_BASE = 'https://api.yelp.com/v3';

// Yelp is a best-effort supplement for extra gallery photos. The public Fusion API
// returns up to ~3 photos per business and does not reliably expose the older
// categorized "inside/outside/food" arrays anymore — so we take what's available and
// label it generically. If no key is set, this returns empty and the pipeline continues.

async function yelpFetch(path, params = {}) {
  const url = new URL(`${YELP_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.yelpKey}` },
  });
  if (!res.ok) throw new Error(`Yelp ${path} -> ${res.status}`);
  return res.json();
}

/** Match a business by name + location, then pull its detail photos. */
export async function fetchYelp({ name, address, location }) {
  if (!config.yelpKey) return { photos: [], matched: false };
  try {
    const search = await yelpFetch('businesses/search', {
      term: name,
      location: address,
      latitude: location?.latitude,
      longitude: location?.longitude,
      limit: 1,
    });
    const biz = search.businesses?.[0];
    if (!biz) return { photos: [], matched: false };

    const detail = await yelpFetch(`businesses/${biz.id}`);
    const photos = (detail.photos || []).map((u) => ({
      source: 'yelp',
      url: u,
      category: 'gallery',
      attributions: [{ displayName: 'Yelp' }],
    }));
    return { photos, matched: true, yelpId: biz.id, yelpUrl: biz.url };
  } catch (e) {
    return { photos: [], matched: false, error: String(e.message || e) };
  }
}
