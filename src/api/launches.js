import { getDb, now } from './db.js';
import { runLaunch, LAUNCH_STEPS } from '../launch/launch.js';
import { sendEmail, layout, button, esc } from './mailer.js';
import { requireUser, requireAdmin, isAdmin, adminEmails, recordPurchase } from './accounts.js';
import { config } from '../config.js';

// LAUNCH PROGRESS
//
// The Stripe webhook starts the launch; the app's Launching screen polls
// GET /api/launch/status?session_id=… and shows each step as it really happens.
// Progress lives on the site row (survives a restart and a closed tab), so the
// dashboard and admin page can show it too.
//
// A failed or needs-attention launch emails the admins. Admins can retry from the admin
// page; a retry never buys the domain twice (registered_at is checked first).

const APP_ORIGIN = () => config.appOrigin || 'https://app.dksites.com';

const freshSteps = (domain) =>
  LAUNCH_STEPS.map((s) => ({
    key: s.key,
    label: s.key === 'register' && domain ? `Registering ${domain}` : s.label,
    state: s.key === 'payment' ? 'done' : 'pending',
    detail: null,
  }));

function readSteps(site) {
  try { return JSON.parse(site.launch_steps) || freshSteps(site.domain); } catch { return freshSteps(site.domain); }
}

function saveProgress(siteId, steps, patch = {}) {
  const db = getDb();
  const sets = ['launch_steps = ?', 'launch_updated_at = ?'];
  const vals = [JSON.stringify(steps), now()];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
  db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...vals, siteId);
}

async function notifyAdmins(subject, lines) {
  const to = adminEmails();
  if (!to.length) { console.log(`(no ADMIN_EMAILS set) ${subject}\n${lines.join('\n')}`); return; }
  const html = layout({
    heading: subject,
    bodyHtml:
      lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join('') +
      `<p style="margin:20px 0 0">${button(`${APP_ORIGIN()}/?view=admin`, 'Open admin')}</p>`,
  });
  for (const addr of to) {
    try { await sendEmail({ to: addr, subject, html, text: lines.join('\n') }); }
    catch (e) { console.error('✗ admin notice:', e.message); }
  }
}

async function notifyCustomerLaunched(site) {
  const user = site.user_id ? getDb().prepare('SELECT email FROM users WHERE id = ?').get(site.user_id) : null;
  if (!user?.email) return;
  const url = `https://${site.domain}`;
  try {
    await sendEmail({
      to: user.email,
      subject: `${site.domain} is on its way`,
      text:
        `Your site is set up and ${site.domain} is pointed at it.\n` +
        `It usually appears within 15 minutes to a few hours while the internet catches up.\n\n${url}\n\n` +
        `Edit it anytime from your dashboard: ${APP_ORIGIN()}/?view=dashboard`,
      html: layout({
        heading: `${esc(site.domain)} is on its way`,
        bodyHtml:
          `<p style="margin:0 0 16px">Your site is set up and your domain is pointed at it. It usually appears within ` +
          `<strong>15 minutes to a few hours</strong> while the internet catches up — the secure padlock comes on by itself.</p>` +
          `<p style="margin:0 0 20px">${button(url, `Open ${esc(site.domain)}`)}</p>` +
          `<p style="margin:0;font-size:13px;color:#71717a">Want to change something? Edit it anytime from ` +
          `<a href="${APP_ORIGIN()}/?view=dashboard">your dashboard</a>.</p>`,
      }),
    });
  } catch (e) { console.error('✗ launch email:', e.message); }
}

/**
 * Run (or re-run) the launch for a site row, writing progress as it goes.
 * Called by the Stripe webhook after recordPurchase, and by the admin retry button.
 */
export async function launchSite(siteId, { years = 1, price = null } = {}) {
  const db = getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error(`No site ${siteId}.`);
  if (site.own_domain) throw new Error('Own-domain sites are connected by the owner, not launched.');

  const steps = freshSteps(site.domain);
  const alreadyRegistered = !!site.registered_at;
  saveProgress(siteId, steps, { launch_status: 'running', launch_error: null });

  const onProgress = (key, state, detail) => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.state = state;
    s.detail = detail || null;
    const patch = {};
    // Record the purchase of the domain the moment it happens — a retry must skip it.
    if (key === 'register' && state === 'done' && detail === 'registered') patch.registered_at = now();
    saveProgress(siteId, steps, patch);
  };

  try {
    const r = await runLaunch({
      domain: site.domain, slug: site.slug, previewId: site.preview_id,
      price, years, onProgress, alreadyRegistered,
    });
    const status = r.needsAttention ? 'needs_attention' : 'done';
    // 'live' stays pending — the app checks real DNS/SSL for that one.
    saveProgress(siteId, steps, {
      launch_status: status,
      launch_error: r.needsAttention ? r.attentionReason : null,
      zone_id: r.zoneId || site.zone_id || null,
      nameservers: r.nameServers ? JSON.stringify(r.nameServers) : site.nameservers,
    });
    const fresh = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (r.needsAttention) {
      await notifyAdmins(`Launch needs attention: ${site.domain}`, [
        r.attentionReason,
        'The site is deployed and the domain is registered. The customer was told it is being double-checked.',
      ]);
    }
    if (r.live) await notifyCustomerLaunched(fresh);
    return { status, result: r };
  } catch (e) {
    saveProgress(siteId, steps, { launch_status: 'error', launch_error: e.message });
    await notifyAdmins(`Launch FAILED: ${site.domain}`, [
      `Error: ${e.message}`,
      `Steps: ${steps.map((s) => `${s.label} = ${s.state}`).join(' · ')}`,
      site.registered_at || steps.find((s) => s.key === 'register')?.state === 'done'
        ? 'The domain WAS registered. Retry from the admin page — it will not buy it again.'
        : 'The domain was NOT registered yet. Retry from the admin page once the cause is fixed.',
    ]);
    return { status: 'error', error: e.message };
  }
}

/** Webhook entry point: find the site row this checkout created, then launch it. */
export async function startLaunchForSession(session) {
  const site = getDb().prepare('SELECT * FROM sites WHERE stripe_session_id = ?').get(session.id);
  if (!site) throw new Error(`No site recorded for checkout ${session.id}.`);
  if (site.launch_status && site.launch_status !== 'starting') {
    console.log(`   launch for ${site.domain} already ${site.launch_status} — webhook retry ignored`);
    return;
  }
  const m = session.metadata || {};
  return launchSite(site.id, { years: parseInt(m.years || '1', 10), price: m.domainPrice || null });
}

function publicLaunch(site) {
  return {
    siteId: site.id,
    domain: site.domain,
    ownDomain: !!site.own_domain,
    status: site.own_domain ? 'own_domain' : site.launch_status || 'starting',
    steps: readSteps(site),
    zoneId: site.zone_id || null,
    nameservers: (() => { try { return JSON.parse(site.nameservers) || []; } catch { return []; } })(),
    // Customers never see raw errors; admins get them on the admin page and by email.
    updatedAt: site.launch_updated_at || site.paid_at,
  };
}

// ---- Don't depend on the webhook alone ------------------------------------------
// If Stripe's webhook is late, misconfigured, or never arrives, a paid customer would sit
// on "Confirming payment" forever and never appear on their dashboard. So when the app
// asks about a checkout we haven't recorded, we ask Stripe directly. Recording is
// idempotent (keyed on the checkout id) and the launch start is guarded, so the webhook
// and this path can both fire without double-launching or double-buying a domain.
const lastStripeCheck = new Map(); // sessionId -> ms (don't hit Stripe on every 2s poll)

let stripeOverride = null; // tests only
export const __setStripeForTests = (s) => { stripeOverride = s; };
async function stripe() {
  if (stripeOverride) return stripeOverride;
  const { stripeClient } = await import('../launch/stripe.js');
  return stripeClient();
}

export async function fulfillFromStripe(sessionId, { user = null, launch = true } = {}) {
  const t = lastStripeCheck.get(sessionId) || 0;
  if (Date.now() - t < 5000) return null;
  lastStripeCheck.set(sessionId, Date.now());
  if (lastStripeCheck.size > 500) lastStripeCheck.clear();

  const session = await (await stripe()).checkout.sessions.retrieve(sessionId);
  if (session.mode !== 'payment' || session.status !== 'complete' || session.payment_status !== 'paid') return null;
  const m = session.metadata || {};
  if (user && String(m.userId) !== String(user.id) && !isAdmin(user)) return null; // not theirs
  recordPurchase(session);
  console.log(`💸 Payment confirmed from Stripe directly: ${m.domain} (${sessionId})`);
  if (launch && m.ownDomain !== 'true') {
    startLaunchForSession(session).catch((e) => console.error('✗ Launch (direct):', e.message));
  }
  return getDb().prepare('SELECT * FROM sites WHERE stripe_session_id = ?').get(sessionId) || null;
}

export function mountLaunches(app) {
  // A launch can't still be running in a process that just started: the last one was cut
  // off by a restart. Mark it so an admin can see it and press Retry.
  const stuck = getDb().prepare("SELECT id, domain FROM sites WHERE launch_status = 'running'").all();
  for (const s of stuck) {
    getDb().prepare("UPDATE sites SET launch_status = 'error', launch_error = ? WHERE id = ?")
      .run('Interrupted by a server restart. Press Retry on the admin page.', s.id);
    console.log(`⚠ launch for ${s.domain} was interrupted by a restart — marked for retry`);
  }

  // Polled by the Launching screen right after Stripe sends them back.
  app.get('/api/launch/status', requireUser, async (req, res) => {
    const sessionId = String(req.query.session_id || '');
    const siteId = Number(req.query.site_id || 0);
    if (!sessionId && !siteId) return res.status(400).json({ error: 'session_id or site_id required' });
    const db = getDb();
    let site = sessionId
      ? db.prepare('SELECT * FROM sites WHERE stripe_session_id = ?').get(sessionId)
      : db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
    if (!site && sessionId.startsWith('cs_')) {
      try { site = await fulfillFromStripe(sessionId, { user: req.user }); }
      catch (e) { console.error('✗ Stripe lookup:', e.message); }
    }
    // Stripe's webhook usually lands within a second or two of the redirect, but not always first.
    if (!site) return res.json({ status: 'confirming_payment', steps: freshSteps(null).map((s) => ({ ...s, state: 'pending' })) });
    if (site.user_id !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not your site.' });
    res.json(publicLaunch(site));
  });

  // Admin: record any paid checkouts from the last 30 days that never reached us. Records
  // only — it does NOT launch (that could buy domains). Each one shows up with a Retry button.
  app.post('/api/admin/sync-stripe', requireUser, requireAdmin, async (_req, res) => {
    try {
      const s = await stripe();
      const since = Math.floor(Date.now() / 1000) - 30 * 86400;
      const db = getDb();
      const found = [];
      for await (const cs of s.checkout.sessions.list({ created: { gte: since }, status: 'complete', limit: 100 })) {
        if (cs.mode !== 'payment' || cs.payment_status !== 'paid') continue;
        if (db.prepare('SELECT 1 FROM sites WHERE stripe_session_id = ?').get(cs.id)) continue;
        recordPurchase(cs);
        const own = cs.metadata?.ownDomain === 'true';
        if (!own) {
          db.prepare("UPDATE sites SET launch_status = 'error', launch_error = ? WHERE stripe_session_id = ?")
            .run('Paid, but the launch never started (found by Stripe sync). Press Retry to launch — this registers the domain.', cs.id);
        }
        found.push({ domain: cs.metadata?.domain || null, amount: cs.amount_total / 100, own });
      }
      res.json({ recorded: found.length, found });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Admin: re-run a failed / stuck launch. Never re-buys a registered domain.
  app.post('/api/admin/sites/:id/retry-launch', requireUser, requireAdmin, (req, res) => {
    const site = getDb().prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'No such site.' });
    if (site.own_domain) return res.status(400).json({ error: 'Own-domain sites are connected by the owner.' });
    if (site.launch_status === 'running') return res.status(409).json({ error: 'That launch is running right now.' });
    launchSite(site.id).catch((e) => console.error('✗ retry launch:', e.message));
    res.json({ started: true, willRegister: !site.registered_at });
  });

  // Admin: mark a needs-attention launch as handled (e.g. nameservers set by hand).
  app.post('/api/admin/sites/:id/mark-launched', requireUser, requireAdmin, (req, res) => {
    const db = getDb();
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
    if (!site) return res.status(404).json({ error: 'No such site.' });
    const steps = readSteps(site).map((s) =>
      s.key === 'live' || s.state === 'skipped' ? s : { ...s, state: 'done', detail: null });
    saveProgress(site.id, steps, { launch_status: 'done', launch_error: null });
    res.json({ ok: true });
  });
}

export { publicLaunch };
