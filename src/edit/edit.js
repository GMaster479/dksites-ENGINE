import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { parseJson } from '../analyze/brand.js';
import { generateSite } from '../generate/generate.js';
import { writePreview } from '../generate/writer.js';
import { extractMenuFromFile } from '../extract/menu.js';
import { analyzeBrand } from '../analyze/brand.js';
import { describePhotos } from '../analyze/vision.js';

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

  // Normalize before anything renders these. The model's confirmation/feature objects
  // don't always carry a `label`, which is where the blank suggestion chips came from.
  // `priority` splits the list: HIGH items are the things only the owner can give us and
  // belong in the prominent asks panel; LOW items are nice-to-haves for the sidebar.
  const normalized = suggestedPrompts
    .map((p) => {
      const label = String(p.label || p.text || p.question || p.prompt || '').trim();
      return { ...p, label, prompt: p.prompt || label };
    })
    .filter((p) => p.label.length > 3)
    .map((p) => ({ ...p, priority: p.type === 'menu_upload' ? 'high' : 'low' }));

  // De-dupe by label so the same ask can't appear twice.
  const seenLabels = new Set();
  const cleanPrompts = normalized.filter((p) => {
    const k = p.label.toLowerCase();
    if (seenLabels.has(k)) return false;
    seenLabels.add(k);
    return true;
  });

  return {
    previewId: undefined, // set by caller
    palette: { current: decisions?.palette || null, alternates: ai.paletteAlternates || [] },
    fonts: { current: decisions?.typography || null, alternates: ai.fontAlternates || [] },
    suggestedPrompts,
    // What the owner has ALREADY given us. The editor uses this to retire asks — otherwise
    // it keeps asking for a logo that was uploaded two edits ago.
    provided: {
      logo: !!facts.assets?.logo,
      logoUploaded: !!facts.assets?.logoUploaded,
      menu: !!facts.knownMenu,
      photos: (facts.triage?.rankedPhotos || []).length,
      uploadedPhotos: (facts.triage?.rankedPhotos || []).filter((p) => p.assetPath).length,
    },
    version: build.version,
  };
}

/**
 * ZONE C (and structured picks from A/B): apply an edit and regenerate in place.
 * @param {string} previewId
 * @param {object} change  { instruction?, menuFilePath?, logoFile?, photoFiles?, setPalette?, setFonts? }
 *   logoFile/photoFiles are { path, assetPath } records written by /api/upload — the file
 *   already sits inside the preview's images/ dir, so nothing is re-downloaded.
 */
export async function applyEdit(previewId, change = {}) {
  const build = await loadBuild(previewId);
  const facts = structuredClone(build.facts);
  const decisions = structuredClone(build.decisions || {});
  const {
    instruction = null, menuFilePath = null, setPalette = null, setFonts = null,
    logoFile = null, photoFiles = [],
  } = change;

  // 1. Menu file -> knownMenu (the only sanctioned menu source).
  let menuSummary = null;
  if (menuFilePath) {
    const menu = await extractMenuFromFile(menuFilePath);
    facts.knownMenu = menu;
    menuSummary = `${menu._itemCount} items across ${(menu.sections || []).length} sections`;
  }

  // 1b. Uploaded LOGO -> becomes the palette anchor, and the brand is re-analyzed so the
  //     colors are actually derived from it (the promise the suggested ask makes).
  let logoSummary = null;
  let rebuiltPalette = null;
  if (logoFile?.path) {
    facts.assets = { ...facts.assets, logo: logoFile.path, logoAssetPath: logoFile.assetPath, logoUploaded: true };
    try {
      const rebrand = await analyzeBrand(facts);
      if (rebrand?.palette) {
        decisions.palette = rebrand.palette;
        decisions.typography = rebrand.typography || decisions.typography;
        rebuiltPalette = rebrand.palette;
      }
    } catch { /* keep existing decisions if the re-analysis fails */ }
    logoSummary = 'logo uploaded';
  }

  // 1c. Uploaded PHOTOS -> captioned by the vision pass, then added to the ranked set so
  //     the generator can place them by what they actually show.
  let photoSummary = null;
  if (photoFiles.length) {
    const added = photoFiles.map((f) => ({
      url: null, assetPath: f.assetPath, path: f.path,
      source: 'upload', score: 6, heroGrade: true, widthPx: f.widthPx || null,
    }));
    try {
      const seen = await describePhotos(added.map((a) => ({ ...a, url: a.path })), {
        name: facts.identity?.name || null,
        type: facts.atmosphere?.primaryTypeDisplayName || null,
        summary: facts.atmosphere?.editorialSummary || null,
      });
      for (const label of seen?.photos || []) {
        const t = added[Number(label.i) - 1];
        if (!t) continue;
        t.caption = label.caption || null;
        t.kind = label.kind || null;
        if (label.activity && (label.confidence ?? 1) >= 0.6) t.activity = label.activity;
      }
    } catch { /* unlabeled uploads still get used */ }
    const ranked = facts.triage?.rankedPhotos || [];
    facts.triage = { ...(facts.triage || {}), rankedPhotos: [...added, ...ranked] };
    photoSummary = `${added.length} new photo${added.length > 1 ? 's' : ''}`;
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
  if (logoSummary)
    parts.push(
      `The owner uploaded their real logo — show it in the header/footer` +
        (rebuiltPalette ? ` and rebuild the palette around it (dominant ${rebuiltPalette.dominant}, accent ${rebuiltPalette.accent}).` : '.')
    );
  if (photoSummary) parts.push(`Use the ${photoSummary} the owner just uploaded, placed by their captions.`);
  const editInstruction = parts.join(' ') || 'Regenerate with the updated brand decisions.';

  // 4. Regenerate and write in place (keep assets, bump version, log history).
  const generated = await generateSite(facts, decisions, { editInstruction });
  const preview = await writePreview(facts, decisions, generated, {
    id: previewId,
    // Uploaded files already live in the preview dir, so no re-fetch is needed for them.
    skipAssets: !menuFilePath && !logoFile && !photoFiles.length,
    editInstruction,
  });

  return { preview, editInstruction, menuSummary, logoSummary, photoSummary, palette: rebuiltPalette };
}
