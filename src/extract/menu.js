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

export async function extractMenuFromFile(filePath) {
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const buf = await readFile(filePath);
  const b64 = buf.toString('base64');
  const ext = extname(filePath).toLowerCase();

  let mediaBlock;
  if (ext === '.pdf') {
    mediaBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  } else if (IMG.includes(ext)) {
    const mt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    mediaBlock = { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } };
  } else {
    throw new Error(`Unsupported menu file type: ${ext}. Use PDF, PNG, JPG, or WEBP.`);
  }

  const msg = await client.messages.create({
    model: config.genModel, // Sonnet — accuracy matters for transcription
    max_tokens: 4000,
    system: MENU_SYSTEM,
    messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: 'Extract this menu to JSON.' }] }],
  });

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const menu = parseJson(text);
  const itemCount = (menu.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0);
  return { ...menu, _itemCount: itemCount };
}
