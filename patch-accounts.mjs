// Wires ACCOUNTS into the box's existing files without replacing them, so every earlier
// fix survives. Safe to run twice — each step detects its own work.
//
//   node patch-accounts.mjs
//
// server.js
//   1. CORS sends cookies (credentials: true) — the session cookie needs it.
//   2. Mounts accounts: session lookup, sign-in routes, ownership guards, checkout gate,
//      dashboard, admin, renewal sweep. Registered before every other route.
//   3. Webhook records each purchase as a site (and its renewal date).
//   4. Webhook NO LONGER runs domain registration for own-domain purchases — that path
//      was trying to register a domain the client already owns.
//   5. Checkout passes the signed-in buyer, auto-renew opt-in, and real return URLs.
// stripe.js
//   6. createCheckout: customer record, prefilled email, auto-renew card saving (opt-in
//      only), metadata the webhook needs, and app.dksites.com return URLs instead of
//      localhost.
// .gitignore
//   7. Ignores db/ — the database must never be committed.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const done = [], skip = [];
const fail = (m) => { console.error('x ' + m + ' — nothing more written. Tell Claude.'); process.exit(1); };

// ------------------------------------------------------------------ server.js
{
  const F = 'src/api/server.js';
  let s = await readFile(F, 'utf8');
  const before = s;

  // 1. CORS credentials
  if (s.includes('credentials: true')) skip.push('CORS already sends credentials');
  else if (s.includes('app.use(cors({ origin: ORIGIN }));')) {
    s = s.replace('app.use(cors({ origin: ORIGIN }));', 'app.use(cors({ origin: ORIGIN, credentials: true })); // session cookie');
    done.push('CORS sends credentials');
  } else fail('server.js: CORS line not found');

  // 2. Mount accounts right after the JSON parser (so guards run before every route)
  if (s.includes('mountAccounts(app)')) skip.push('accounts already mounted');
  else {
    const re = /app\.use\(express\.json\(\{ limit: '[^']+' \}\)\);[^\n]*\n/;
    const m = s.match(re);
    if (!m) fail('server.js: express.json line not found');
    s = s.replace(m[0], m[0] +
`
// ---- Accounts: sessions, sign-in, ownership guards, checkout gate, dashboard, admin ----
const { mountAccounts, checkoutExtras } = await import('./accounts.js');
mountAccounts(app);
`);
    done.push('accounts mounted before all routes');
  }

  // 3 + 4. Webhook: record purchase, and never "register" a domain the client owns
  if (s.includes('recordPurchase(')) skip.push('webhook already records purchases');
  else {
    const re = /(\s*)runLaunch\(\{ domain: m\.domain[\s\S]*?\.catch\(\(e\) => console\.error\('✗ Launch error:', e\.message\)\);/;
    const m = s.match(re);
    if (!m) fail('server.js: webhook runLaunch call not found');
    const ind = m[1].replace(/^\n/, '');
    s = s.replace(re,
`
${ind}import('./accounts.js')
${ind}  .then((a) => a.recordPurchase(event.data.object))
${ind}  .catch((e) => console.error('✗ Recording purchase:', e.message));
${ind}if (m.ownDomain === 'true') {
${ind}  // They already own this domain: nothing to register. The connect flow in the app
${ind}  // deploys the site and walks them through pointing their nameservers.
${ind}  console.log(\`   own domain \${m.domain} — no registration; connect flow handles DNS\`);
${ind}} else {
${ind}  runLaunch({ domain: m.domain, slug: m.slug, previewId: m.previewId, price: m.domainPrice, years: parseInt(m.years || '1', 10) })
${ind}    .catch((e) => console.error('✗ Launch error:', e.message));
${ind}}`);
    done.push('webhook records purchases + skips registration for own domains');
  }

  // 5. Checkout carries the buyer + opt-in
  const calls = (s.match(/createCheckout\(\{ quote, slug, previewId \}\)/g) || []).length;
  if (s.includes('...checkoutExtras(req)')) skip.push('checkout already passes buyer details');
  else if (calls >= 1) {
    s = s.replace(/createCheckout\(\{ quote, slug, previewId \}\)/g, 'createCheckout({ quote, slug, previewId, ...checkoutExtras(req) })');
    done.push(`checkout passes buyer + auto-renew opt-in (${calls} call${calls > 1 ? 's' : ''})`);
  } else fail('server.js: createCheckout calls not found');

  if (s !== before) await writeFile(F, s);
}

// ------------------------------------------------------------------ stripe.js
{
  const F = 'src/launch/stripe.js';
  let s = await readFile(F, 'utf8');
  if (s.includes('customer_creation')) skip.push('stripe.js already updated');
  else {
    const sig = 'export async function createCheckout({ quote, slug, previewId, successUrl, cancelUrl }) {';
    if (!s.includes(sig)) fail('stripe.js: createCheckout signature not found');
    s = s.replace(sig,
      'export async function createCheckout({ quote, slug, previewId, successUrl, cancelUrl, userId = null, email = null, autoRenew = false, ownDomain = false }) {');

    const pm = "    payment_method_types: ['card', 'cashapp', 'link'],";
    if (!s.includes(pm)) fail('stripe.js: payment_method_types line not found');
    s = s.replace(pm,
`    // Auto-renew is OPT-IN. Only then do we save the card for next year — and Cash App
    // can't be charged later, so it's offered only on one-time purchases.
    payment_method_types: autoRenew ? ['card', 'link'] : ['card', 'cashapp', 'link'],
    customer_creation: 'always',
    ...(email ? { customer_email: email } : {}),
    ...(autoRenew ? { payment_intent_data: { setup_future_usage: 'off_session' } } : {}),`);

    s = s.replace("success_url: successUrl || 'http://localhost:8787/launch/success?session_id={CHECKOUT_SESSION_ID}',",
                  "success_url: successUrl || 'https://app.dksites.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}',");
    s = s.replace("cancel_url: cancelUrl || 'http://localhost:8787/launch/cancel',",
                  "cancel_url: cancelUrl || 'https://app.dksites.com/?checkout=cancel',");

    const meta = "      domainPrice: String(quote.lineItems.find((l) => l.key === 'domain')?.amount ?? ''),";
    if (!s.includes(meta)) fail('stripe.js: metadata block not found');
    s = s.replace(meta, meta +
`
      userId: userId ? String(userId) : '',
      autoRenew: autoRenew ? 'true' : 'false',
      ownDomain: ownDomain ? 'true' : 'false',`);
    await writeFile(F, s);
    done.push('stripe.js: customer + email + opt-in card saving + metadata + real return URLs');
  }
}

// ------------------------------------------------------------------ .gitignore
{
  const F = '.gitignore';
  const s = existsSync(F) ? await readFile(F, 'utf8') : '';
  if (/^db\/$/m.test(s)) skip.push('.gitignore already ignores db/');
  else { await writeFile(F, s.replace(/\n?$/, '\n') + 'db/\n'); done.push('.gitignore ignores db/'); }
}

for (const d of done) console.log('OK  ' + d);
for (const k of skip) console.log('--  ' + k);
console.log(done.length ? '\nPatched. Restart pm2 for it to take effect.' : '\nNothing to do.');
