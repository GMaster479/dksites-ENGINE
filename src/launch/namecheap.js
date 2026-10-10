import * as cheerio from 'cheerio';
import { config } from '../config.js';

// Namecheap API client. Phase 1/2 use only FREE, non-destructive calls:
//   - domains.check    (is the domain available?)
//   - users.getPricing (real registration cost + minimum term)
// Registration (domains.create) is Phase 3, guarded behind an explicit flag.
//
// Namecheap only answers from a WHITELISTED IP. Set NAMECHEAP_CLIENT_IP to the Codespace's
// current public IP (curl ifconfig.me) and whitelist it in the NC dashboard.

const NC_BASE = 'https://api.namecheap.com/xml.response';
const MIN_PLAUSIBLE_PRICE = 1; // a parsed price below this means a parse error, not a real deal

function params(command, extra = {}) {
  return new URLSearchParams({
    ApiUser: config.ncApiUser, ApiKey: config.ncApiKey, UserName: config.ncUserName,
    ClientIp: config.ncClientIp, Command: command, ...extra,
  });
}

function normalize(xml) {
  return xml.replace(/xmlns="[^"]*"/g, ''); // drop default namespace so selectors are clean
}

function ensureOk($, command) {
  const status = $('ApiResponse').attr('Status');
  if (status && status.toUpperCase() === 'OK') return;
  const err = $('Error').first().text() || $('Errors').first().text() || 'Unknown Namecheap error';
  throw new Error(`Namecheap ${command} failed: ${err.trim()}`);
}

async function call(command, extra) {
  if (!config.ncApiUser || !config.ncApiKey || !config.ncClientIp) {
    throw new Error('Namecheap needs NAMECHEAP_API_USER, NAMECHEAP_API_KEY, and NAMECHEAP_CLIENT_IP (whitelisted IP).');
  }
  const res = await fetch(`${NC_BASE}?${params(command, extra)}`);
  return res.text(); // raw XML — parsed by the pure functions below
}

// ---- Pure parsers (unit-testable without network) ----

export function parseAvailability(xml) {
  const $ = cheerio.load(normalize(xml), { xmlMode: true });
  ensureOk($, 'domains.check');
  const el = $('DomainCheckResult').first();
  return {
    domain: el.attr('Domain'),
    available: (el.attr('Available') || '').toLowerCase() === 'true',
    premium: (el.attr('IsPremiumName') || '').toLowerCase() === 'true',
    premiumPrice: parseFloat(el.attr('PremiumRegistrationPrice') || '0') || 0,
  };
}

/**
 * Returns the LOWEST-duration register price for the TLD: { years, price } | null.
 * Critically, it only reads the "register" category — the response also carries renew,
 * transfer, reactivate, and redemption prices, which must never be quoted as registration.
 * Some TLDs (e.g. .ai) have no 1-year term, so we take the minimum offered duration.
 */
export function parseRegisterPrice(xml) {
  const $ = cheerio.load(normalize(xml), { xmlMode: true });
  ensureOk($, 'users.getPricing');
  let best = null;
  $('ProductCategory').each((_, cat) => {
    if (($(cat).attr('Name') || '').toLowerCase() !== 'register') return;
    $(cat).find('Price').each((_, node) => {
      const el = $(node);
      const years = parseInt(el.attr('Duration') || '', 10);
      const v = parseFloat(el.attr('YourPrice') || el.attr('Price') || el.attr('RegularPrice') || '');
      if (!Number.isNaN(years) && !Number.isNaN(v) && (best == null || years < best.years)) {
        best = { years, price: v };
      }
    });
  });
  return best;
}

// ---- Network calls ----

export async function checkAvailability(domain) {
  const xml = await call('namecheap.domains.check', { DomainList: domain });
  return { ...parseAvailability(xml), domain };
}

/**
 * Real register price for a TLD. Returns { price, years, estimated }.
 * estimated:true means we could NOT verify a real price — checkout must refuse on it,
 * because charging an estimated-low price on a premium TLD (.ai is $89.98, not $13.98)
 * would lose money on every sale.
 */
export async function getRegisterPrice(tld) {
  try {
    const xml = await call('namecheap.users.getPricing', {
      ProductType: 'DOMAIN', ProductCategory: 'REGISTER', ProductName: tld,
    });
    const best = parseRegisterPrice(xml);
    if (!best || best.price < MIN_PLAUSIBLE_PRICE) {
      return { price: config.ncDefaultDomainPrice, years: 1, estimated: true };
    }
    return { price: best.price, years: best.years, estimated: false };
  } catch {
    return { price: config.ncDefaultDomainPrice, years: 1, estimated: true };
  }
}

export function tldOf(domain) {
  return domain.split('.').slice(1).join('.');
}

// ---- Phase 3: registration (LIVE only — real money, irreversible) ----
import { contactParams } from './registrant.js';

export async function registerDomain(domain, years = 1) {
  const xml = await call('namecheap.domains.create', {
    DomainName: domain,
    Years: String(years),
    AddFreeWhoisguard: 'yes',
    WGEnabled: 'yes',
    ...contactParams(),
  });
  const $ = cheerio.load(normalize(xml), { xmlMode: true });
  ensureOk($, 'domains.create');
  const r = $('DomainCreateResult').first();
  return {
    domain,
    registered: (r.attr('Registered') || '').toLowerCase() === 'true',
    charged: parseFloat(r.attr('ChargedAmount') || '') || null,
  };
}

// ---- Nameservers: set, then VERIFY by reading them back ----
//
// The old check trusted a flag in Namecheap's setCustom response. That flag is unreliable
// (missing, renamed, or "false" on a change that applied fine), which produced the
// "Nameservers were not accepted" error on launches that had actually worked. And right
// after domains.create, setCustom can briefly fail because the new domain isn't fully
// provisioned yet. So now we: retry the set a few times, then read the nameservers back
// with domains.dns.getList and compare. What Namecheap REPORTS it has is the truth.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normNs = (list) => [...new Set((list || []).map((n) => String(n).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))].sort();

/** Pure parser for domains.dns.getList. */
export function parseDnsList(xml) {
  const $ = cheerio.load(normalize(xml), { xmlMode: true });
  ensureOk($, 'domains.dns.getList');
  const r = $('DomainDNSGetListResult').first();
  const nameservers = [];
  r.find('Nameserver').each((_, n) => nameservers.push($(n).text()));
  return {
    usingNamecheapDns: (r.attr('IsUsingOurDNS') || '').toLowerCase() === 'true',
    nameservers: normNs(nameservers),
  };
}

/** True when every nameserver we asked for is what the registrar now has (order-free). */
export function nameserversMatch(want, have) {
  const a = normNs(want), b = normNs(have);
  return a.length > 0 && a.length === b.length && a.every((n, i) => n === b[i]);
}

function splitDomain(domain) {
  const [sld, ...rest] = domain.split('.');
  return { SLD: sld, TLD: rest.join('.') };
}

export async function getNameservers(domain) {
  const xml = await call('namecheap.domains.dns.getList', splitDomain(domain));
  return parseDnsList(xml);
}

/**
 * Point a domain at Cloudflare's nameservers and confirm it took.
 * Returns { updated, verified, nameservers, current, attempts, lastError }.
 *   verified: true  -> Namecheap reports exactly our nameservers. Done.
 *   verified: false -> could not confirm. The caller flags it for a human; it is NOT
 *                      treated as a failed launch (the domain is already paid for).
 */
export async function setNameservers(domain, nameservers = [], { attempts = 4, waitMs = 8000 } = {}) {
  if (!nameservers.length) throw new Error('No nameservers to set.');
  let lastError = null;
  let current = [];

  for (let i = 1; i <= attempts; i++) {
    // Already pointed (e.g. a retried launch, or an earlier attempt that "failed" but applied)?
    try {
      const now = await getNameservers(domain);
      current = now.nameservers;
      if (nameserversMatch(nameservers, current)) {
        return { domain, updated: true, verified: true, nameservers, current, attempts: i, lastError };
      }
    } catch (e) { lastError = e.message; }

    try {
      const xml = await call('namecheap.domains.dns.setCustom', { ...splitDomain(domain), Nameservers: nameservers.join(',') });
      const $ = cheerio.load(normalize(xml), { xmlMode: true });
      ensureOk($, 'domains.dns.setCustom');
    } catch (e) { lastError = e.message; }

    // Read back. Namecheap applies setCustom synchronously when it accepts it.
    try {
      const after = await getNameservers(domain);
      current = after.nameservers;
      if (nameserversMatch(nameservers, current)) {
        return { domain, updated: true, verified: true, nameservers, current, attempts: i, lastError: null };
      }
    } catch (e) { lastError = e.message; }

    if (i < attempts) await sleep(waitMs * i); // 8s, 16s, 24s — new registrations settle fast
  }
  return { domain, updated: false, verified: false, nameservers, current, attempts, lastError };
}
