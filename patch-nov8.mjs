// patch-nov8.mjs — wires the Nov 8 fixes into src/api/server.js WITHOUT replacing it.
//
//   1. Own-domain connect: read the owner's current DNS first and copy their email (and
//      other service) records into the new Cloudflare zone, so switching nameservers
//      doesn't cut off their email. The app is told exactly what was copied.
//   2. Preview addresses (slugs) are unique: a new preview can never land on — and
//      overwrite — a paid live site or someone else's saved preview, and reserved names
//      (www, app, api, dksites-home, …) are never handed out.
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

if (!s.includes('mountBuilds(app)')) fail('server.js is missing the Oct 24 patch — run patch-oct24.mjs first.');

// ---- 1. connect keeps their email ---------------------------------------------------
if (s.includes('snapshotDns')) {
  skip.push('connect already copies email records');
} else {
  swap('connect', `    const cf = await attachDomainToWorker(domain);
    const info = await detectRegistrar(\`https://\${domain}\`);
    res.json({
      domain,
      zoneId: cf.zone.id,
      zoneStatus: cf.zone.status,
      nameservers: cf.zone.nameServers,`,
`    // Nov 8: read their CURRENT DNS and carry email + service records into the new zone,
    // so switching nameservers doesn't cut off their email.
    const { snapshotDns } = await import('../launch/dns-copy.js');
    const snap = await snapshotDns(domain);
    const cf = await attachDomainToWorker(domain, { keep: snap.records });
    console.log(\`🔗 connect \${domain}: kept \${cf.kept.copied.length} records\` +
      (snap.email.hasEmail ? \` (email: \${snap.email.provider})\` : ' (no email found)') +
      (snap.ok ? '' : ' — WARNING: most DNS lookups failed') +
      (cf.kept.failed.length ? \` — \${cf.kept.failed.length} could not be copied\` : ''));
    const info = await detectRegistrar(\`https://\${domain}\`);
    res.json({
      domain,
      zoneId: cf.zone.id,
      zoneStatus: cf.zone.status,
      nameservers: cf.zone.nameServers,
      dns: {
        ok: snap.ok && cf.kept.failed.length === 0,
        email: snap.email,
        copied: cf.kept.copied.length,
        failed: cf.kept.failed.map((f) => \`\${f.record.type} \${f.record.name}\`),
        records: snap.summary.slice(0, 60),
      },`);
  done.push('connect: copies the owner\'s email and service DNS records into the new zone');
}

// ---- 2. unique preview addresses --------------------------------------------------
if (s.includes('uniqueSlug(')) {
  skip.push('slugs already unique');
} else {
  swap('slug', `      const slug = slugify(bizName || description, result.preview.id);`,
`      const slug = await uniqueSlug(slugify(bizName || description, result.preview.id), result.preview.id);`);
  swap('slug helper', `function slugify(name, fallback) {`,
`// Names the Worker or DK Sites uses itself. A business can never be given these.
const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'mail', 'email', 'send', 'smtp', 'dksites',
  'dksites-home', 'home', 'help', 'support', 'status', 'blog', 'docs', 'static', 'assets', 'cdn', 'preview', 'test']);

// Two businesses can share a name (there's more than one "Tony's Pizza"). Without this,
// the second preview would be uploaded into the first one's folder — and if the first is
// a PAID live site, the new preview would replace the customer's live website.
async function uniqueSlug(base, previewId) {
  const { getDb } = await import('./db.js');
  const db = getDb();
  const taken = (slug) =>
    RESERVED_SLUGS.has(slug) ||
    !!db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug) ||
    !!db.prepare('SELECT 1 FROM builds WHERE slug = ? AND preview_id != ?').get(slug, previewId);
  if (!taken(base)) return base;
  const tail = String(previewId).replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const n of [4, 6, 8]) {
    const candidate = \`\${base.slice(0, 40 - n - 1)}-\${tail.slice(0, n)}\`;
    if (!taken(candidate)) return candidate;
  }
  return \`\${base.slice(0, 30)}-\${Date.now().toString(36)}\`;
}

function slugify(name, fallback) {`);
  done.push('preview addresses are unique and never reuse a live site\'s address');
}

if (!done.length) {
  console.log('Nothing to do. (' + skip.join('; ') + ')');
} else {
  writeFileSync(FILE, s);
  for (const d of done) console.log('✓', d);
  for (const k of skip) console.log('·', k);
}
