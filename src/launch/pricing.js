import { config } from '../config.js';

// The DK Sites pricing model:
//   (a) domain        — passthrough at Namecheap cost
//   (b) hosting/SSL/email/AI — flat $99/yr
//   app fee           — 30% of (a + b)
//   total             — (a + b) * 1.30   (~$147 on a typical .com)

const round2 = (n) => Math.round(n * 100) / 100;

export function buildQuote(domainPrice, { domain, years = 1, verified = false } = {}) {
  const hosting = config.hostingPriceYear;
  const domainCost = round2(domainPrice);
  const subtotal = round2(domainCost + hosting);
  const appFee = round2(config.appFeeRate * subtotal);
  const total = round2(subtotal + appFee);
  const yrLabel = years > 1 ? `${years} yr` : '1 yr';

  return {
    domain: domain || null,
    domainYears: years,
    verified,
    currency: 'usd',
    lineItems: [
      { key: 'domain', label: `Domain registration${domain ? ` — ${domain}` : ''} (${yrLabel})`, amount: domainCost },
      { key: 'hosting', label: 'Hosting, SSL & email (1 yr)', amount: hosting },
      { key: 'appfee', label: `DK Sites service fee (${Math.round(config.appFeeRate * 100)}%)`, amount: appFee },
    ],
    subtotal,
    appFee,
    total,
  };
}

export function formatQuote(q) {
  const lines = q.lineItems.map((li) => `  ${li.label.padEnd(38)} $${li.amount.toFixed(2)}`);
  return [...lines, `  ${''.padEnd(38)} ─────────`, `  ${'TOTAL (1 year)'.padEnd(38)} $${q.total.toFixed(2)}`].join('\n');
}
