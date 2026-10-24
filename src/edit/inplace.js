import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// EDIT IN PLACE
//
// Owners usually like the first or second version of their site best. Re-generating the
// whole site for every change throws that away: the model re-decides layout, copy and
// details each time, and earlier typed requests silently disappear.
//
// So an edit no longer rebuilds the site. The model gets the CURRENT files and returns
// small find/replace patches for exactly what was asked. Everything else stays
// byte-for-byte the same. Earlier requests travel with every edit as "standing requests"
// so nothing the owner asked for gets undone. A full redesign only happens when the
// owner explicitly asks for one (the editor's "Start over with a fresh design").

const SYSTEM = `You are editing an existing website for a small business. The owner has already approved this site and likes it. Your job is to make the change they asked for and NOTHING else.

RULES — follow all of them:
1. Change only what the request names. Layout, section order, copy, fonts, colors, images, spacing, animations, class names, scripts, meta tags and JSON-LD stay exactly as they are unless the request is about them.
2. Short or vague requests ("make it pop", "more modern", "fix the top") get the SMALLEST tasteful change that satisfies them, confined to the most relevant element or two. Never redesign, restructure, reorder sections or rewrite copy because a request was vague.
3. STANDING REQUESTS are changes the owner asked for earlier. They must still be true after your edit. Never undo one unless the new request explicitly reverses it.
4. TRUTH: never invent facts — no made-up prices, menu items, hours, awards, years, staff names or claims. Menu items come only from knownMenu when it is provided. If something needed is unknown, use an honest placeholder the owner can fill in.
5. New elements must match the site's existing style: reuse its CSS variables, fonts, client-prefixed class names and component patterns.
6. Keep it accessible and mobile-first: alt text on images, AA contrast, keyboard-usable controls, works at 325px wide.
7. Forms on these sites have no server. A new form should use a mailto: action or a clearly-labeled link to call/text/email — never a fake submit that goes nowhere.
8. Images: reference only paths listed in availableImages. Never invent image paths or hotlink outside images.

OUTPUT FORMAT — plain text, no JSON, no markdown fences:
For each file you change:
===EDIT: path/to/file===
<<<FIND
exact text copied from the CURRENT file (just enough lines to be unique)
===REPLACE
the new text
>>>
(repeat <<<FIND ... >>> pairs as needed for this file)
===END===

To add a brand-new file:
===FILE: path/to/file===
full contents
===END===

Finish with:
===SUMMARY===
One or two plain-language sentences for the owner describing what changed. No jargon.
===END===

FIND text must match the current file EXACTLY — same spacing, same quotes — and appear only once in that file. Keep each FIND small (one to eight lines). An empty REPLACE deletes the found text.`;

/** Parse the model's patch output. Pure — unit tested. */
export function parsePatches(text) {
  const edits = [];
  const editRe = /===EDIT:\s*(.+?)===\r?\n([\s\S]*?)\r?\n===END===/g;
  let m;
  while ((m = editRe.exec(text)) !== null) {
    const path = m[1].trim();
    const body = m[2];
    const pairRe = /<<<FIND\r?\n([\s\S]*?)\r?\n===REPLACE\r?\n?([\s\S]*?)\r?\n?>>>(?=\r?\n|$)/g;
    let p;
    while ((p = pairRe.exec(body)) !== null) edits.push({ path, find: p[1], replace: p[2] });
  }
  const files = [];
  const fileRe = /===FILE:\s*(.+?)===\r?\n([\s\S]*?)\r?\n===END===/g;
  while ((m = fileRe.exec(text)) !== null) files.push({ path: m[1].trim(), contents: m[2] });
  const sum = text.match(/===SUMMARY===\r?\n([\s\S]*?)\r?\n===END===/);
  return { edits, files, summary: sum ? sum[1].trim() : null };
}

const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
const rstripLines = (s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');

/**
 * Apply patches to a { path: contents } map. Returns { files, failed }.
 * Exact match first; then a forgiving match that ignores trailing spaces per line.
 * A FIND that matches zero or several places is reported, never guessed at.
 */
export function applyPatches(fileMap, edits) {
  const files = { ...fileMap };
  const failed = [];
  for (const e of edits) {
    const cur = files[e.path];
    if (cur == null) { failed.push({ ...e, reason: `no file named ${e.path}` }); continue; }
    const n = count(cur, e.find);
    if (n === 1) { files[e.path] = cur.replace(e.find, () => e.replace); continue; }
    if (n > 1) { failed.push({ ...e, reason: `matched ${n} places — needs more surrounding lines` }); continue; }
    const loose = rstripLines(cur);
    const lf = rstripLines(e.find);
    if (count(loose, lf) === 1) { files[e.path] = loose.replace(lf, () => e.replace); continue; }
    failed.push({ ...e, reason: 'text not found in the current file' });
  }
  return { files, failed };
}

function editableFiles(generated) {
  // Only text files the model wrote. Images and the editor bridge never go to the model.
  const out = {};
  for (const f of generated?.files || []) {
    if (/\.(html?|css|js|json|txt|xml|webmanifest|svg)$/i.test(f.path)) out[f.path] = f.contents;
  }
  return out;
}

/**
 * @param {object} build      the loaded _build.json
 * @param {object} req        { request, standing[], context{} }
 * @returns {{ generated, summary }}
 */
export async function editInPlace(build, { request, standing = [], context = {} }) {
  const client = new Anthropic({ apiKey: config.anthropicKey });
  const current = editableFiles(build.generated);
  if (!Object.keys(current).length) throw new Error('This build has no saved source files to edit.');

  const input = {
    request,
    standingRequests: standing,
    business: { name: build.facts?.identity?.name, phone: build.facts?.identity?.phone, address: build.facts?.identity?.address },
    ...context,
  };
  const filesText = Object.entries(current)
    .map(([path, contents]) => `===CURRENT: ${path}===\n${contents}\n===END CURRENT===`)
    .join('\n\n');

  const ask = async (messages) => {
    const msg = await client.messages.create({ model: config.genModel, max_tokens: 16000, system: SYSTEM, messages });
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  };

  const first = `THE CHANGE TO MAKE:\n${JSON.stringify(input, null, 2)}\n\nCURRENT FILES:\n\n${filesText}`;
  const reply1 = await ask([{ role: 'user', content: first }]);
  let parsed = parsePatches(reply1);
  let { files, failed } = applyPatches(current, parsed.edits);

  // One repair round for any FIND that didn't land, against the partly-patched files.
  if (failed.length) {
    const fix =
      `Some FIND blocks did not match the current files, so they were NOT applied:\n\n` +
      failed.map((f) => `File ${f.path} (${f.reason}):\n<<<FIND\n${f.find}\n>>>`).join('\n\n') +
      `\n\nHere are the files as they are now (your other edits were applied):\n\n` +
      Object.entries(files).map(([p, c]) => `===CURRENT: ${p}===\n${c}\n===END CURRENT===`).join('\n\n') +
      `\n\nRe-send ONLY the edits that failed, with FIND text copied exactly from these files. Same format, and a SUMMARY.`;
    const reply2 = await ask([
      { role: 'user', content: first },
      { role: 'assistant', content: reply1 },
      { role: 'user', content: fix },
    ]);
    const p2 = parsePatches(reply2);
    const r2 = applyPatches(files, p2.edits);
    files = r2.files;
    failed = r2.failed;
    parsed = { edits: [...parsed.edits, ...p2.edits], files: [...parsed.files, ...p2.files], summary: p2.summary || parsed.summary };
  }
  if (failed.length) {
    // Half an edit is worse than none: keep the site exactly as it was.
    throw new Error('That change couldn’t be applied cleanly, so nothing on your site was changed. Try wording it a little more specifically.');
  }

  for (const f of parsed.files) files[f.path] = f.contents;
  if (!parsed.edits.length && !parsed.files.length) {
    throw new Error('No change was made — try describing what you’d like a little more specifically.');
  }

  // Keep non-text files the build already listed, in their original order.
  const merged = [];
  const seen = new Set();
  for (const f of build.generated.files) {
    merged.push({ path: f.path, contents: files[f.path] ?? f.contents });
    seen.add(f.path);
  }
  for (const [path, contents] of Object.entries(files)) if (!seen.has(path)) merged.push({ path, contents });

  return {
    generated: { ...build.generated, files: merged },
    summary: parsed.summary || 'Your change was applied.',
    patchCount: parsed.edits.length + parsed.files.length,
  };
}

/** True when the owner is explicitly asking for a whole new design. */
export function wantsRedesign(text) {
  return /\b(re-?design|start (over|fresh)|from scratch|brand[- ]new (look|design|site)|completely (new|different)|whole new (look|design|site)|rebuild (the|my) (whole )?(site|website))\b/i
    .test(String(text || ''));
}
