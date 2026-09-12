import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { config } from '../config.js';
import { parseJson } from '../analyze/brand.js';

// Extracts a real, authoritative menu from an owner-provided file (PDF or image).
// Claude reads PDFs and images natively, so we send the file as a document/image block
// and ask for structured JSON. The result becomes `knownMenu` — the ONLY sanctioned
// source of menu items per the truth policy.

const MENU_SYSTEM = `You extract a restaurant/bar/cafe menu from a document into clean JSON.
Transcribe ONLY what is actually printed. Never invent items, prices, or descriptions.
If a price or description is missing, omit that field. Preserve the menu's own section names.

Respond with ONLY this JSON shape, no prose, no markdown fences:
{
  "sections": [
    { "name": "Section Name", "items": [
      { "name": "Item", "description": "as printed or omitted", "price": "as printed or omitted" }
    ] }
  ],
  "notes": "anything illegible or uncertain"
}`;

const IMG = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

async function mediaBlockFor(filePath) {
  const buf = await readFile(filePath);
  const b64 = buf.toString('base64');
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  if (IMG.includes(ext)) {
    const mt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } };
  }
  throw new Error(`Unsupported menu file type: ${ext}. Use PDF, PNG, JPG, or WEBP.`);
}

const itemsIn = (menu) => (menu?.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0);

async function askForMenu(content, max_tokens = 4000) {
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const msg = await client.messages.create({
    model: config.genModel,
    max_tokens,
    system: MENU_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const menu = parseJson(text);
  return { ...menu, _itemCount: itemsIn(menu) };
}

/**
 * Extract a menu from ONE OR MORE files. Restaurants routinely hand over a two-page menu
 * as two photos — they go in a single request so the model merges them into one coherent
 * menu (de-duplicating a section split across pages) instead of two menus that clobber
 * each other.
 */
export async function extractMenuFromFile(filePaths) {
  const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  if (!paths.length) throw new Error('No menu file provided.');
  const content = [];
  for (const [i, fp] of paths.entries()) {
    if (paths.length > 1) content.push({ type: 'text', text: `Page ${i + 1} of ${paths.length}:` });
    content.push(await mediaBlockFor(fp));
  }
  content.push({
    type: 'text',
    text: paths.length > 1
      ? `These ${paths.length} files are pages of ONE menu. Transcribe them into a single combined JSON menu: keep every distinct item, and if a section continues across pages merge it into one section rather than repeating it.`
      : 'Extract this menu to JSON.',
  });
  return askForMenu(content, paths.length > 1 ? 8000 : 4000);
}

/** Extract a menu from the TEXT of the business's own website. */
export async function extractMenuFromText(pageText, sourceUrl = null) {
  const text = String(pageText || '').trim();
  if (text.length < 80) return null;
  const menu = await askForMenu([{
    type: 'text',
    text: `The following is text scraped from a business's own website${sourceUrl ? ` (${sourceUrl})` : ''}. Extract the food/drink menu from it.

If there is no real menu here — just marketing copy, hours, or a couple of dishes mentioned in a sentence — return {"sections": [], "notes": "no menu found"}. A handful of items named in prose is NOT a menu.

---
${text.slice(0, 60000)}`,
  }]);
  return menu?._itemCount > 0 ? { ...menu, _source: sourceUrl || 'website' } : null;
}
