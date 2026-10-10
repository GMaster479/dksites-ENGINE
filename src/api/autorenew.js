import { getDb, now } from './db.js';
import { requireUser } from './accounts.js';
import { config } from '../config.js';

// AUTO-RENEW ON/OFF (dashboard switch)
//
// Checkout promises "turn this off anytime", so the owner needs a real switch.
//   OFF: always instant. We simply won't charge next year; reminders still go out.
//   ON:  instant when a reusable card is already saved for them at Stripe (they opted in at
//        checkout, turned it off, and changed their mind). Otherwise Stripe's hosted page
//        saves a card first (Checkout in "setup" mode — no charge today), and the webhook
//        flips the switch when that completes.

const APP_ORIGIN = () => config.appOrigin || 'https://app.dksites.com';
const REUSABLE = new Set(['card', 'link']);

let stripeOverride = null; // tests only
export const __setStripeForTests = (s) => { stripeOverride = s; };
async function stripe() {
  if (stripeOverride) return stripeOverride;
  const { stripeClient } = await import('../launch/stripe.js');
  return stripeClient();
}

/** A payment method saved on the customer that can be charged off-session, or null. */
async function savedMethod(customerId) {
  if (!customerId) return null;
  const s = await stripe();
  const list = await s.customers.listPaymentMethods(customerId, { limit: 10 });
  return list.data.find((pm) => REUSABLE.has(pm.type)) || null;
}

function ownedSite(req, res) {
  const site = getDb().prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site || site.user_id !== req.user.id) {
    res.status(404).json({ error: 'Site not found on this account.' });
    return null;
  }
  return site;
}

function setAutoRenew(siteId, on, paymentMethodId) {
  const db = getDb();
  if (paymentMethodId) {
    db.prepare('UPDATE sites SET auto_renew = ?, auto_renew_changed_at = ?, renew_payment_method = ? WHERE id = ?')
      .run(on ? 1 : 0, now(), paymentMethodId, siteId);
  } else {
    db.prepare('UPDATE sites SET auto_renew = ?, auto_renew_changed_at = ? WHERE id = ?').run(on ? 1 : 0, now(), siteId);
  }
}

/** Webhook: a "save a card for auto-renew" Checkout finished. */
export async function handleSetupSession(session) {
  const m = session.metadata || {};
  if (m.purpose !== 'auto_renew' || !m.siteId) return { ignored: true };
  const site = getDb().prepare('SELECT * FROM sites WHERE id = ?').get(Number(m.siteId));
  if (!site || String(site.user_id) !== String(m.userId)) return { ignored: true };
  let pm = null;
  try {
    const s = await stripe();
    const intentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id;
    if (intentId) {
      const si = await s.setupIntents.retrieve(intentId);
      pm = typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id || null;
    }
  } catch (e) { console.error('✗ reading setup intent:', e.message); }
  setAutoRenew(site.id, true, pm);
  // Remember the Stripe customer if this site didn't have one (e.g. paid with Cash App).
  const customer = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (customer && !site.stripe_customer_id) {
    getDb().prepare('UPDATE sites SET stripe_customer_id = ? WHERE id = ?').run(customer, site.id);
  }
  console.log(`🔁 auto-renew ON for ${site.domain} (card saved)`);
  return { on: true };
}

export function mountAutoRenew(app) {
  app.post('/api/sites/:id/auto-renew', requireUser, async (req, res) => {
    const site = ownedSite(req, res);
    if (!site) return;
    const on = req.body?.on === true;
    try {
      if (!on) {
        setAutoRenew(site.id, false);
        return res.json({ autoRenew: false });
      }
      const pm = await savedMethod(site.stripe_customer_id).catch(() => null);
      if (pm) {
        setAutoRenew(site.id, true, pm.id);
        return res.json({ autoRenew: true, card: pm.card ? `${pm.card.brand} •••• ${pm.card.last4}` : pm.type });
      }
      // No reusable card on file: Stripe saves one (no charge today), the webhook flips it on.
      const s = await stripe();
      const session = await s.checkout.sessions.create({
        mode: 'setup',
        currency: 'usd',
        payment_method_types: ['card', 'link'],
        ...(site.stripe_customer_id ? { customer: site.stripe_customer_id } : { customer_creation: 'always', customer_email: req.user.email }),
        success_url: `${APP_ORIGIN()}/?view=dashboard&autorenew=on`,
        cancel_url: `${APP_ORIGIN()}/?view=dashboard&autorenew=cancel`,
        metadata: { purpose: 'auto_renew', siteId: String(site.id), userId: String(req.user.id), domain: site.domain || '' },
        custom_text: {
          submit: { message: `Nothing is charged today. This card renews ${site.domain} next year; you can turn auto-renew off anytime from your dashboard.` },
        },
      });
      res.json({ needsCard: true, url: session.url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
