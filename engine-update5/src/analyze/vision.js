import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// VISION PASS — runs inside triage, before generation.
//
// The generator used to receive photos as anonymous slots (photo-1.webp … photo-10.webp)
// with no idea what was in them, so it distributed them plausibly-but-blindly: mini-golf
// cards showing the parking lot, etc. This pass looks at every photo and DESCRIBES it, so
// the generator can place images knowingly.
//
// Design (decided with Dylan): DESCRIBE, don't assign. The model captions and tags each
// photo and the generator decides placement using its own design judgment. Two exceptions
// where this pass DECIDES, because they have downstream consequences:
//   - heroIndex: which photo anchors the hero (layout + crop depend on it)
//   - logoIndex: a photo that is actually a logo/wordmark, which feeds palette derivation
//
// Failure is always soft: any error returns null and triage proceeds exactly as before.

const MAX_PHOTOS = 10;      // matches the writer/generator manifest cap
const THUMB_WIDTH = 800;    // captioning doesn't need 4800px; keeps the call cheap
const ALLOWED_IMG = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function buildSystem(ctx) {
  const bits = [];
  if (ctx.name) bits.push(`Business: ${ctx.name}`);
  if (ctx.type) bits.push(`Type: ${ctx.type}`);
  if (ctx.summary) bits.push(`Description: ${ctx.summary}`);
  if (ctx.offerings?.length) bits.push(`Categories: ${ctx.offerings.join(', ')}`);
  if (ctx.reviewGist) bits.push(`What customers talk about: ${ctx.reviewGist}`);

  return `You are labeling photographs of ONE local business so a website generator can
place them correctly. You are the reason its images will match its copy.

${bits.length ? `ABOUT THIS BUSINESS (use it to tell similar-looking areas apart):\n${bits.join('\n')}\n` : ''}
Many businesses have several areas that look alike at a glance - a putting green vs a mini
golf hole, a driving range vs an open field, a bar vs a counter. Use the business context
above to decide WHICH specific offering each photo shows, and look for distinguishing
detail (obstacles and themed props mean mini golf; distance markers, mats, dividers and
netting mean a driving range; enclosed screens and projectors mean a simulator). When two
readings are genuinely possible, set "activity" to null and say so in the caption rather
than guessing - a wrong label is worse than an absent one.

For EACH image, report only what is genuinely visible. Never guess at things you cannot see
(don't invent a business name, don't assume a season, don't claim a room's purpose unless the
image shows it).

Return STRICT JSON only - no prose, no markdown fences:
{
  "photos": [
    {
      "i": <the image's number as labeled>,
      "caption": "<one concrete sentence describing what is actually shown>",
      "activity": "<the specific offering/area of THIS business the photo shows, in the business's own vocabulary (e.g. \"mini golf\", \"driving range\", \"simulator bay\", \"patio\"), or null if you cannot tell with confidence>",
      "confidence": <0.0-1.0, how sure you are of the activity>,
      "tags": ["<3-6 short lowercase tags>"],
      "kind": "scene|product|food|interior|exterior|people|signage|logo|menu|screenshot|unclear",
      "heroGrade": <true if it's a wide, well-lit, uncluttered establishing shot that would work as a full-width banner>,
      "isLogo": <true ONLY if the image is a logo/wordmark graphic rather than a photograph>,
      "issues": ["<any of: blurry, dark, cluttered, low-resolution, text-heavy, watermark - omit if none>"]
    }
  ],
  "heroIndex": <the "i" of the single best hero image, or null>,
  "logoIndex": <the "i" of the image that is the business's logo, or null>,
  "summary": "<one sentence on what this set of photos collectively shows>"
}`;
}

/** Google Places media URLs carry the width as a query param — ask for a small one. */
function thumbUrl(url) {
  return typeof url === 'string' ? url.replace(/maxWidthPx=\d+/, `maxWidthPx=${THUMB_WIDTH}`) : url;
}

/** Download one image into an Anthropic base64 image block, or null if unusable. */
async function fetchImageBlock(url) {
  try {
    const res = await fetch(thumbUrl(url), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const media_type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!ALLOWED_IMG.includes(media_type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/); // tolerate stray prose around the object
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

/**
 * Describe a ranked photo list.
 * @param {Array<{url:string}>} photos  ranked photos (same order the manifest uses)
 * @param {object} context  { name, type, summary, offerings[] } - lets the model tell
 *                          similar-looking areas apart (mini golf vs driving range)
 * @returns {Promise<null | {photos: Array, heroIndex: number|null, logoIndex: number|null, summary: string}>}
 *          Indices are 1-based and align with images/photo-N.webp.
 */
export async function describePhotos(photos = [], context = {}) {
  if (!config.anthropicKey) return null;
  const list = photos.slice(0, MAX_PHOTOS);
  if (!list.length) return null;

  // Fetch in parallel, but remember each image's ORIGINAL 1-based manifest position so a
  // failed download doesn't shift every caption onto the wrong file.
  const blocks = await Promise.all(
    list.map(async (p, idx) => ({ i: idx + 1, block: await fetchImageBlock(p.url) }))
  );
  const usable = blocks.filter((b) => b.block);
  if (!usable.length) return null;

  const content = [];
  for (const { i, block } of usable) {
    content.push({ type: 'text', text: `Image ${i}:` });
    content.push(block);
  }
  content.push({
    type: 'text',
    text:
      `Label all ${usable.length} images above using the exact image numbers shown. ` +
      `Return the JSON object described in the system prompt and nothing else.`,
  });

  try {
    const client = new Anthropic({ apiKey: config.anthropicKey });
    const msg = await client.messages.create({
      model: config.triageModel,
      max_tokens: 2500,
      system: buildSystem(context),
      messages: [{ role: 'user', content }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJson(text);
    if (!parsed?.photos?.length) return null;

    // Keep only labels whose index maps to a real manifest slot.
    const valid = new Set(usable.map((u) => u.i));
    parsed.photos = parsed.photos.filter((p) => valid.has(Number(p.i)));
    const inRange = (n) => (valid.has(Number(n)) ? Number(n) : null);
    parsed.heroIndex = inRange(parsed.heroIndex);
    parsed.logoIndex = inRange(parsed.logoIndex);
    return parsed;
  } catch {
    return null; // soft failure — generation continues with unlabeled photos
  }
}
