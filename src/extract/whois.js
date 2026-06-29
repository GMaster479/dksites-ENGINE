// Registrar interceptor. Uses RDAP (HTTP/JSON) rather than legacy WHOIS port 43 —
// RDAP is firewall-friendly, structured, and the modern standard. The discovered
// registrar is injected into the session doc so the app can pre-load the correct
// registrar-specific DNS walkthrough (GoDaddy / Namecheap / Bluehost / Network
// Solutions / etc.) on launch day.

function rootDomain(websiteUri) {
  try {
    const host = new URL(websiteUri).hostname.replace(/^www\./, '');
    return host;
  } catch {
    return null;
  }
}

// Map common registrar names -> the walkthrough key the app UI uses.
const REGISTRAR_KEYS = [
  [/godaddy/i, 'godaddy'],
  [/namecheap/i, 'namecheap'],
  [/bluehost/i, 'bluehost'],
  [/network ?solutions/i, 'networksolutions'],
  [/google|squarespace domains/i, 'squarespace'],
  [/cloudflare/i, 'cloudflare'],
  [/name\.com/i, 'namecom'],
  [/hover/i, 'hover'],
  [/wix/i, 'wix'],
  [/hostgator/i, 'hostgator'],
  [/ionos|1&1/i, 'ionos'],
  [/porkbun/i, 'porkbun'],
];

function toWalkthroughKey(registrarName) {
  if (!registrarName) return 'generic';
  for (const [re, key] of REGISTRAR_KEYS) if (re.test(registrarName)) return key;
  return 'generic';
}

export async function detectRegistrar(websiteUri) {
  const domain = rootDomain(websiteUri);
  if (!domain) return { domain: null, registrar: null, walkthroughKey: 'generic' };

  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { Accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { domain, registrar: null, walkthroughKey: 'generic', status: res.status };
    const data = await res.json();

    // Registrar is the entity with role "registrar"; name is in its vCard.
    let registrarName = null;
    for (const ent of data.entities || []) {
      if ((ent.roles || []).includes('registrar')) {
        const fn = (ent.vcardArray?.[1] || []).find((f) => f[0] === 'fn');
        registrarName = fn?.[3] || ent.handle || null;
        break;
      }
    }

    const statuses = data.status || [];
    const locked = statuses.some((s) => /lock|transferprohibited/i.test(s));

    return {
      domain,
      registrar: registrarName,
      walkthroughKey: toWalkthroughKey(registrarName),
      transferLocked: locked,
      nameservers: (data.nameservers || []).map((n) => n.ldhName),
    };
  } catch (e) {
    return { domain, registrar: null, walkthroughKey: 'generic', error: String(e.message || e) };
  }
}
