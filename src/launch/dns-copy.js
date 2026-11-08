// KEEP THEIR EMAIL WORKING when they move their domain to us.
//
// Connecting a domain the owner already has means switching its nameservers to the
// Cloudflare zone we create. A fresh zone is EMPTY — so if their email lives on that
// domain (Google Workspace, Microsoft 365, GoDaddy/Namecheap email…), switching nameservers
// would silently cut it off. That's the worst thing a website product could do to a small
// business.
//
// So BEFORE we create the zone, we read their current public DNS (via DNS-over-HTTPS, the
// same answers the whole internet sees) for every record email and common services need,
// and copy them into the new zone. Website records (the bare domain and www) are the only
// ones we replace — they now point at the new site.
//
// What we can't see: a zone's full record list isn't public, so an unusual subdomain
// (say, booking.theirbusiness.com) can only be found if it's in our list below. The app
// shows the owner what we copied and asks them to tell us about anything else.

const DOH = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

// Record type numbers in DNS JSON answers.
const TYPE = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };
const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));

// Hostnames worth checking, relative to the domain ('' = the domain itself).
export const HOSTS = [
  // email + email login/setup
  'mail', 'email', 'webmail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'mx1', 'mx2',
  'autodiscover', 'autoconfig', 'send', 'bounce', 'bounces', 'em', 'mta', 'click', 'links',
  // Microsoft 365 / Teams
  'lyncdiscover', 'sip', 'enterpriseregistration', 'enterpriseenrollment', 'msoid',
  // common services small businesses point at their domain
  'shop', 'store', 'order', 'orders', 'online', 'menu', 'book', 'booking', 'bookings',
  'appointments', 'schedule', 'reservations', 'app', 'portal', 'members', 'blog', 'news',
  'calendar', 'docs', 'drive', 'go', 'link', 'links', 'pay', 'payments', 'support', 'help',
  'ftp', 'cpanel', 'admin', 'm', 'secure', 'status', 'events', 'tickets', 'gift', 'giftcards',
];
// Email-signing keys (DKIM). These selectors cover Google, Microsoft, Zoho, Mailchimp,
// SendGrid, Proton, Fastmail, GoDaddy, Namecheap, Titan, Amazon SES and most others.
export const DKIM_SELECTORS = [
  'google', 'selector1', 'selector2', 'default', 'dkim', 'mail', 'k1', 'k2', 'k3',
  's1', 's2', 'zoho', 'zmail', 'mandrill', 'mxvault', 'smtpapi', 'pm', 'resend',
  'protonmail', 'protonmail2', 'protonmail3', 'fm1', 'fm2', 'fm3', 'titan', 'titan1',
  'everlytickey1', 'everlytickey2', 'mailjet', 'krs', 'sig1', 'turbo-smtp', 'hs1', 'hs2',
];
export const SRV_NAMES = [
  '_autodiscover._tcp', '_sip._tls', '_sipfederationtls._tcp', '_imap._tcp', '_imaps._tcp',
  '_pop3._tcp', '_pop3s._tcp', '_submission._tcp', '_submissions._tcp', '_caldavs._tcp', '_carddavs._tcp',
];

const clean = (s) => String(s || '').replace(/\.$/, '');

/** One DNS question over HTTPS. Returns the answers of that exact type, or null on failure. */
async function ask(name, type, fetchImpl = fetch) {
  for (const base of DOH) {
    try {
      const r = await fetchImpl(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.Status !== 0 && j.Status !== 3) continue; // 3 = name doesn't exist: a real answer
      return (j.Answer || []).filter((a) => a.type === TYPE[type] || (type !== 'CNAME' && a.type === TYPE.CNAME));
    } catch { /* try the next resolver */ }
  }
  return null; // both resolvers failed
}

/** TXT answers come back quoted and sometimes split into 255-char chunks. */
export function txtValue(data) {
  const parts = String(data).match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((p) => p.slice(1, -1).replace(/\\"/g, '"')).join('') : String(data);
}

/** Turn one DoH answer into a Cloudflare record body (unproxied, auto TTL). */
export function toCloudflare(answer, domain) {
  const type = TYPE_NAME[answer.type];
  const name = clean(answer.name).toLowerCase();
  const rel = name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -(domain.length + 1)) : null;
  if (!rel) return null; // an answer for some other zone (e.g. the end of a CNAME chain)
  const base = { name: rel === '@' ? domain : `${rel}.${domain}`, ttl: 1 };
  const d = String(answer.data);
  switch (type) {
    case 'MX': {
      const [prio, host] = d.split(/\s+/);
      return { ...base, type, content: clean(host), priority: Number(prio) };
    }
    case 'TXT': return { ...base, type, content: txtValue(d) };
    case 'CNAME': return { ...base, type, content: clean(d), proxied: false };
    case 'A': case 'AAAA': return { ...base, type, content: d, proxied: false };
    case 'SRV': {
      const [priority, weight, port, target] = d.split(/\s+/);
      return { ...base, type, data: { priority: +priority, weight: +weight, port: +port, target: clean(target) } };
    }
    case 'CAA': {
      const m = d.match(/^(\d+)\s+(\S+)\s+"?(.*?)"?$/);
      return m ? { ...base, type, data: { flags: +m[1], tag: m[2], value: m[3] } } : null;
    }
    default: return null;
  }
}

const key = (r) => `${r.type} ${r.name} ${r.content ?? JSON.stringify(r.data)}`;

/** Best guess at who runs their email, from the MX hosts. */
export function emailProvider(mx) {
  const hosts = mx.map((m) => m.content.toLowerCase()).join(' ');
  if (!hosts) return null;
  const known = [
    [/google\.com|googlemail\.com/, 'Google Workspace (Gmail)'],
    [/outlook\.com|protection\.outlook/, 'Microsoft 365 (Outlook)'],
    [/secureserver\.net/, 'GoDaddy email'],
    [/privateemail\.com/, 'Namecheap Private Email'],
    [/registrar-servers\.com/, 'Namecheap email forwarding'],
    [/zoho\./, 'Zoho Mail'],
    [/titan\.email/, 'Titan email'],
    [/protonmail|proton\.me/, 'Proton Mail'],
    [/messagingengine\.com/, 'Fastmail'],
    [/improvmx/, 'ImprovMX forwarding'],
    [/mx\.cloudflare\.net/, 'Cloudflare email forwarding'],
    [/icloud\.com/, 'iCloud Mail'],
    [/yahoodns|yahoo/, 'Yahoo Mail'],
    [/hostinger/, 'Hostinger email'],
    [/ionos|1and1/, 'IONOS email'],
    [/bluehost|hostgator|websitewelcome/, 'Bluehost/HostGator email'],
    [/wixdns|wix\.com/, 'Wix email'],
  ];
  for (const [re, name] of known) if (re.test(hosts)) return name;
  return 'Email (provider not recognized)';
}

/**
 * Snapshot every record worth keeping. Never throws: returns ok:false when the domain's
 * DNS couldn't be read at all, so the caller can stop and ask a human.
 */
export async function snapshotDns(domain, { fetchImpl = fetch } = {}) {
  domain = String(domain).toLowerCase().replace(/\.$/, '');
  const records = new Map();
  let failures = 0;
  let questions = 0;

  const add = (answers) => {
    for (const a of answers || []) {
      const r = toCloudflare(a, domain);
      if (!r) continue;
      // The website itself (domain + www) moves to the new site: never copy those.
      const rel = r.name === domain ? '@' : r.name.slice(0, -(domain.length + 1));
      if ((rel === '@' || rel === 'www') && ['A', 'AAAA', 'CNAME'].includes(r.type)) continue;
      records.set(key(r), r);
    }
  };
  const q = async (name, type) => {
    questions++;
    const ans = await ask(name, type, fetchImpl);
    if (ans === null) failures++;
    else add(ans);
    return ans || [];
  };

  // The domain itself: mail routing, SPF + verification codes, certificate rules.
  await Promise.all([q(domain, 'MX'), q(domain, 'TXT'), q(domain, 'CAA')]);
  // DMARC policy.
  await q(`_dmarc.${domain}`, 'TXT');
  // DKIM keys: a CNAME (Microsoft, SendGrid) or a TXT (Google, most others).
  await Promise.all(DKIM_SELECTORS.map((s) => q(`${s}._domainkey.${domain}`, 'TXT')));
  // Service records (Outlook auto-setup, Teams, mail clients).
  await Promise.all(SRV_NAMES.map((n) => q(`${n}.${domain}`, 'SRV')));
  // Named hosts: a CNAME if there is one, otherwise its A/AAAA/MX/TXT.
  await Promise.all([...new Set(HOSTS)].map(async (h) => {
    const name = `${h}.${domain}`;
    const c = await q(name, 'CNAME');
    if (c.some((a) => a.type === TYPE.CNAME && clean(a.name).toLowerCase() === name)) return;
    await Promise.all([q(name, 'A'), q(name, 'AAAA'), q(name, 'MX'), q(name, 'TXT')]);
  }));

  const list = [...records.values()];
  const mx = list.filter((r) => r.type === 'MX' && r.name === domain).sort((a, b) => a.priority - b.priority);
  const provider = emailProvider(mx);
  return {
    domain,
    ok: failures < questions * 0.5, // if most lookups failed, we did NOT really see their DNS
    failures,
    questions,
    records: list,
    email: {
      hasEmail: mx.length > 0,
      provider,
      mx: mx.map((m) => `${m.priority} ${m.content}`),
      // Namecheap's free forwarding only works while Namecheap runs the DNS: copying the MX
      // records isn't enough. A person needs to set up forwarding again (e.g. Cloudflare's
      // free Email Routing) — flag it instead of pretending it's handled.
      needsHelp: /forwarding/i.test(provider || '') && /Namecheap/.test(provider || ''),
    },
    summary: summarize(list, domain),
  };
}

function summarize(list, domain) {
  const rel = (r) => (r.name === domain ? domain : r.name);
  return list.map((r) => {
    const v = r.content ?? (r.data ? Object.values(r.data).join(' ') : '');
    const short = String(v).length > 60 ? `${String(v).slice(0, 57)}…` : v;
    return `${r.type} ${rel(r)} → ${short}`;
  });
}
