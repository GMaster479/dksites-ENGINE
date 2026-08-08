import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { imageBlockFrom } from './image-block.js';

// Stage 2: turn facts into an explicit, reviewable set of DESIGN DECISIONS before any
// code is written. The logo image is attached as a vision input so the palette is
// derived from the REAL logo colors, not guessed from text.

const BRAND_SYSTEM = `You are the brand-direction stage of the DK Sites pipeline.
Given structured facts about ONE local business — and, when available, its LOGO image —
make deliberate design decisions in the DK Sites house style. You are NOT writing code
yet; you are committing to a direction.

PALETTE PRIORITY ORDER (follow strictly):
1. The LOGO's own colors — if a logo image is attached, the dominant brand color comes
   from it. Read the actual hues in the image and commit to them. Do not drift to a
   different color than what the logo shows.
2. The dominant colors in the business's photos.
3. The legacy site's brand hex codes (provided as legacyColors).
4. Only if none of the above exist, choose a fitting palette from scratch.

Other rules:
- Palette must COMMIT (2 strong colors or up to 5 committed jewel tones) — never a timid
  hedge of near-grays.
- Anti-convergence: tone-to-trade sets the register, the brand sets the key. Pick a
  distinctive key for THIS business; avoid the obvious default for its category.
- Typography: one display face + one workhorse body (Google Fonts), with a one-line reason.
- Signature element: invent ONE custom visual device expressing what this business
  physically does, implementable in CSS/canvas within a performance budget. Mandatory.
- Greenfield (thin data): bias toward typographic + geometric CSS design over photography.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "palette": { "dominant": "#hex", "accent": "#hex", "neutrals": ["#hex"], "source": "logo|photos|legacy|invented", "rationale": "" },
  "typography": { "display": "Font Name", "body": "Font Name", "rationale": "" },
  "tone": "2-4 words",
  "register": "the trade register you started from",
  "signature_element": { "concept": "", "implementation": "CSS or canvas approach" },
  "layout": { "structure": "ordered list of homepage sections", "components_from_attributes": [] },
  "voice": "1 sentence on copy voice",
  "above_the_fold_facts": ["which concrete facts to surface in/near the hero"]
}`;

const ALLOWED_IMG = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Download an image URL into an Anthropic image content block (base64). */

export async function analyzeBrand(facts) {
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const payload = compactFacts(facts);

  const content = [];
  // Attach the logo as the palette anchor when we have one.
  if (facts.assets.logo) {
    const logoBlock = await imageBlockFrom(facts.assets.logo);
    if (logoBlock) {
      content.push({ type: 'text', text: 'LOGO IMAGE (palette anchor — derive the dominant brand color from this):' });
      content.push(logoBlock);
    }
  }
  content.push({
    type: 'text',
    text: `Business facts (JSON):\n${JSON.stringify(payload, null, 2)}\n\nMake the design decisions.`,
  });

  const msg = await client.messages.create({
    model: config.brandModel,
    max_tokens: 1500,
    system: BRAND_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

// Trim the facts to what brand direction actually needs (keeps tokens/cost down).
function compactFacts(f) {
  return {
    name: f.identity.name,
    primaryType: f.atmosphere.primaryType,
    primaryTypeDisplayName: f.atmosphere.primaryTypeDisplayName,
    editorialSummary: f.atmosphere.editorialSummary,
    attributes: f.atmosphere.attributes,
    priceLevel: f.operational.priceLevel,
    rating: f.socialProof.rating,
    reviewSample: (f.socialProof.reviews || []).slice(0, 3).map((r) => r.text),
    legacyColors: (f.assets.legacyColors || []).map((c) => c.hex),
    hasLogoImageAttached: !!f.assets.logo,
    greenfield: f.triage?.greenfield ?? false,
    usablePhotoCount: f.triage?.usableCount ?? 0,
  };
}

export function parseJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Brand stage did not return parseable JSON:\n' + text.slice(0, 500));
  }
}
