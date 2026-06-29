import { config } from '../config.js';

// Cloudflare for SaaS: attach a client's live domain as a custom hostname on the
// dksites.com zone so the Worker serves it, and Cloudflare issues its SSL cert.
// Requires CF_API_TOKEN with custom-hostname edit scope, and "Cloudflare for SaaS"
// enabled on the zone with a fallback origin pointing at the Worker.

const CF_API = 'https://api.cloudflare.com/client/v4';

async function cf(path, { method = 'GET', body } = {}) {
  if (!config.cfApiToken) throw new Error('CF_API_TOKEN not set (needs custom-hostname scope).');
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.cfApiToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}

export async function createCustomHostname(hostname) {
  return cf(`/zones/${config.cfZoneId}/custom_hostnames`, {
    method: 'POST',
    body: { hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } },
  });
}

export async function getCustomHostname(id) {
  return cf(`/zones/${config.cfZoneId}/custom_hostnames/${id}`);
}
