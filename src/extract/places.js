import { config } from '../config.js';

const PLACES_BASE = 'https://places.googleapis.com/v1';

// Per the spec: Places API (New) ONLY. No legacy Places API, no GBP Management API.
// Everything here is public data — no OAuth from the business owner.

// Field mask drives exactly what comes back. Anything not listed is excluded.
const DETAILS_FIELD_MASK = [
  // Identity & core
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'internationalPhoneNumber',
  'nationalPhoneNumber',
  'websiteUri',
  // Operational
  'regularOpeningHours',
  'priceLevel',
  // Atmosphere & logic prompters
  'editorialSummary',
  'primaryType',
  'primaryTypeDisplayName',
  'types',
  // Boolean attributes used to switch on layout components
  'outdoorSeating',
  'liveMusic',
  'allowsDogs',
  'menuForChildren',
  'servesBreakfast',
  'servesLunch',
  'servesDinner',
  'servesBeer',
  'servesWine',
  'servesVegetarianFood',
  'takeout',
  'delivery',
  'dineIn',
  'reservable',
  'goodForChildren',
  'goodForGroups',
  'restroom',
  'parkingOptions',
  'paymentOptions',
  'accessibilityOptions',
  // Social proof
  'rating',
  'userRatingCount',
  'reviews',
  // Photos (resource names; upgraded to high-res via the media endpoint below)
  'photos',
].join(',');

async function placesFetch(path, { method = 'GET', body, fieldMask } = {}) {
  const headers = {
    'X-Goog-Api-Key': config.googlePlacesKey,
    'Content-Type': 'application/json',
  };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  const res = await fetch(`${PLACES_BASE}/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Places API ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

/** Resolve a free-text business name (+ optional locality) to a place id. */
export async function searchPlace(query) {
  const data = await placesFetch('places:searchText', {
    method: 'POST',
    body: { textQuery: query, maxResultCount: 1 },
    fieldMask: 'places.id,places.displayName,places.formattedAddress',
  });
  const place = data.places?.[0];
  if (!place) throw new Error(`No Google Place found for "${query}"`);
  return place.id;
}

/** Full details with the strict field mask. */
export async function getPlaceDetails(placeId) {
  return placesFetch(`places/${placeId}`, { fieldMask: DETAILS_FIELD_MASK });
}

/**
 * The photos[] array from a Details call is hard-capped at 10. Upgrade each photo
 * resource name to a raw high-res asset via the Place Photos (New) media endpoint.
 * We return the direct media URLs (signed by key) — download happens later in writer.
 */
export function buildPhotoUrls(photos = [], { maxPx = 4800 } = {}) {
  return photos.slice(0, 10).map((p) => ({
    source: 'google',
    // p.name looks like: places/PLACE_ID/photos/PHOTO_REFERENCE
    url: `${PLACES_BASE}/${p.name}/media?maxWidthPx=${maxPx}&key=${config.googlePlacesKey}`,
    widthPx: p.widthPx,
    heightPx: p.heightPx,
    attributions: p.authorAttributions || [],
  }));
}

/** One call: name -> id -> details -> normalized google block. */
export async function fetchGoogle(query) {
  const placeId = await searchPlace(query);
  const d = await getPlaceDetails(placeId);
  return {
    placeId: d.id,
    name: d.displayName?.text,
    address: d.formattedAddress,
    location: d.location, // {latitude, longitude}
    phone: d.internationalPhoneNumber || d.nationalPhoneNumber || null,
    website: d.websiteUri || null,
    hours: d.regularOpeningHours || null, // includes weekdayDescriptions[] + periods[]
    priceLevel: d.priceLevel || null,
    editorialSummary: d.editorialSummary?.text || null,
    primaryType: d.primaryType || null,
    primaryTypeDisplayName: d.primaryTypeDisplayName?.text || null,
    types: d.types || [],
    attributes: pickBooleans(d),
    rating: d.rating || null,
    userRatingCount: d.userRatingCount || null,
    reviews: (d.reviews || []).map((r) => ({
      author: r.authorAttribution?.displayName || null,
      text: r.text?.text || r.originalText?.text || null,
      rating: r.rating || null,
      date: r.publishTime || null,
      attribution: r.authorAttribution || null,
    })),
    photos: buildPhotoUrls(d.photos),
  };
}

function pickBooleans(d) {
  const keys = [
    'outdoorSeating', 'liveMusic', 'allowsDogs', 'menuForChildren',
    'servesBreakfast', 'servesLunch', 'servesDinner', 'servesBeer', 'servesWine',
    'servesVegetarianFood', 'takeout', 'delivery', 'dineIn', 'reservable',
    'goodForChildren', 'goodForGroups', 'restroom',
  ];
  const out = {};
  for (const k of keys) if (typeof d[k] === 'boolean') out[k] = d[k];
  return out;
}
