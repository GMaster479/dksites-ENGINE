import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { parseJson } from '../analyze/brand.js';
import { generateSite } from '../generate/generate.js';
import { writePreview } from '../generate/writer.js';
import { extractMenuFromFile } from '../extract/menu.js';

// The editor engine. Powers the three zones of the edit screen:
//   A. palette + fonts (current + alternates to pick from)
//   B. suggested prompts (menu upload, confirmations of uncertain facts, feature ideas)
//   C. free-form user edit prompts
// The frontend isn't built yet; these functions are the API it will call.

export async function loadBuild(previewId) {
  const path = join(config.previewDir, previewId, '_build.json');
  if (!existsSync(path)) throw new Error(`No build found for preview id "${previewId}".`);
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * ZONE A + B: produce the editor options the screen renders. Cheap Haiku call, made
 * context-aware so a casual brand gets expressive font alternates (the Riley's lesson),
 * plus deterministic additions (menu upload when needed).
 */
export async function buildEditOptions(build) {
  const { facts, decisions } = build;
  const client = new Anthropic({ apiKey: config.anthropicKey });

  const ctx = {
    name: facts.identity.name,
    primaryType: facts.atmosphere.primaryType,
    register: decisions?.register,
    tone: decisions?.tone,
    currentPalette: decisions?.palette,
    currentFonts: decisions?.typography,
    attributes: facts.atmosphere.attributes,
    hasKnownMenu: !!facts.knownMenu,
  };

  const SYSTEM = `You generate editor options for a website the owner is reviewing.
Be brand-aware: casual/playful businesses should get EXPRESSIVE font alternates (slab,
retro, condensed), not safe serifs. Alternate palettes must stay on-brand but offer a real
choice. Confirmations are uncertain facts the site deliberately did NOT assert and wants
the owner to verify (e.g. founding year). Feature suggestions are useful sections not yet
built (online ordering, reservations, gallery, events, etc.).

Respond with ONLY this JSON, no prose, no fences:
{
  "paletteAlternates": [ { "label": "", "dominant": "#hex", "accent": "#hex" } ],
  "fontAlternates": [ { "label": "", "display": "Google Font", "body": "Google Font" } ],
  "confirmations": [ { "field": "foundingYear", "question": "Are you Est. 2010?", "guess": "2010" } ],
  "featureSuggestions": [ { "label": "Add online ordering button", "prompt": "Add an online ordering CTA linking to our ordering page" } ]
}`;

  let ai = { paletteAlternates: [], fontAlternates: [], confirmations: [], featureSuggestions: [] };
  try {
    const msg = await client.messages.create({
      model: config.triageModel, // cheap — Haiku
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Context:\n${JSON.stringify(ctx, null, 2)}` }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    ai = parseJson(text);
  } catch (e) {
    ai._error = String(e.message || e);
  }

  // Deterministic suggested prompts (always reliable, independent of the model).
  const suggestedPrompts = [];
  if (facts.triage?.needsMenu && !facts.knownMenu) {
    suggestedPrompts.push({
      type: 'menu_upload',
      label: `Upload your menu (PDF or photo) and I'll replace the placeholders with your real items.`,
    });
  }
  for (const c of ai.confirmations || []) suggestedPrompts.push({ type: 'confirm', ...c });
  for (const f of ai.featureSuggestions || []) suggestedPrompts.push({ type: 'feature', ...f });

  return {
    previewId: undefined, // set by caller
    palette: { current: decisions?.palette || null, alternates: ai.paletteAlternates || [] },
    fonts: { current: decisions?.typography || null, alternates: ai.fontAlternates || [] },
    suggestedPrompts,
    version: build.version,
  };
}

/**
 * ZONE C (and structured picks from A/B): apply an edit and regenerate in place.
 * @param {string} previewId
 * @param {object} change  { instruction?, menuFilePath?, setPalette?, setFonts? }
 */
export async function applyEdit(previewId, change = {}) {
  const build = await loadBuild(previewId);
  const facts = structuredClone(build.facts);
  const decisions = structuredClone(build.decisions || {});
  const { instruction = null, menuFilePath = null, setPalette = null, setFonts = null } = change;

  // 1. Menu file -> knownMenu (the only sanctioned menu source).
  let menuSummary = null;
  if (menuFilePath) {
    const menu = await extractMenuFromFile(menuFilePath);
    facts.knownMenu = menu;
    menuSummary = `${menu._itemCount} items across ${(menu.sections || []).length} sections`;
  }

  // 2. Structured design picks from the palette/font choosers.
  if (setPalette) decisions.palette = { ...decisions.palette, ...setPalette };
  if (setFonts) decisions.typography = { ...decisions.typography, ...setFonts };

  // 3. Compose a single edit instruction for the generator (client override).
  const parts = [];
  if (instruction) parts.push(instruction);
  if (setFonts) parts.push(`Use ${setFonts.display} for headings and ${setFonts.body} for body text.`);
  if (setPalette) parts.push(`Use ${setPalette.dominant} as the dominant color and ${setPalette.accent} as the accent.`);
  if (menuSummary) parts.push(`Replace any menu placeholders with the real knownMenu provided (${menuSummary}).`);
  const editInstruction = parts.join(' ') || 'Regenerate with the updated brand decisions.';

  // 4. Regenerate and write in place (keep assets, bump version, log history).
  const generated = await generateSite(facts, decisions, { editInstruction });
  const preview = await writePreview(facts, decisions, generated, {
    id: previewId,
    skipAssets: !menuFilePath, // only re-fetch assets if something asset-like changed
    editInstruction,
  });

  return { preview, editInstruction, menuSummary };
}
