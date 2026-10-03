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
export async function createCheckout({ quote, slug, previewId, successUrl, cancelUrl, userId = null, email = null, autoRenew = false, ownDomain = false }) {
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
    // Auto-renew is OPT-IN. Only then do we save the card for next year — and Cash App
    // can't be charged later, so it's offered only on one-time purchases.
    payment_method_types: autoRenew ? ['card', 'link'] : ['card', 'cashapp', 'link'],
    customer_creation: 'always',
    ...(email ? { customer_email: email } : {}),
    ...(autoRenew ? { payment_intent_data: { setup_future_usage: 'off_session' } } : {}),
    line_items,
    success_url: successUrl || 'https://app.dksites.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: cancelUrl || 'https://app.dksites.com/?checkout=cancel',
    // The webhook reads this to know WHAT to provision after payment.
    metadata: {
      domain: quote.domain || '',
      slug: slug || '',
      previewId: previewId || '',
      total: String(quote.total),
      years: String(quote.domainYears || 1),
      domainPrice: String(quote.lineItems.find((l) => l.key === 'domain')?.amount ?? ''),
      userId: userId ? String(userId) : '',
      autoRenew: autoRenew ? 'true' : 'false',
      ownDomain: ownDomain ? 'true' : 'false',
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
