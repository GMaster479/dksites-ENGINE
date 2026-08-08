import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, '..', 'rules', 'generation-spec.md');

let cachedSpec = null;
async function loadSpec() {
  if (!cachedSpec) cachedSpec = await readFile(SPEC_PATH, 'utf8');
  return cachedSpec;
}

/** Real Google Maps embed via the Maps Embed API (free, needs "Maps Embed API" enabled). */
function buildMapsEmbedUrl(facts) {
  const id = facts.identity.placeId;
  if (!id || !config.googlePlacesKey) return null;
  return `https://www.google.com/maps/embed/v1/place?key=${config.googlePlacesKey}&q=place_id:${id}`;
}

/**
 * Build the prompt the generator sees. Exposed separately so --dry-run can print it
 * without spending a token.
 */
export async function buildGenerationPrompt(facts, decisions, opts = {}) {
  const { editInstruction = null } = opts;
  const spec = await loadSpec();
  const clientPrefix = slugPrefix(facts.identity.name);

  // Asset manifest = LOCAL relative paths only. The writer downloads sources to these paths.
  // Captions come from the vision pass, so the generator can match each image to the
  // section it actually belongs in instead of distributing them blindly.
  const photos = (facts.triage?.rankedPhotos || facts.assets.photos || [])
    .slice(0, 10)
    .map((p, i) => ({
      path: p.assetPath || `images/photo-${i + 1}.webp`,
      ...(p.assetPath ? { ownerUploaded: true } : {}),
      heroGrade: !!p.heroGrade,
      ...(p.isHero ? { recommendedHero: true } : {}),
      ...(p.caption ? { caption: p.caption } : {}),
      ...(p.activity ? { activity: p.activity } : {}),
      ...(p.tags?.length ? { tags: p.tags } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.issues?.length ? { issues: p.issues } : {}),
    }));
  const assetManifest = {
    logo: facts.assets.logoAssetPath || (facts.assets.logo ? 'images/logo.png' : null),
    favicon: facts.assets.favicon ? 'favicon.ico' : null,
    photos,
  };

  const user = {
    business: facts.identity,
    operational: facts.operational,
    atmosphere: facts.atmosphere,
    socialProof: { rating: facts.socialProof.rating, count: facts.socialProof.userRatingCount, reviews: facts.socialProof.reviews?.slice(0, 4) },
    designDecisions: decisions,
    greenfield: facts.triage?.greenfield ?? false,
    clientPrefix,
    assetManifest,
    mapsEmbedUrl: buildMapsEmbedUrl(facts),
    attributions: facts.attributions,
    // The ONLY sanctioned source of menu items. null => honest placeholder, never invent.
    knownMenu: facts.knownMenu || null,
  };

  const editBlock = editInstruction
    ? `\n\nEDIT INSTRUCTION (client override — apply faithfully, change only what is asked, ` +
      `keep everything else stable):\n"${editInstruction}"\n`
    : '';

  return {
    system: spec,
    userText:
      `Generate the site for this business. Honor every rule in the system prompt — ` +
      `especially the TRUTH POLICY: menu items come ONLY from knownMenu (never from reviews ` +
      `or invention), do not assert inferred facts, reference images ONLY by the local ` +
      `manifest paths, use the provided mapsEmbedUrl verbatim, derive the palette from the ` +
      `logo first, build ONE signature element, and use client-prefixed classes ("${clientPrefix}-").` +
      `\n\nIMAGE PLACEMENT: every photo in assetManifest carries a caption, and most carry an ` +
      `"activity" naming which part of the business it shows. Two failures matter equally: ` +
      `putting a photo where it contradicts the copy, AND leaving a good photo unused.\n` +
      `1. MATCH: a section about a named activity uses ONLY photos whose "activity" matches it. ` +
      `A mini-golf photo in a driving-range section is a defect, not a stylistic choice.\n` +
      `2. COVER: aim to use every usable photo at least once. If you have a good photo of an ` +
      `offering, that offering deserves its own section or card — let the photo set help decide ` +
      `what the site covers, rather than fixing sections first and stranding photos.\n` +
      `3. EXTERIOR/storefront photos belong in the location, hours, "Visit Us" or contact area — ` +
      `pair one with the map rather than leaving it out.\n` +
      `4. If a section has no matching photo, prefer an illustrative SVG, the signature element, ` +
      `or a type-led layout over an unrelated photo. Never fill a slot with a contradicting image.\n` +
      `5. Photos with no "activity" are for generic use (hero, ambience, backgrounds, dividers) ` +
      `— never to illustrate a specific named offering.\n` +
      `6. Reusing one apt photo across two sections beats an unrelated one; prefer ` +
      `"recommendedHero" for the hero; keep photos listed with issues out of large placements; ` +
      `never present "menu"/"screenshot"/"signage" images as ambience or product photography. ` +
      `Write alt text from the caption.` +
      editBlock +
      `\n\nOutput using the delimited ===FILE:...=== format from the spec — NOT JSON.\n\n` +
      `INPUT:\n${JSON.stringify(user, null, 2)}`,
  };
}

export async function generateSite(facts, decisions, opts = {}) {
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const { system, userText } = await buildGenerationPrompt(facts, decisions, opts);

  const msg = await client.messages.create({
    model: config.genModel,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: userText }],
  });

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const result = parseDelimited(text);
  if (!result.files?.length) {
    throw new Error('Generator returned no parseable file blocks. First 400 chars:\n' + text.slice(0, 400));
  }
  return result; // { files:[{path,contents}], signature_element, notes }
}

/**
 * Parse the delimited plain-text output. No JSON, so no escaping landmines.
 * Blocks look like:  ===FILE: path===\n<contents>\n===END===
 */
export function parseDelimited(text) {
  const files = [];
  const fileRe = /===FILE:\s*(.+?)===\r?\n([\s\S]*?)\r?\n===END===/g;
  let m;
  while ((m = fileRe.exec(text)) !== null) {
    files.push({ path: m[1].trim(), contents: m[2] });
  }

  let signature_element = null;
  let notes = null;
  const meta = text.match(/===META===\r?\n([\s\S]*?)\r?\n===END===/);
  if (meta) {
    const body = meta[1];
    const sig = body.match(/signature_element:\s*(.+)/);
    if (sig) signature_element = sig[1].trim();
    const n = body.match(/notes:\s*([\s\S]*)/);
    if (n) notes = n[1].trim();
  }

  return { files, signature_element, notes };
}

function slugPrefix(name) {
  return (
    (name || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 4) || 'site'
  );
}
