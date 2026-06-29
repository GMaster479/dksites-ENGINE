import { readFileSync, existsSync } from 'node:fs';

// ICANN requires real registrant contact details on every domain. Store them in
// registrant.json (gitignored) — copy registrant.example.json and fill in DK Sites LLC.
// Only read at actual registration time (live launches), never during dry-runs.

let cached = null;

export function getRegistrant() {
  if (cached) return cached;
  if (!existsSync('registrant.json')) {
    throw new Error(
      'registrant.json not found. Copy registrant.example.json to registrant.json and fill in ' +
        'your DK Sites LLC contact — ICANN requires it for domain registration.'
    );
  }
  cached = JSON.parse(readFileSync('registrant.json', 'utf8'));
  return cached;
}

/** Expand one contact into Namecheap's four required contact roles. */
export function contactParams(c = getRegistrant()) {
  const fields = {
    FirstName: c.firstName, LastName: c.lastName, Address1: c.address1,
    City: c.city, StateProvince: c.state, PostalCode: c.postalCode,
    Country: c.country, Phone: c.phone, EmailAddress: c.email,
  };
  const out = {};
  for (const role of ['Registrant', 'Tech', 'Admin', 'AuxBilling']) {
    for (const [k, v] of Object.entries(fields)) out[`${role}${k}`] = v;
  }
  return out;
}
