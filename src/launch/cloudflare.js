import { config } from '../config.js';

// Getting a client's live domain served by our Worker.
//
// We add the domain to OUR Cloudflare account as a full zone — the same arrangement that
// already serves dksites.com — rather than using Cloudflare for SaaS. For domains we
// register on the client's behalf we control the nameservers anyway, and a zone gives us
// free Universal SSL, apex + www, and a Worker route with no extra product to configure.
//
// Needs CF_API_TOKEN (or CLOUDFLARE_API_TOKEN) with: Zone:Edit, DNS:Edit,
// Workers Routes:Edit, and Account > Zone:Create.

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(path, { method = 'GET', body } = {}) {
  if (!config.cfApiToken) throw new Error('CF_API_TOKEN / CLOUDFLARE_API_TOKEN not set.');
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.cfApiToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const msg = (data.errors || []).map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    const err = new Error(`Cloudflare ${method} ${path} — ${msg}`);
    err.cfErrors = data.errors || [];
    throw err;
  }
  return data.result;
}

const codes = (e) => (e.cfErrors || []).map((x) => x.code);

/** Create the zone, or return the existing one if it's already in the account. */
export async function ensureZone(domain) {
  try {
    const zone = await cf('/zones', {
      method: 'POST',
      body: { name: domain, account: { id: config.cfAccountId }, type: 'full' },
    });
    return { id: zone.id, nameServers: zone.name_servers || [], status: zone.status, created: true };
  } catch (e) {
    // 1061 = zone already exists in this account: adopt it instead of failing the launch.
    if (!codes(e).includes(1061)) throw e;
    const found = await cf(`/zones?name=${encodeURIComponent(domain)}`);
    if (!found?.length) throw e;
    const z = found[0];
    return { id: z.id, nameServers: z.name_servers || [], status: z.status, created: false };
  }
}

/**
 * Proxied placeholder record. The address is never reached — the orange cloud sends the
 * request through Cloudflare, where the Worker route intercepts it. Same trick as the
 * dksites.com wildcard.
 */
export async function addProxiedRecord(zoneId, name) {
  try {
    return await cf(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: { type: 'AAAA', name, content: '100::', proxied: true, ttl: 1 },
    });
  } catch (e) {
    if (codes(e).includes(81057)) return { existing: true, name }; // already there
    throw e;
  }
}

/** Route a hostname pattern at the Worker so it serves this domain. */
export async function addWorkerRoute(zoneId, pattern) {
  try {
    return await cf(`/zones/${zoneId}/workers/routes`, {
      method: 'POST',
      body: { pattern, script: config.workerName },
    });
  } catch (e) {
    if (codes(e).includes(10020)) return { existing: true, pattern }; // duplicate route
    throw e;
  }
}

export async function getZone(zoneId) {
  return cf(`/zones/${zoneId}`);
}

/** Turn a domain into a live, Worker-served, SSL'd site. Returns what happened. */
export async function attachDomainToWorker(domain) {
  const zone = await ensureZone(domain);
  const records = [];
  for (const name of ['@', 'www']) records.push(await addProxiedRecord(zone.id, name));
  const routes = [];
  for (const p of [`${domain}/*`, `www.${domain}/*`]) routes.push(await addWorkerRoute(zone.id, p));
  return { zone, records, routes };
}
