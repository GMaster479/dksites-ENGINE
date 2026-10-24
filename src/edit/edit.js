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
  "examplePrompts": ["<2-3 short concrete changes someone might ask for on THIS site, referencing its real sections/colors/content>"],
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
    palette: {
      current: decisions?.palette || null,
      // An uploaded logo's colors are offered here, never applied without asking.
      alternates: [
        ...(decisions?.logoPalette?.dominant
          ? [{ label: 'Match my logo', dominant: decisions.logoPalette.dominant, accent: decisions.logoPalette.accent }]
          : []),
        ...(ai.paletteAlternates || []),
      ],
    },
    fonts: { current: decisions?.typography || null, alternates: ai.fontAlternates || [] },
    suggestedPrompts,
    examplePrompts: (ai.examplePrompts || [])
      .map((e) => String(e || '').trim())
      .filter((e) => e.length > 8)
      .slice(0, 3),
    // What the owner has ALREADY given us. The editor uses this to retire asks — otherwise
    // it keeps asking for a logo that was uploaded two edits ago.
    provided: {
      logo: !!facts.assets?.logo,
      logoUploaded: !!facts.assets?.logoUploaded,
      menu: !!facts.knownMenu,
      photos: (facts.triage?.rankedPhotos || []).length,
      uploadedPhotos: (facts.triage?.rankedPhotos || []).filter((p) => p.assetPath).length,
    },
    // Everything the owner has asked for so far. Kept through every edit; each can be undone.
    requests: (build.ownerRequests || []).map((r) => ({ id: r.id, text: r.text, at: r.at, summary: r.summary || null })),
    socials: facts.identity?.sameAs || [],
    version: build.version,
  };
}

/**
 * ZONE C (and structured picks from A/B): apply an owner's change.
 *
 * DEFAULT: edit in place (src/edit/inplace.js). The current site is patched for exactly
 * what was asked; nothing else moves, and every earlier request is carried along as a
 * standing request so it can't be undone by accident.
 *
 * REDESIGN: only when the owner explicitly asks (change.redesign, or wording like "start
 * over" / "whole new look"). Then the site is regenerated — still honoring every standing
 * request.
 *
 * @param {string} previewId
 * @param {object} change  { instruction?, menuFilePath(s)?, logoFile?, photoFiles?, setPalette?,
 *                           setFonts?, setSocials?, removeRequestId?, redesign? }
 */
export async function applyEdit(previewId, change = {}) {
  const { editInPlace, wantsRedesign } = await import('./inplace.js');
  const build = await loadBuild(previewId);
  const facts = structuredClone(build.facts);
  const decisions = structuredClone(build.decisions || {});
  const requests = structuredClone(build.ownerRequests || []);
  const {
    instruction = null, menuFilePath = null, menuFilePaths = null, setPalette = null, setFonts = null,
    logoFile = null, photoFiles = [], setSocials = null, removeRequestId = null,
  } = change;
  // Each typed change is its own standing request, so the owner can undo one on its own.
  const instructions = [
    ...(Array.isArray(change.instructions) ? change.instructions : []),
    ...(instruction ? [instruction] : []),
  ].map((t) => String(t || '').trim()).filter((t) => t.length > 2).slice(0, 12);
  const redesign = change.redesign === true || wantsRedesign(instructions.join(' '));

  const parts = [];          // what to do, in plain words, for the model
  const context = {};        // data the model needs to do it truthfully
  const newRequests = [];    // what goes onto the standing list after this edit

  // 0. Undo an earlier request (the owner pressed "remove" on it in the editor).
  if (removeRequestId) {
    const r = requests.find((x) => x.id === removeRequestId);
    if (r) {
      parts.push(`UNDO this earlier change and put that part of the site back the way it was before it: "${r.text}". Change nothing else.`);
      requests.splice(requests.indexOf(r), 1);
    }
  }

  // 1. Menu file -> knownMenu (the only sanctioned menu source).
  let menuSummary = null;
  if (menuFilePaths?.length || menuFilePath) {
    const menu = await extractMenuFromFile(menuFilePaths?.length ? menuFilePaths : menuFilePath);
    facts.knownMenu = menu;
    menuSummary = `${menu._itemCount} items across ${(menu.sections || []).length} sections`;
    parts.push(`Put the owner's real menu (knownMenu, ${menuSummary}) into the menu section, replacing any placeholders. Keep the section's existing design.`);
    context.knownMenu = menu;
  }

  // 1b. Uploaded LOGO -> placed on the site. The colors it suggests are OFFERED in the
  //     editor ("Match my logo") rather than applied — no unrequested restyle.
  let logoSummary = null;
  if (logoFile?.path) {
    facts.assets = { ...facts.assets, logo: logoFile.path, logoAssetPath: logoFile.assetPath, logoUploaded: true };
    try {
      const rebrand = await analyzeBrand(facts);
      if (rebrand?.palette) decisions.logoPalette = rebrand.palette;
    } catch { /* the offer is optional */ }
    logoSummary = 'logo uploaded';
    parts.push(`The owner uploaded their real logo at "${logoFile.assetPath}". Show it in the header and footer in place of any text/placeholder logo, sized to fit the existing header. Don't change the colors.`);
  }

  // 1c. Uploaded PHOTOS -> captioned by the vision pass. APPENDED (not prepended) so the
  //     existing photo-N files keep the meaning the current site already relies on.
  let photoSummary = null;
  if (photoFiles.length) {
    const added = photoFiles.map((f) => ({
      url: null, assetPath: f.assetPath, path: f.path, source: 'upload', score: 6, heroGrade: true,
      widthPx: f.widthPx || null, ...(f.note ? { ownerNote: f.note } : {}),
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
    facts.triage = { ...(facts.triage || {}), rankedPhotos: [...(facts.triage?.rankedPhotos || []), ...added] };
    photoSummary = `${added.length} new photo${added.length > 1 ? 's' : ''}`;
    context.newPhotos = added.map((a) => ({ path: a.assetPath, caption: a.caption || null, kind: a.kind || null, ownerNote: a.ownerNote || null }));
    parts.push(`Use the ${photoSummary} the owner just uploaded (newPhotos) where their captions fit best — swap out a weaker or placeholder image rather than adding new sections, unless the request says otherwise.`);
  }

  // 2. Structured design picks from the palette/font choosers.
  if (setPalette) {
    decisions.palette = { ...decisions.palette, ...setPalette };
    parts.push(`Change the site's colors: dominant ${setPalette.dominant}, accent ${setPalette.accent}. Update the CSS color variables/declarations only; keep contrast at WCAG AA.`);
  }
  if (setFonts) {
    decisions.typography = { ...decisions.typography, ...setFonts };
    parts.push(`Change the fonts: ${setFonts.display} for headings, ${setFonts.body} for body text. Update the Google Fonts <link> and the font-family declarations only.`);
  }

  // 2b. Social profiles -> footer links + JSON-LD sameAs.
  if (Array.isArray(setSocials)) {
    const list = cleanSocials(setSocials);
    facts.identity = { ...facts.identity, sameAs: list };
    parts.push(list.length
      ? `Update the business's social profiles to exactly these: ${list.join(', ')}. Show them as icon links (with aria-labels) where the site already shows social/contact links, or in the footer, and set the JSON-LD "sameAs" array to this list.`
      : `Remove the social profile links and the JSON-LD "sameAs" property.`);
  }

  // 3. The owner's typed requests.
  for (const text of instructions) {
    parts.push(instructions.length > 1 ? `• ${text}` : text);
    newRequests.push({ id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString(), text });
  }

  if (!parts.length) throw new Error('Nothing to change.');
  const standing = requests.map((r) => r.text);
  const editInstruction = parts.join(' ');

  let generated;
  let summary;
  if (redesign) {
    // Full regenerate — only on an explicit ask. Standing requests still apply.
    const full = standing.length
      ? `${editInstruction}\n\nThe owner's earlier requests — these must all still be true in the new design:\n- ${standing.join('\n- ')}`
      : editInstruction;
    generated = await generateSite(facts, decisions, { editInstruction: full });
    summary = 'Your site was redesigned with a fresh look. Everything you asked for earlier was kept.';
  } else {
    const availableImages = imagePaths(facts);
    const r = await editInPlace(build, {
      request: editInstruction,
      standing,
      context: { ...context, availableImages, socialProfiles: facts.identity?.sameAs || [] },
    });
    generated = r.generated;
    summary = r.summary;
  }

  const ownerRequests = [...requests, ...newRequests.map((n) => ({ ...n, summary }))];
  const preview = await writePreview(facts, decisions, generated, {
    id: previewId,
    // In-place edits never re-download: uploads already sit in the preview folder and the
    // existing photo files must not shift. A redesign keeps them too.
    skipAssets: true,
    editInstruction,
    extra: { ownerRequests },
  });

  return { preview, editInstruction, summary, redesign, menuSummary, logoSummary, photoSummary, ownerRequests };
}

/** Every image path the site can use right now (downloaded photos, uploads, logo). */
function imagePaths(facts) {
  const list = (facts.triage?.rankedPhotos || facts.assets?.photos || [])
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => i < 10 || p.assetPath)
    .map(({ p, i }) => ({ path: p.assetPath || `images/photo-${i + 1}.webp`, caption: p.caption || null, activity: p.activity || null }));
  const logo = facts.assets?.logoAssetPath || (facts.assets?.logo ? 'images/logo.png' : null);
  if (logo) list.unshift({ path: logo, caption: 'logo' });
  return list;
}

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|linkedin\.com|yelp\.com|pinterest\.com|threads\.net|nextdoor\.com|tripadvisor\.com|google\.com|g\.page|maps\.app\.goo\.gl|untappd\.com|doordash\.com|ubereats\.com|grubhub\.com)$/i;

/** Normalize owner-entered social links: https, real profile hosts only, deduped. */
export function cleanSocials(list) {
  const out = [];
  for (const raw of list || []) {
    let s = String(raw || '').trim();
    if (!s) continue;
    if (/^@[\w.]{2,}$/.test(s)) continue; // a bare @handle has no platform — the app sends full URLs
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const u = new URL(s);
      if (!SOCIAL_HOSTS.test(u.hostname.replace(/^www\./, '').replace(/^m\./, ''))) continue;
      u.protocol = 'https:';
      u.hostname = u.hostname.replace(/^m\./, 'www.');
      u.hash = '';
      const clean = u.toString().replace(/\/$/, '');
      if (!out.includes(clean)) out.push(clean);
    } catch { /* not a URL */ }
  }
  return out.slice(0, 10);
}
