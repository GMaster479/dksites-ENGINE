// Own-domain pricing: no domain passthrough, so the quote is hosting + the service fee.
//   (99 + 0) * 1.30 = $128.70 on the current settings.
// Adds the quote to /api/domain/inspect and lets /api/checkout accept ownDomain.
// Idempotent.
import { readFile, writeFile } from 'node:fs/promises';

const F = 'src/api/server.js';
let s = await readFile(F, 'utf8');
const done = [];

if (s.includes('function ownDomainQuote')) {
  console.log('-- own-domain pricing already present');
  process.exit(0);
}

// 1. The quote builder, placed just before the domain endpoints.
const anchor = '// ---- Connect a domain the client ALREADY owns';
if (!s.includes(anchor)) { console.error('x domain endpoints not found — apply patch-sep6 first'); process.exit(1); }

const QUOTE = `// Pricing when the client brings their own domain: nothing to pass through, so the bill
// is the hosting line plus the same service fee. They keep paying their own registrar for
// the domain itself — which the app has to say out loud, because if it lapses the site
// goes down no matter who hosts it.
function ownDomainQuote(domain) {
  const hosting = config.hostingPriceYear;
  const appFee = Math.round(config.appFeeRate * hosting * 100) / 100;
  const total = Math.round((hosting + appFee) * 100) / 100;
  return {
    domain: domain || null,
    ownDomain: true,
    currency: 'usd',
    lineItems: [
      { key: 'hosting', label: 'Hosting, SSL & email (1 yr)', amount: hosting },
      { key: 'appfee', label: \`DK Sites service fee (\${Math.round(config.appFeeRate * 100)}%)\`, amount: appFee },
    ],
    subtotal: hosting,
    appFee,
    total,
    renewalNote:
      'Keep paying your domain renewal at your current registrar. We host and secure the ' +
      'site; you continue to own the domain. If the domain lapses the site goes offline.',
  };
}

`;
s = s.replace(anchor, QUOTE + anchor);
done.push('ownDomainQuote() added');

// 2. inspect returns the quote so the app can price the path up front.
const inspectRe = /(res\.json\(\{\s*\n\s*domain,\s*\n\s*registrar: info\.registrar \|\| null,)/;
if (inspectRe.test(s)) {
  s = s.replace(inspectRe, '$1\n      quote: ownDomainQuote(domain),');
  done.push('/api/domain/inspect returns the own-domain quote');
} else {
  console.error('x could not add the quote to /api/domain/inspect'); process.exit(1);
}

// 3. checkout accepts ownDomain and skips the availability/registration pricing path.
const ckRe = /(app\.post\('\/api\/checkout', async \(req, res\) => \{\s*\n\s*try \{\s*\n)(\s*)(const \{ domain, slug, previewId \} = req\.body \|\| \{\};)/;
if (ckRe.test(s)) {
  s = s.replace(ckRe,
`$1$2const { domain, slug, previewId, ownDomain } = req.body || {};

$2// Bringing their own domain: nothing to register, nothing to look up. The domain being
$2// taken is the whole point, so the availability check must not run here.
$2if (ownDomain) {
$2  const d = String(domain || '').toLowerCase();
$2  if (!d.includes('.')) return res.status(400).json({ error: 'A domain is required.' });
$2  const quote = ownDomainQuote(d);
$2  const session = await createCheckout({ quote, slug, previewId });
$2  return res.json({ url: session.url, total: quote.total, ownDomain: true });
$2}
`);
  done.push('/api/checkout handles ownDomain');
} else {
  console.error('x could not patch /api/checkout for ownDomain'); process.exit(1);
}

await writeFile(F, s);
for (const d of done) console.log('OK  ' + d);
console.log('\nPatched. Restart pm2 for it to take effect.');
