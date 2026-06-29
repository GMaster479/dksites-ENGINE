import Stripe from 'stripe';
import { config } from '../config.js';

// Stripe Checkout in TEST MODE. Creates a hosted payment page from an itemized quote.
// The webhook (Phase 3) listens for checkout.session.completed and triggers provisioning;
// nothing irreversible (domain registration) happens until that signed event arrives.

export function stripeClient() {
  if (!config.stripeSecretKey) throw new Error('STRIPE_SECRET_KEY not set (use a sk_test_... key).');
  return new Stripe(config.stripeSecretKey);
}

/**
 * Build a Checkout Session from a quote. Each quote line becomes a Stripe line item so the
 * customer sees the exact itemization (domain / hosting / service fee).
 */
export async function createCheckout({ quote, slug, previewId, successUrl, cancelUrl }) {
  const stripe = stripeClient();

  const line_items = quote.lineItems.map((li) => ({
    price_data: {
      currency: quote.currency || 'usd',
      product_data: { name: li.label },
      unit_amount: Math.round(li.amount * 100), // cents
    },
    quantity: 1,
  }));

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card', 'cashapp', 'link'],
    line_items,
    success_url: successUrl || 'http://localhost:8787/launch/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl || 'http://localhost:8787/launch/cancel',
    // The webhook reads this to know WHAT to provision after payment.
    metadata: {
      domain: quote.domain || '',
      slug: slug || '',
      previewId: previewId || '',
      total: String(quote.total),
      years: String(quote.domainYears || 1),
      domainPrice: String(quote.lineItems.find((l) => l.key === 'domain')?.amount ?? ''),
    },
  });

  return { id: session.id, url: session.url, total: quote.total };
}

/** Verify + parse a webhook event (Phase 3). Requires the signing secret from `stripe listen`. */
export function constructEvent(rawBody, signature) {
  const stripe = stripeClient();
  if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set (from `stripe listen`).');
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}
