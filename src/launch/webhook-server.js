import express from 'express';
import { config } from '../config.js';
import { constructEvent } from './stripe.js';
import { runLaunch } from './launch.js';

// Stripe webhook receiver. On a verified checkout.session.completed, it reads the metadata
// we attached at checkout and runs the launch sequence. Signature verification means only
// Stripe can trigger provisioning — nobody can fake a "paid" call to get a free domain.
//
// Local dev: run the Stripe CLI to tunnel test events here:
//   stripe listen --forward-to localhost:8787/webhook
// It prints a signing secret (whsec_...) — set it as STRIPE_WEBHOOK_SECRET, then rebuild.

const app = express();

// Stripe signature checks need the RAW body, so this route must NOT use a JSON parser.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('✗ Webhook signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  // Acknowledge immediately so Stripe doesn't retry; provision in the background.
  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const m = s.metadata || {};
    console.log(`\n💸 Payment complete: ${m.domain || '(no domain)'} — $${(s.amount_total / 100).toFixed(2)}`);
    runLaunch({
      domain: m.domain,
      slug: m.slug,
      previewId: m.previewId,
      price: m.domainPrice,
      years: parseInt(m.years || '1', 10),
    }).catch((e) => console.error('✗ Launch error:', e.message));
  } else {
    console.log(`(ignored event: ${event.type})`);
  }
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(config.port, () => {
  console.log(`Webhook listening on :${config.port}/webhook`);
  console.log(`LAUNCH_LIVE=${config.launchLive}  ${config.launchLive ? '⚠ REAL provisioning' : '(dry-run — safe)'}`);
});
