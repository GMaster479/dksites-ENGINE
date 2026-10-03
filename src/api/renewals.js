import { getDb, now, DAY } from './db.js';
import { sendEmail, layout, button, esc } from './mailer.js';

// RENEWAL REMINDERS — and the DK Sites upsell that rides along with them.
//
// Each paid site gets two emails before its year is up: 30 days out and 7 days out.
// Both offer the same choice:
//   1. Renew at the rate you paid this year.
//   2. Or upgrade to a custom-designed DK Sites build, discounted by what year two would
//      have cost — e.g. $750 custom design − $128.70 = $621.30.
//
// Idempotent: reminder30_at / reminder7_at are stamped once sent, so the sweep can run as
// often as it likes without double-emailing anyone.

const UPGRADE_BASE = () => Number(process.env.UPGRADE_BASE_PRICE || 750);
const APP = () => process.env.APP_ORIGIN || 'https://app.dksites.com';
const CONTACT = () => process.env.EMAIL_REPLY_TO || 'dylan@dksitesllc.com';

const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
const dateStr = (ms) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

export function upgradeOffer(amountCents) {
  const year2 = (amountCents || 0) / 100;
  const base = UPGRADE_BASE();
  return { base, credit: year2, price: Math.max(0, Math.round((base - year2) * 100) / 100) };
}

export function renewalEmail(site, daysOut) {
  const year2 = (site.amount_cents || 0) / 100;
  const offer = upgradeOffer(site.amount_cents);
  const when = dateStr(site.renews_at);
  const domain = site.domain || 'your site';
  const auto = !!site.auto_renew;

  const renewLine = auto
    ? `Your site is set to <strong>renew automatically on ${esc(when)}</strong> at ${money(year2)}. Nothing to do — it stays live.`
    : `Your hosting for <strong>${esc(domain)}</strong> is up on <strong>${esc(when)}</strong>. Renew for another year at the same ${money(year2)} you paid this year and it stays live.`;

  const ownNote = site.own_domain
    ? `<p style="margin:0 0 18px;font-size:13px;color:#71717a">Reminder: your domain itself renews separately at your registrar — keep that paid too, or the site goes offline regardless.</p>`
    : '';

  const subject =
    daysOut <= 7
      ? `${domain} renews in ${daysOut} days — renew or upgrade`
      : `${domain}: your year is almost up — renew, or upgrade for ${money(offer.price)}`;

  const html = layout({
    heading: daysOut <= 7 ? `${daysOut} days until ${domain} renews` : `Your first year with ${domain} is almost up`,
    bodyHtml:
      `<p style="margin:0 0 18px">${renewLine}</p>` +
      ownNote +
      (auto ? '' : `<p style="margin:0 0 26px">${button(`${APP()}/?view=dashboard`, 'Renew my site')}</p>`) +
      `<div style="border-top:1px solid #e4e4e7;padding-top:22px;margin-top:4px">` +
      `<p style="margin:0 0 6px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#71717a">Or go custom</p>` +
      `<p style="margin:0 0 14px">Want a site designed and hand-built by DK Sites instead? A custom build is ${money(offer.base)} — ` +
      `and we'll credit the ${money(year2)} you'd spend on year two, so it's <strong>${money(offer.price)}</strong>.</p>` +
      `<p style="margin:0 0 6px">${button(`mailto:${CONTACT()}?subject=${encodeURIComponent(`Custom site for ${domain}`)}`, `Upgrade for ${money(offer.price)}`)}</p>` +
      `</div>`,
  });

  const text =
    `${auto ? `Your site ${domain} renews automatically on ${when} at ${money(year2)}.` : `Your hosting for ${domain} is up on ${when}. Renew for another year at ${money(year2)}: ${APP()}/?view=dashboard`}\n\n` +
    (site.own_domain ? 'Reminder: keep your domain paid at your registrar too.\n\n' : '') +
    `Or upgrade to a custom DK Sites build: ${money(offer.base)} minus your ${money(year2)} year-two credit = ${money(offer.price)}. Reply to this email to start.`;

  return { subject, html, text };
}

export async function runRenewalReminders({ dryRun = true } = {}) {
  const db = getDb();
  const t = now();
  const due = db.prepare(
    `SELECT s.*, u.email FROM sites s JOIN users u ON u.id = s.user_id
     WHERE s.status = 'active' AND s.renews_at IS NOT NULL AND s.renews_at > ?
       AND ((s.renews_at - ? <= ? AND s.reminder30_at IS NULL)
         OR (s.renews_at - ? <= ? AND s.reminder7_at IS NULL))`
  ).all(t, t, 30 * DAY, t, 7 * DAY);

  const out = [];
  for (const site of due) {
    const daysOut = Math.max(1, Math.ceil((site.renews_at - t) / DAY));
    const which = daysOut <= 7 ? 'reminder7_at' : 'reminder30_at';
    if (site[which]) continue;
    const mail = renewalEmail(site, daysOut);
    if (!dryRun) {
      try {
        await sendEmail({ to: site.email, ...mail });
        // Sending the 7-day note also retires the 30-day one if it was somehow missed.
        db.prepare(`UPDATE sites SET ${which} = ?${which === 'reminder7_at' ? ', reminder30_at = COALESCE(reminder30_at, ?)' : ''} WHERE id = ?`)
          .run(...(which === 'reminder7_at' ? [t, t, site.id] : [t, site.id]));
      } catch (e) {
        out.push({ siteId: site.id, error: e.message });
        continue;
      }
    }
    out.push({ siteId: site.id, to: site.email, domain: site.domain, which, daysOut, subject: mail.subject });
  }
  return { dryRun, sent: dryRun ? 0 : out.filter((o) => !o.error).length, reminders: out };
}
