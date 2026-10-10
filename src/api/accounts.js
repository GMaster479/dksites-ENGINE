import { createHash, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { getDb, now, DAY } from './db.js';
import { sendEmail, layout, button, esc } from './mailer.js';

// ACCOUNTS
//
// Anonymous-first stays the rule: anyone can generate and edit a preview without an
// account. The account gate is checkout. Signing in CLAIMS the previews made in that
// browser, and from then on only the owner (or an admin) can edit them.
//
// Two ways in, both landing on the same user row keyed by email:
//   - magic link: email -> single-use 15-minute link -> session cookie
//   - Google: Google Identity Services ID token, verified server-side
//
// Sessions are an HttpOnly cookie on .dksites.com. app.dksites.com and api.dksites.com
// are the same SITE, so the cookie rides along on fetch(..., { credentials: 'include' }).

const APP_ORIGIN = () => config.appOrigin || 'https://app.dksites.com';
const API_BASE = () => process.env.API_BASE_URL || 'https://api.dksites.com';
const COOKIE = 'dks_session';
const COOKIE_DOMAIN = () => process.env.COOKIE_DOMAIN || '.dksites.com';
// COOKIE_DOMAIN=host → host-only cookie (local testing on localhost).
const domainAttr = () => (COOKIE_DOMAIN() === 'host' ? '' : ` Domain=${COOKIE_DOMAIN()};`);
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

export function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(normEmail)
    .filter(Boolean);
}
const isAdmin = (user) => !!user && adminEmails().includes(user.email);

// ---------------------------------------------------------------- cookies / sessions

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=${token};${domainAttr()} Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  ]);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [`${COOKIE}=;${domainAttr()} Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`]);
}

function startSession(res, userId) {
  const db = getDb();
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), userId, now(), now() + SESSION_DAYS * DAY);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  setSessionCookie(res, token);
}

function upsertUser({ email, name = null, googleSub = null }) {
  const db = getDb();
  const e = normEmail(email);
  let user = googleSub ? db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub) : null;
  if (!user) user = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  if (!user) {
    const r = db.prepare('INSERT INTO users (email, name, google_sub, created_at) VALUES (?, ?, ?, ?)')
      .run(e, name, googleSub, now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  } else {
    // Link Google to an existing email account the first time they use it.
    if (googleSub && !user.google_sub) db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(googleSub, user.id);
    if (name && !user.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return user;
}

const publicUser = (u) => (u ? { id: u.id, email: u.email, name: u.name || null, isAdmin: isAdmin(u) } : null);

/** Attaches req.user (or null) to every request from the session cookie. */
function attachUser(req, _res, next) {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const db = getDb();
    const row = db.prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    ).get(hash(token), now());
    if (row) req.user = row;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', needsSignIn: true });
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admins only.' });
  next();
}

// ---------------------------------------------------------------- ownership

function claimBuild(userId, { previewId, slug = null, name = null, previewUrl = null }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM builds WHERE preview_id = ?').get(previewId);
  if (existing && existing.user_id !== userId) return { previewId, claimed: false, reason: 'owned by another account' };
  if (existing) {
    db.prepare('UPDATE builds SET slug = COALESCE(?, slug), name = COALESCE(?, name), preview_url = COALESCE(?, preview_url) WHERE preview_id = ?')
      .run(slug, name, previewUrl, previewId);
  } else {
    db.prepare('INSERT INTO builds (preview_id, user_id, slug, name, preview_url, claimed_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(previewId, userId, slug, name, previewUrl, now());
  }
  return { previewId, claimed: true };
}

/**
 * Editing guard. Unclaimed previews stay open (anonymous-first). Once a preview is
 * claimed, only its owner or an admin may edit, upload to, or connect a domain for it.
 * A signed-in person touching an unclaimed preview claims it on the spot.
 */
function guardPreview(req, res, next) {
  const previewId =
    req.body?.previewId ||
    (req.method === 'GET' ? decodeURIComponent((req.path || '').split('/').filter(Boolean)[0] || '') : '');
  if (!previewId) return next();
  const row = getDb().prepare('SELECT user_id FROM builds WHERE preview_id = ?').get(previewId);
  if (!row) {
    if (req.user) claimBuild(req.user.id, { previewId, slug: req.body?.slug || null });
    return next();
  }
  if (req.user && (req.user.id === row.user_id || isAdmin(req.user))) return next();
  return res.status(403).json({
    error: 'This site belongs to another account. Sign in with that account to edit it.',
    needsSignIn: !req.user,
  });
}

// ---------------------------------------------------------------- checkout + webhook hooks

/**
 * Extra Stripe options for the signed-in buyer. Auto-renew is strictly OPT-IN: only when
 * the checkbox was ticked do we ask Stripe to save the card for next year.
 */
export function checkoutExtras(req) {
  const u = req.user;
  return {
    userId: u?.id || null,
    email: u?.email || null,
    autoRenew: req.body?.autoRenew === true,
    ownDomain: req.body?.ownDomain === true,
    successUrl: `${APP_ORIGIN()}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${APP_ORIGIN()}/?checkout=cancel`,
  };
}

/** Record a completed checkout as a site. Idempotent on the Stripe session id. */
export function recordPurchase(session) {
  const m = session?.metadata || {};
  const db = getDb();
  const paidAt = now();
  const r = db.prepare(
    `INSERT OR IGNORE INTO sites
      (user_id, preview_id, slug, domain, own_domain, status, amount_cents, auto_renew,
       stripe_session_id, stripe_customer_id, stripe_payment_intent, paid_at, renews_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    m.userId ? Number(m.userId) : null,
    m.previewId || null,
    m.slug || null,
    m.domain || null,
    m.ownDomain === 'true' ? 1 : 0,
    Number.isFinite(session.amount_total) ? session.amount_total : null,
    m.autoRenew === 'true' ? 1 : 0,
    session.id || null,
    typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
    paidAt,
    paidAt + 365 * DAY,
    paidAt
  );
  // The build becomes the buyer's, even if they somehow never signed in on that browser.
  if (m.userId && m.previewId) claimBuild(Number(m.userId), { previewId: m.previewId, slug: m.slug || null });
  return { recorded: r.changes > 0 };
}

// ---------------------------------------------------------------- Google

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google sign-in is not configured yet.');
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('Google could not verify that sign-in.');
  const t = await res.json();
  if (t.aud !== clientId) throw new Error('That Google sign-in was not issued for DK Sites.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) throw new Error('Unexpected Google issuer.');
  if (String(t.email_verified) !== 'true') throw new Error('Your Google email is not verified.');
  if (Number(t.exp) * 1000 < now()) throw new Error('That Google sign-in expired. Try again.');
  return { email: t.email, name: t.name || null, googleSub: t.sub };
}

// ---------------------------------------------------------------- mount

export function mountAccounts(app) {
  getDb(); // create the file + tables at boot so problems surface immediately
  app.use(attachUser);

  // Gates and guards are registered before every other route.
  app.use('/api/checkout', requireUser);
  app.use(['/api/apply-edit', '/api/upload', '/api/import-image', '/api/domain/connect'], guardPreview);
  app.use('/api/edit-options', guardPreview);

  const linkLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many sign-in emails. Wait a few minutes and try again.' },
  });

  // Send a magic link. Always answers the same way, so it can't be used to probe which
  // emails have accounts.
  app.post('/api/auth/email', linkLimiter, async (req, res) => {
    const email = normEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const token = newToken();
    getDb().prepare('INSERT INTO login_tokens (token_hash, email, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(hash(token), email, String(req.body?.returnTo || '').slice(0, 200) || null, now(), now() + LINK_MINUTES * 60 * 1000);
    const link = `${API_BASE()}/api/auth/verify?token=${token}`;
    try {
      await sendEmail({
        to: email,
        subject: 'Your DK Sites sign-in link',
        text: `Sign in to DK Sites:\n${link}\n\nThis link works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
        html: layout({
          heading: 'Sign in to DK Sites',
          bodyHtml:
            `<p style="margin:0 0 20px">Tap the button to sign in. It works once and expires in ${LINK_MINUTES} minutes.</p>` +
            `<p style="margin:0 0 20px">${button(link, 'Sign in')}</p>` +
            `<p style="margin:0;font-size:13px;color:#71717a">Didn't ask for this? You can ignore it — nothing happens unless the link is used.</p>`,
        }),
      });
    } catch (e) {
      console.error('✗ magic link email:', e.message);
      return res.status(502).json({ error: 'Could not send the email right now. Try again, or use Google.' });
    }
    res.json({ sent: true });
  });

  // The link in the email lands here, signs them in, and sends them back to the app.
  app.get('/api/auth/verify', (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hash(req.query.token || ''));
    if (!row || row.used_at || row.expires_at < now()) {
      return res.redirect(`${APP_ORIGIN()}/?signin=expired`);
    }
    db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
    const user = upsertUser({ email: row.email });
    startSession(res, user.id);
    res.redirect(`${APP_ORIGIN()}/?signedin=1`);
  });

  app.post('/api/auth/google', async (req, res) => {
    try {
      const g = await verifyGoogleCredential(String(req.body?.credential || ''));
      const user = upsertUser(g);
      startSession(res, user.id);
      res.json({ user: publicUser(user) });
    } catch (e) {
      res.status(401).json({ error: e.message });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: publicUser(req.user), googleClientId: process.env.GOOGLE_CLIENT_ID || null });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Attach the previews this browser made before signing in.
  app.post('/api/builds/claim', requireUser, (req, res) => {
    const list = Array.isArray(req.body?.builds) ? req.body.builds.slice(0, 50) : [];
    const results = list
      .filter((b) => b && typeof b.previewId === 'string' && b.previewId.length < 80)
      .map((b) => claimBuild(req.user.id, b));
    res.json({ results });
  });

  // Dashboard data: their previews and their live sites.
  app.get('/api/me/sites', requireUser, (req, res) => {
    const db = getDb();
    const builds = db.prepare('SELECT * FROM builds WHERE user_id = ? ORDER BY claimed_at DESC').all(req.user.id);
    const sites = db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY paid_at DESC').all(req.user.id);
    res.json({
      user: publicUser(req.user),
      builds: builds.map((b) => ({
        previewId: b.preview_id, slug: b.slug, name: b.name, previewUrl: b.preview_url, claimedAt: b.claimed_at,
      })),
      sites: sites.map((s) => ({
        id: s.id, domain: s.domain, slug: s.slug, previewId: s.preview_id, ownDomain: !!s.own_domain,
        status: s.status, amount: s.amount_cents != null ? s.amount_cents / 100 : null,
        autoRenew: !!s.auto_renew, paidAt: s.paid_at, renewsAt: s.renews_at,
        canManageBilling: !!s.stripe_customer_id,
        // Customers see "launching" / "being checked", never the raw error text.
        launchStatus: s.own_domain ? 'own_domain' : s.launch_status || 'starting',
      })),
    });
  });

  // Stripe's hosted customer portal: update card, see receipts. We build no billing UI.
  app.post('/api/billing/portal', requireUser, async (req, res) => {
    try {
      const site = getDb()
        .prepare('SELECT stripe_customer_id FROM sites WHERE user_id = ? AND stripe_customer_id IS NOT NULL ORDER BY paid_at DESC')
        .get(req.user.id);
      if (!site) return res.status(404).json({ error: 'No billing on file yet.' });
      const { stripeClient } = await import('../launch/stripe.js');
      const portal = await stripeClient().billingPortal.sessions.create({
        customer: site.stripe_customer_id,
        return_url: `${APP_ORIGIN()}/?view=dashboard`,
      });
      res.json({ url: portal.url });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- admin ----
  app.get('/api/admin/overview', requireUser, requireAdmin, (_req, res) => {
    const db = getDb();
    const users = db.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.last_login_at, (u.google_sub IS NOT NULL) AS google,
              (SELECT COUNT(*) FROM builds b WHERE b.user_id = u.id) AS builds,
              (SELECT COUNT(*) FROM sites s WHERE s.user_id = u.id) AS sites
       FROM users u ORDER BY u.created_at DESC LIMIT 200`
    ).all();
    const sites = db.prepare(
      `SELECT s.*, u.email FROM sites s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.paid_at DESC LIMIT 200`
    ).all();
    const builds = db.prepare(
      `SELECT b.*, u.email FROM builds b JOIN users u ON u.id = b.user_id ORDER BY b.claimed_at DESC LIMIT 100`
    ).all();
    const revenue = sites.reduce((n, s) => n + (s.amount_cents || 0), 0) / 100;
    const renewingSoon = sites.filter((s) => s.renews_at && s.renews_at - now() < 45 * DAY && s.status === 'active').length;
    res.json({
      totals: { users: users.length, sites: sites.length, builds: builds.length, revenue, renewingSoon },
      users: users.map((u) => ({ ...u, google: !!u.google })),
      sites: sites.map((s) => ({
        id: s.id, email: s.email, domain: s.domain, slug: s.slug, ownDomain: !!s.own_domain, status: s.status,
        amount: s.amount_cents != null ? s.amount_cents / 100 : null, autoRenew: !!s.auto_renew,
        paidAt: s.paid_at, renewsAt: s.renews_at, reminder30At: s.reminder30_at, reminder7At: s.reminder7_at,
        launchStatus: s.own_domain ? 'own_domain' : s.launch_status || 'starting',
        launchError: s.launch_error || null, registeredAt: s.registered_at || null,
        zoneId: s.zone_id || null, autoRenewChangedAt: s.auto_renew_changed_at || null,
      })),
      builds: builds.map((b) => ({ previewId: b.preview_id, email: b.email, name: b.name, slug: b.slug, previewUrl: b.preview_url, claimedAt: b.claimed_at })),
    });
  });

  // Open in a browser while signed in as an admin to see the renewal email for real.
  app.get('/api/admin/reminder-preview', requireUser, requireAdmin, async (req, res) => {
    const { renewalEmail } = await import('./renewals.js');
    const sample = {
      domain: 'tonyscentralpizza.com', amount_cents: 12870, auto_renew: req.query.auto === '1' ? 1 : 0,
      renews_at: now() + 30 * DAY, own_domain: 1,
    };
    res.type('html').send(renewalEmail(sample, Number(req.query.days || 30)).html);
  });

  app.post('/api/admin/run-reminders', requireUser, requireAdmin, async (req, res) => {
    const { runRenewalReminders } = await import('./renewals.js');
    res.json(await runRenewalReminders({ dryRun: req.body?.dryRun !== false }));
  });

  // Daily renewal sweep. Idempotent: each site gets each reminder at most once.
  const sweep = async () => {
    try {
      const { runRenewalReminders } = await import('./renewals.js');
      const r = await runRenewalReminders({ dryRun: false });
      if (r.sent) console.log(`✉  renewal reminders sent: ${r.sent}`);
    } catch (e) {
      console.error('✗ renewal sweep:', e.message);
    }
  };
  setTimeout(sweep, 60 * 1000).unref();
  setInterval(sweep, 12 * 60 * 60 * 1000).unref();
}

export { requireUser, requireAdmin, isAdmin, publicUser, esc };
