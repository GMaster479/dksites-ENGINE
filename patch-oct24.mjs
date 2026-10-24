// patch-oct24.mjs — wires the Oct 24 changes into src/api/server.js WITHOUT replacing it.
//
//   1. /api/generate: builds into the draft folder the owner's starting uploads went to,
//      and passes those uploads + their social profiles to the pipeline.
//   2. /api/apply-edit: passes the new edit options (social links, undo an earlier request,
//      explicit redesign) and returns the plain-language summary of what changed.
//   3. Mounts builds.js (id validation, upload rate limit, delete preview, social lookup).
//
// Safe to run twice: it checks for its own markers and says "Nothing to do."
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/api/server.js';
let s = readFileSync(FILE, 'utf8');
const done = [], skip = [];
const fail = (msg) => { console.error(`✗ ${msg}\nNothing was changed. Tell Claude.`); process.exit(1); };
const swap = (label, oldText, newText) => {
  if (!s.includes(oldText)) fail(`${label}: expected code not found`);
  s = s.replace(oldText, newText);
};

if (!s.includes('mountLaunches(app)')) fail('server.js is missing the Oct 10 patch — run patch-oct10.mjs first.');

// ---- 1. generate -----------------------------------------------------------------
if (s.includes('opts.uploads')) {
  skip.push('generate already takes starting uploads');
} else {
  swap('generate', `      const result = await runPipeline(bizName || description, opts);`,
`      // Oct 24: starting uploads + social profiles. The draft folder is where the app put the
      // owner's logo/photos before the build; build into it so they're already in place.
      const draftId = typeof req.body?.draftId === 'string' ? req.body.draftId : null;
      if (draftId) {
        const { getDb } = await import('./db.js');
        const owner = getDb().prepare('SELECT user_id FROM builds WHERE preview_id = ?').get(draftId);
        if (!owner || (req.user && owner.user_id === req.user.id)) {
          opts.previewId = draftId;
          opts.uploads = (Array.isArray(req.body?.uploads) ? req.body.uploads : [])
            .filter((u) => u && ['logo', 'photo'].includes(u.kind) && /^(images|uploads)\\/[\\w.-]+$/.test(String(u.assetPath || '')))
            .slice(0, 12)
            .map((u) => ({
              kind: u.kind,
              assetPath: u.assetPath,
              path: \`\${config.previewDir}/\${draftId}/\${u.assetPath}\`, // built here, never trusted from the client
              note: typeof u.note === 'string' ? u.note.slice(0, 120) : null,
            }));
        }
      }
      if (Array.isArray(req.body?.socials)) opts.socials = req.body.socials.slice(0, 10).map(String);
      const result = await runPipeline(bizName || description, opts);`);
  done.push('generate: starting uploads, social profiles, draft folder');
}

// ---- 2. apply-edit ---------------------------------------------------------------
if (s.includes('removeRequestId')) {
  skip.push('apply-edit already passes the new options');
} else {
  swap('apply-edit body',
    `  const { previewId, instruction, slug, logoFile, menuFile, menuFiles, photoFiles, setPalette, setFonts } = req.body || {};`,
    `  const { previewId, instruction, instructions, slug, logoFile, menuFile, menuFiles, photoFiles, setPalette, setFonts, setSocials, removeRequestId, redesign } = req.body || {};`);
  swap('apply-edit stage',
    `      updateJob(jobId, { status: 'running', stage: 'Rebuilding your site…', progress: 0.2 });`,
    `      updateJob(jobId, { status: 'running', stage: redesign ? 'Designing a fresh version of your site…' : 'Making your change…', progress: 0.2 });`);
  swap('apply-edit call',
    `      const { preview, editInstruction } = await applyEdit(previewId, {`,
    `      const { preview, editInstruction, summary, ownerRequests, redesign: wasRedesign } = await applyEdit(previewId, {`);
  swap('apply-edit options',
    `        setFonts: setFonts || null,
      });`,
    `        setFonts: setFonts || null,
        instructions: Array.isArray(instructions) ? instructions.slice(0, 12).map(String) : [],
        setSocials: Array.isArray(setSocials) ? setSocials.slice(0, 10).map(String) : null,
        removeRequestId: typeof removeRequestId === 'string' ? removeRequestId : null,
        redesign: redesign === true,
      });`);
  swap('apply-edit result',
    `        result: { version: preview.version, url: liveUrl, applied: editInstruction },`,
    `        result: { version: preview.version, url: liveUrl, applied: editInstruction, summary, ownerRequests, redesign: wasRedesign },`);
  done.push('apply-edit: social links, undo a request, explicit redesign, change summary');
}

// ---- 3. mount builds.js (must come before the routes it guards) -------------------
if (s.includes('mountBuilds(app)')) {
  skip.push('builds routes already mounted');
} else {
  swap('mount', `(await import('./backup.js')).mountBackups(app);`,
`(await import('./backup.js')).mountBackups(app);
// ---- Oct 24: preview id validation, upload limit, delete preview, social lookup ----
(await import('./builds.js')).mountBuilds(app);`);
  done.push('mounted preview validation, upload limit, delete preview, social lookup');
}

if (!done.length) {
  console.log('Nothing to do. (' + skip.join('; ') + ')');
} else {
  writeFileSync(FILE, s);
  for (const d of done) console.log('✓', d);
  for (const k of skip) console.log('·', k);
}
