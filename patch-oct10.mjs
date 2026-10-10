// patch-oct10.mjs — wires the Oct 10 fixes into src/api/server.js WITHOUT replacing it.
//
//   1. Stripe webhook: record the purchase FIRST, then launch with live progress
//      (launches.js), and route "save a card for auto-renew" checkouts to autorenew.js
//      instead of treating them as purchases.
//   2. Mounts the new routes: launch status, auto-renew switch, DB backups.
//
// Safe to run twice: it checks for its own markers and says "Nothing to do."
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/api/server.js';
let s = readFileSync(FILE, 'utf8');
const done = [], skip = [];
const fail = (msg) => { console.error(`✗ ${msg}\nNothing was changed. Tell Claude.`); process.exit(1); };

if (!s.includes('mountAccounts(app)')) fail('server.js has no mountAccounts(app) — run patch-accounts.mjs first.');

// ---- 1. webhook -------------------------------------------------------------------
if (s.includes('startLaunchForSession')) {
  skip.push('webhook already launches with progress');
} else {
  const start = s.indexOf("  if (event.type === 'checkout.session.completed') {");
  const end = s.indexOf('\n});\n', start);
  if (start < 0 || end < 0) fail('webhook checkout.session.completed block not found');
  const oldBlock = s.slice(start, end);
  if (!oldBlock.includes('recordPurchase') || !oldBlock.includes('runLaunch(')) fail('webhook block is not in the expected shape');

  const newBlock = `  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // "Save a card for auto-renew" (dashboard switch): not a purchase, nothing to launch.
    if (session.mode === 'setup') {
      import('./autorenew.js')
        .then((a) => a.handleSetupSession(session))
        .catch((e) => console.error('✗ Auto-renew setup:', e.message));
      return;
    }
    const m = session.metadata || {};
    console.log(\`\\n💸 Payment complete: \${m.domain} — $\${(session.amount_total / 100).toFixed(2)}\`);
    // Record FIRST, then launch: the launch writes its progress onto the site row that
    // recordPurchase creates, and the app's Launching screen reads it from there.
    let launchStarted = false;
    import('./accounts.js')
      .then((a) => a.recordPurchase(session))
      .then(async () => {
        if (m.ownDomain === 'true') {
          // They already own this domain: nothing to register. The connect flow in the app
          // deploys the site and walks them through pointing their nameservers.
          console.log(\`   own domain \${m.domain} — no registration; connect flow handles DNS\`);
          return;
        }
        launchStarted = true;
        const { startLaunchForSession } = await import('./launches.js');
        await startLaunchForSession(session);
      })
      .catch((e) => {
        console.error('✗ Purchase/launch:', e.message);
        // If recording failed, still launch what they paid for (old behavior, no progress).
        if (!launchStarted && m.ownDomain !== 'true') {
          runLaunch({ domain: m.domain, slug: m.slug, previewId: m.previewId, price: m.domainPrice, years: parseInt(m.years || '1', 10) })
            .catch((e2) => console.error('✗ Launch error:', e2.message));
        }
      });
  }`;
  s = s.slice(0, start) + newBlock + s.slice(end);
  done.push('webhook: records first, launches with live progress, handles auto-renew card setup');
}

// ---- 2. mount new routes -----------------------------------------------------------
if (s.includes('mountLaunches(app)')) {
  skip.push('new routes already mounted');
} else {
  const anchor = s.match(/^.*mountAccounts\(app\);.*$/m);
  if (!anchor) fail('mountAccounts(app); line not found');
  const add = `
// ---- Oct 10: launch progress, auto-renew switch, nightly DB backups ----
(await import('./launches.js')).mountLaunches(app);
(await import('./autorenew.js')).mountAutoRenew(app);
(await import('./backup.js')).mountBackups(app);`;
  s = s.replace(anchor[0], anchor[0] + add);
  done.push('mounted launch status, auto-renew switch, and backup routes');
}

if (!done.length) {
  console.log('Nothing to do. (' + skip.join('; ') + ')');
} else {
  writeFileSync(FILE, s);
  for (const d of done) console.log('✓', d);
  for (const k of skip) console.log('·', k);
}
