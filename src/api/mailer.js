import { config } from '../config.js';

// Transactional email through Resend's REST API — no SDK, just fetch.
//
// Until RESEND_API_KEY is set, emails are printed to the server log instead of sent, so
// sign-in can be tested on day one (read the link out of `pm2 logs dksites-api`).

const FROM = () => process.env.EMAIL_FROM || 'DK Sites <hello@dksites.com>';
const REPLY_TO = () => process.env.EMAIL_REPLY_TO || 'dylan@dksitesllc.com';

export async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n✉  [email not sent — RESEND_API_KEY missing]\n   to: ${to}\n   subject: ${subject}\n${text}\n`);
    return { logged: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(), to: [to], reply_to: REPLY_TO(), subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Email send failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Plain, readable, monochrome — matches the app, renders in every mail client. */
export function layout({ heading, bodyHtml }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7">
<tr><td style="padding:28px 28px 8px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#71717a">DK Sites</td></tr>
<tr><td style="padding:0 28px 8px;font-size:22px;font-weight:600;line-height:1.3">${esc(heading)}</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.6;color:#3f3f46">${bodyHtml}</td></tr>
</table>
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0">DK Sites LLC · Connecticut</p>
</td></tr></table></body></html>`;
}

export function button(href, label) {
  return `<a href="${esc(href)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600;font-size:15px">${esc(label)}</a>`;
}

export { esc };
