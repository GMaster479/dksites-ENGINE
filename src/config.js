import 'dotenv/config';

function need(name) {
  const v = process.env[name];
  if (!v || v.startsWith('AIza') === false && name === 'GOOGLE_PLACES_KEY' && v.includes('xxxx')) {
    // soft check only; real validation happens at call sites
  }
  return v;
}

export const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || '',
  yelpKey: process.env.YELP_API_KEY || '',

  brandModel: process.env.BRAND_MODEL || 'claude-sonnet-4-6',
  genModel: process.env.GEN_MODEL || 'claude-sonnet-4-6',
  triageModel: process.env.TRIAGE_MODEL || 'claude-haiku-4-5-20251001',

  previewBaseUrl: process.env.PREVIEW_BASE_URL || 'http://localhost:8787',
  previewDir: process.env.PREVIEW_DIR || './previews',
  port: parseInt(process.env.PORT || '8787', 10),

  // ── Cloudflare / R2 (hosting + launch) ──
  cfAccountId: process.env.CF_ACCOUNT_ID || '',
  cfZoneId: process.env.CF_ZONE_ID || '',
  cfApiToken: process.env.CF_API_TOKEN || '', // secret — custom hostnames / DNS
  r2Bucket: process.env.R2_BUCKET || 'dksites-previews',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '', // secret
  r2SecretKey: process.env.R2_SECRET_ACCESS_KEY || '', // secret
  previewHost: process.env.PREVIEW_HOST || 'dksites.com', // previews at <slug>.dksites.com

  // ── Namecheap (domain registration) ──
  ncApiUser: process.env.NAMECHEAP_API_USER || '',
  ncApiKey: process.env.NAMECHEAP_API_KEY || '',
  ncUserName: process.env.NAMECHEAP_USERNAME || process.env.NAMECHEAP_API_USER || '',
  ncClientIp: process.env.NAMECHEAP_CLIENT_IP || '', // must be the whitelisted IP
  ncDefaultDomainPrice: parseFloat(process.env.NAMECHEAP_DEFAULT_PRICE || '13.98'),

  // ── Stripe (payment) ──
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // ── Pricing model ──
  hostingPriceYear: parseFloat(process.env.HOSTING_PRICE_YEAR || '99'),
  appFeeRate: parseFloat(process.env.APP_FEE_RATE || '0.30'),

  // ── Launch safety ──
  launchLive: process.env.LAUNCH_LIVE === 'true', // false => dry-run, no money/provisioning

  // ── API server ──
  appOrigin: process.env.APP_ORIGIN || 'https://app.dksites.com', // CORS allow-list
};

/** Throw early with a clear message if a required key for live mode is missing. */
export function assertLiveKeys({ requirePlaces = true } = {}) {
  const missing = [];
  if (!config.anthropicKey || config.anthropicKey.includes('xxxx')) missing.push('ANTHROPIC_API_KEY');
  if (requirePlaces && (!config.googlePlacesKey || config.googlePlacesKey.includes('xxxx')))
    missing.push('GOOGLE_PLACES_KEY');
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}.\n` +
        `Copy .env.example to .env and fill them in, or run with --dry-run to skip live calls.`
    );
  }
}
