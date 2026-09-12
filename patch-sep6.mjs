// Patches the box's OWN files in place. Never replaces them, so every earlier fix
// survives. Safe to run twice.
//
//   node patch-sep6.mjs
//
// 1. menu.js       — accepts MULTIPLE menu files (two-page menus) + extracts from text
// 2. pipeline.js   — reads an existing website for real content, especially the menu
// 3. namecheap.js  — setNameservers stops reporting failure when it actually succeeded
// 4. edit.js       — applyEdit takes menuFilePaths (array)
// 5. server.js     — multi-menu upload naming + connect-an-existing-domain endpoints
import { readFile, writeFile } from 'node:fs/promises';

const done = [], skip = [], warn = [];
const read = (f) => readFile(f, 'utf8');

// ---------------- 1. menu.js ----------------
{
  const F = 'src/extract/menu.js';
  let s = await read(F);
  if (s.includes('extractMenuFromText')) skip.push('menu.js: already multi-file + text');
  else {
    const start = s.indexOf('export async function extractMenuFromFile');
    if (start === -1) { console.error('x menu.js: extractMenuFromFile not found'); process.exit(1); }
    const head = s.slice(0, start);
    const NEW = `async function mediaBlockFor(filePath) {
  const buf = await readFile(filePath);
  const b64 = buf.toString('base64');
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  if (IMG.includes(ext)) {
    const mt = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } };
  }
  throw new Error(\`Unsupported menu file type: \${ext}. Use PDF, PNG, JPG, or WEBP.\`);
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
    if (paths.length > 1) content.push({ type: 'text', text: \`Page \${i + 1} of \${paths.length}:\` });
    content.push(await mediaBlockFor(fp));
  }
  content.push({
    type: 'text',
    text: paths.length > 1
      ? \`These \${paths.length} files are pages of ONE menu. Transcribe them into a single combined JSON menu: keep every distinct item, and if a section continues across pages merge it into one section rather than repeating it.\`
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
    text: \`The following is text scraped from a business's own website\${sourceUrl ? \` (\${sourceUrl})\` : ''}. Extract the food/drink menu from it.

If there is no real menu here — just marketing copy, hours, or a couple of dishes mentioned in a sentence — return {"sections": [], "notes": "no menu found"}. A handful of items named in prose is NOT a menu.

---
\${text.slice(0, 60000)}\`,
  }]);
  return menu?._itemCount > 0 ? { ...menu, _source: sourceUrl || 'website' } : null;
}
`;
    await writeFile(F, head + NEW);
    done.push('menu.js: multi-file menus + extract-from-text');
  }
}

// ---------------- 2. pipeline.js ----------------
{
  const F = 'src/pipeline.js';
  let s = await read(F);
  if (s.includes('readExistingSite')) skip.push('pipeline.js: already reads existing sites');
  else {
    const m = s.match(/\n(\s*)facts = (await )?triage\(facts[^\n]*\n/);
    if (!m) { console.error('x pipeline.js: triage call not found'); process.exit(1); }
    const BLOCK = `
  // If they already have a site, read it for real CONTENT — above all the menu, which
  // public APIs never carry and which is the most valuable thing on most old sites.
  if (!dryRun && facts.identity?.website && !facts.knownMenu) {
    try {
      const { readExistingSite } = await import('./extract/site-reader.js');
      log(\`Reading their existing site: \${facts.identity.website}\`);
      const site = await readExistingSite(facts.identity.website);
      if (site) {
        facts.existingSite = { pages: site.pages, text: site.text.slice(0, 20000) };
        log(\`  read \${site.pages.length} page(s)\`);
        if (site.knownMenu?._itemCount) {
          facts.knownMenu = site.knownMenu;
          log(\`  pulled a real menu from their site: \${site.knownMenu._itemCount} items\`);
        } else log('  no menu found on their site');
      } else log('  could not read it');
    } catch (e) { log(\`  site read failed: \${e.message}\`); }
  }
`;
    s = s.replace(m[0], BLOCK + m[0]);
    await writeFile(F, s);
    done.push('pipeline.js: reads the existing website for content/menu');
  }
}

// ---------------- 3. namecheap.js ----------------
{
  const F = 'src/launch/namecheap.js';
  let s = await read(F);
  if (!s.includes('setNameservers')) warn.push('namecheap.js: setNameservers absent — skipped (is the go-live update applied?)');
  else if (s.includes('reportedFlag')) skip.push('namecheap.js: setNameservers already tolerant');
  else {
    const re = /return \{ domain, updated: \(r\.attr\('Update'\) \|\| ''\)\.toLowerCase\(\) === 'true', nameservers \};/;
    if (!re.test(s)) warn.push('namecheap.js: setNameservers return not in the expected shape — left alone');
    else {
      s = s.replace(re,
`// Namecheap reports success inconsistently here: sometimes Update="true", sometimes a
  // different attribute, sometimes none at all while having applied the change perfectly.
  // ensureOk() above already threw on a real API error, so reaching this line means it
  // worked. Treating a missing attribute as failure is what aborted a launch mid-sequence
  // on a domain that had already been paid for.
  const flag = (r.attr('Update') || r.attr('Updated') || r.attr('IsSuccess') || '').toLowerCase();
  return { domain, updated: flag ? flag === 'true' : true, nameservers, reportedFlag: flag || null };`);
      await writeFile(F, s);
      done.push('namecheap.js: setNameservers no longer false-alarms');
    }
  }
}

// ---------------- 4. edit.js ----------------
{
  const F = 'src/edit/edit.js';
  let s = await read(F);
  if (s.includes('menuFilePaths')) skip.push('edit.js: already takes multiple menu files');
  else if (!s.includes('menuFilePath')) warn.push('edit.js: menuFilePath not found — skipped');
  else {
    s = s.replace(/menuFilePath = null/g, 'menuFilePath = null, menuFilePaths = null');
    s = s.replace(/extractMenuFromFile\(menuFilePath\)/g,
                  'extractMenuFromFile(menuFilePaths?.length ? menuFilePaths : menuFilePath)');
    s = s.replace(/if \(menuFilePath\)/g, 'if (menuFilePaths?.length || menuFilePath)');
    s = s.replace(/!menuFilePath &&/g, '!(menuFilePaths?.length || menuFilePath) &&');
    await writeFile(F, s);
    done.push('edit.js: accepts menuFilePaths (array)');
  }
}

// ---------------- 5. server.js ----------------
{
  const F = 'src/api/server.js';
  let s = await read(F);

  // 5a. menu uploads must increment instead of overwriting a single filename
  if (s.includes("assetPath = 'uploads/menu.' + ext;")) {
    s = s.replace("assetPath = 'uploads/menu.' + ext;",
`{
      let n = 1;
      try {
        const existing = await readdir(join(previewDir, 'uploads'));
        n = existing.filter((f) => f.startsWith('menu-')).length + 1;
      } catch {}
      assetPath = 'uploads/menu-' + n + '.' + ext;
    }`);
    done.push('server.js: menu uploads increment (menu-1, menu-2, …)');
  } else if (s.includes("uploads/menu-'")) {
    skip.push('server.js: menu uploads already increment');
  } else {
    warn.push('server.js: single-menu path not found — multi-menu naming skipped');
  }

  // 5b. apply-edit forwards menuFiles (plural)
  if (s.includes('menuFilePaths:')) skip.push('server.js: apply-edit already forwards menuFiles');
  else if (s.includes('menuFilePath: menuFile?.path || null,')) {
    s = s.replace('const { previewId, instruction, slug, logoFile, menuFile, photoFiles, setPalette, setFonts } = req.body || {};',
                  'const { previewId, instruction, slug, logoFile, menuFile, menuFiles, photoFiles, setPalette, setFonts } = req.body || {};');
    s = s.replace('menuFilePath: menuFile?.path || null,',
                  'menuFilePath: menuFile?.path || null,\n        menuFilePaths: Array.isArray(menuFiles) ? menuFiles.map((f) => f.path).filter(Boolean) : null,');
    done.push('server.js: apply-edit forwards menuFiles');
  } else warn.push('server.js: apply-edit menuFilePath line not found — plural forwarding skipped');

  // 5c. connect-an-existing-domain endpoints
  if (s.includes("'/api/domain/inspect'")) skip.push('server.js: domain-connect endpoints already present');
  else {
    const anchor = "app.post('/api/checkout'";
    if (!s.includes(anchor)) warn.push('server.js: /api/checkout anchor not found — domain endpoints skipped');
    else {
      const BLOCK = `// ---- Connect a domain the client ALREADY owns -----------------------------------
// Most prospects own a domain and a bad site, so this — not registration — is the path
// that closes deals. We move nameservers rather than editing records: one setting, covers
// apex and www together, and it hands us DNS control so SSL and later changes are ours.

// Who is it registered with, and what will the owner have to do?
app.post('/api/domain/inspect', async (req, res) => {
  try {
    const domain = String(req.body?.domain || '').toLowerCase().replace(/^https?:\\/\\//, '').replace(/^www\\./, '').split('/')[0];
    if (!domain.includes('.')) return res.status(400).json({ error: 'That does not look like a domain name.' });
    const { detectRegistrar } = await import('../extract/whois.js');
    const { getWalkthrough } = await import('../launch/walkthroughs.js');
    const info = await detectRegistrar(\`https://\${domain}\`);
    res.json({
      domain,
      registrar: info.registrar || null,
      walkthroughKey: info.walkthroughKey || 'generic',
      currentNameservers: info.nameservers || [],
      alreadyOnCloudflare: (info.nameservers || []).some((n) => /cloudflare/i.test(n)),
      walkthrough: getWalkthrough(info.walkthroughKey, []),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prepare our side: deploy the site, map the routes, create the zone. Returns the exact
// nameservers the owner must enter. Nothing here touches their domain.
app.post('/api/domain/connect', async (req, res) => {
  try {
    const { previewId, slug } = req.body || {};
    const domain = String(req.body?.domain || '').toLowerCase().replace(/^https?:\\/\\//, '').replace(/^www\\./, '').split('/')[0];
    if (!domain.includes('.') || !previewId || !slug) {
      return res.status(400).json({ error: 'domain, previewId and slug are all required.' });
    }
    const { join } = await import('node:path');
    const { mapCustomDomain } = await import('../deploy/r2.js');
    const { attachDomainToWorker } = await import('../launch/cloudflare.js');
    const { detectRegistrar } = await import('../extract/whois.js');
    const { getWalkthrough } = await import('../launch/walkthroughs.js');

    // Site first, so the moment DNS resolves there is already a real site waiting.
    await deployPreview(join(config.previewDir, previewId), slug);
    await mapCustomDomain(domain, slug);
    await mapCustomDomain(\`www.\${domain}\`, slug);

    const cf = await attachDomainToWorker(domain);
    const info = await detectRegistrar(\`https://\${domain}\`);
    res.json({
      domain,
      zoneId: cf.zone.id,
      zoneStatus: cf.zone.status,
      nameservers: cf.zone.nameServers,
      walkthrough: getWalkthrough(info.walkthroughKey, cf.zone.nameServers),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Has the nameserver change landed yet? Polled by the app while the owner waits.
app.get('/api/domain/status', async (req, res) => {
  try {
    const domain = String(req.query.domain || '').toLowerCase();
    const zoneId = String(req.query.zoneId || '');
    if (!zoneId) return res.status(400).json({ error: 'zoneId required' });
    const { getZone } = await import('../launch/cloudflare.js');
    const zone = await getZone(zoneId);
    let serving = false;
    try {
      const r = await fetch(\`https://\${domain}/\`, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      serving = r.ok;
    } catch {}
    res.json({
      domain,
      zoneStatus: zone.status,           // 'pending' until Cloudflare sees the new NS
      active: zone.status === 'active',
      serving,
      ssl: zone.status === 'active' ? 'issued' : 'pending',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

`;
      s = s.replace(anchor, BLOCK + anchor);
      done.push('server.js: /api/domain/inspect, /connect and /status');
    }
  }
  await writeFile(F, s);
}

for (const d of done) console.log('OK  ' + d);
for (const k of skip) console.log('--  ' + k);
for (const w of warn) console.log('!!  ' + w);
console.log(done.length ? '\nPatched. Restart pm2 for it to take effect.' : '\nNothing to do.');
