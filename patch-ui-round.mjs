// Patches the box's OWN files in place — never replaces them — so every fix already
// living there survives. Safe to run twice.
//
//   node patch-ui-round.mjs
//
// 1. /api/apply-edit becomes an async job (jobId + polling), matching /api/generate.
//    A 2-4 minute synchronous request is fragile on mobile: background the tab or drop
//    signal and the browser gives up even though the rebuild finished.
// 2. apply-edit forwards setPalette / setFonts, so a colour or type pick updates the
//    stored decisions — which is why the "in use" panel kept showing stale values.
// 3. buildEditOptions returns examplePrompts: placeholder text written against THIS build.
import { readFile, writeFile } from 'node:fs/promises';

const done = [];
const skip = [];

// ---------- server.js ----------
{
  const FILE = 'src/api/server.js';
  let s = await readFile(FILE, 'utf8');

  if (s.includes("createJob(); // apply-edit")) {
    skip.push('server.js: apply-edit already async');
  } else {
    const start = s.indexOf("app.post('/api/apply-edit'");
    if (start === -1) { console.error('x /api/apply-edit not found in server.js'); process.exit(1); }
    const endMark = '\n});\n';
    const end = s.indexOf(endMark, start);
    if (end === -1) { console.error('x could not find the end of the apply-edit route'); process.exit(1); }

    const replacement = `app.post('/api/apply-edit', async (req, res) => {
  const { previewId, instruction, slug, logoFile, menuFile, photoFiles, setPalette, setFonts } = req.body || {};
  if (!previewId) return res.status(400).json({ error: 'previewId required' });

  const jobId = createJob(); // apply-edit runs as a background job; poll /api/status/:jobId
  res.json({ jobId });

  (async () => {
    try {
      updateJob(jobId, { status: 'running', stage: 'Rebuilding your site…', progress: 0.2 });
      const { preview, editInstruction } = await applyEdit(previewId, {
        instruction: instruction || null,
        logoFile: logoFile || null,
        menuFilePath: menuFile?.path || null,
        photoFiles: Array.isArray(photoFiles) ? photoFiles : [],
        setPalette: setPalette || null,
        setFonts: setFonts || null,
      });

      let liveUrl = preview.url;
      if (slug) {
        updateJob(jobId, { stage: 'Publishing your updated preview…', progress: 0.85 });
        const { join } = await import('node:path');
        const deployed = await deployPreview(join(config.previewDir, previewId), slug);
        liveUrl = deployed.url;
      }

      updateJob(jobId, {
        status: 'done', stage: 'Your changes are live', progress: 1,
        result: { version: preview.version, url: liveUrl, applied: editInstruction },
      });
    } catch (e) {
      updateJob(jobId, { status: 'error', error: e.message });
    }
  })();
});
`;
    s = s.slice(0, start) + replacement + s.slice(end + endMark.length);
    await writeFile(FILE, s);
    done.push('server.js: apply-edit is now an async job + forwards setPalette/setFonts');
  }
}

// ---------- edit.js ----------
{
  const FILE = 'src/edit/edit.js';
  let s = await readFile(FILE, 'utf8');
  let changed = false;

  if (s.includes('"examplePrompts"')) {
    skip.push('edit.js: examplePrompts already requested');
  } else if (s.includes('"confirmations":')) {
    s = s.replace('"confirmations":',
      `"examplePrompts": ["<2-3 short concrete changes someone might ask for on THIS site, referencing its real sections/colors/content>"],\n  "confirmations":`);
    changed = true;
    done.push('edit.js: asks the model for build-specific example prompts');
  } else {
    console.error('x could not find the confirmations key in edit.js'); process.exit(1);
  }

  if (s.includes('examplePrompts:')) {
    skip.push('edit.js: examplePrompts already returned');
  } else {
    const anchor = s.includes('suggestedPrompts: cleanPrompts,') ? 'suggestedPrompts: cleanPrompts,' : 'suggestedPrompts,';
    s = s.replace(anchor, `${anchor}
    examplePrompts: (ai.examplePrompts || [])
      .map((e) => String(e || '').trim())
      .filter((e) => e.length > 8)
      .slice(0, 3),`);
    changed = true;
    done.push('edit.js: returns examplePrompts for the placeholder');
  }

  if (changed) await writeFile(FILE, s);
}

for (const d of done) console.log('OK  ' + d);
for (const k of skip) console.log('--  ' + k);
console.log(done.length ? '\nPatched. Restart with pm2 for it to take effect.' : '\nNothing to do.');
