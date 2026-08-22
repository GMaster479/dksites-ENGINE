// Pre-flight: proves every credential and permission the LIVE launch needs, WITHOUT
// spending a cent or registering anything. Run this before flipping LAUNCH_LIVE.
//
//   node preflight.mjs
//
import { config } from './src/config.js';
import { checkAvailability, getRegisterPrice, tldOf } from './src/launch/namecheap.js';
import { getRegistrant } from './src/launch/registrant.js';

const ok = (m) => console.log('  ✓', m);
const bad = (m) => { console.log('  ✗', m); failures++; };
let failures = 0;

console.log('\nDK Sites — launch pre-flight\n');

console.log('1. Registrant (ICANN contact)');
try {
  const r = getRegistrant();
  const missing = ['firstName','lastName','address1','city','state','postalCode','country','phone','email']
    .filter((k) => !r[k]);
  if (missing.length) bad(`registrant.json missing: ${missing.join(', ')}`);
  else if (!/^\+\d+\.\d{7,}$/.test(r.phone)) bad(`phone must look like +1.8601234567 (got "${r.phone}")`);
  else ok(`registrant.json complete (${r.firstName} ${r.lastName}, ${r.city} ${r.state})`);
} catch (e) { bad(e.message); }

console.log('\n2. Namecheap');
if (!config.ncApiUser || !config.ncApiKey) bad('NAMECHEAP_API_USER / NAMECHEAP_API_KEY not set');
else if (!config.ncClientIp) bad('NAMECHEAP_CLIENT_IP not set');
else {
  try {
    const a = await checkAvailability('dksites.com');
    ok(`API reachable and IP ${config.ncClientIp} is whitelisted`);
    const p = await getRegisterPrice('com');
    p.estimated ? bad('could not read real .com pricing (checkout would refuse)')
                : ok(`live pricing works (.com = $${p.price} / ${p.years}yr)`);
  } catch (e) { bad(`Namecheap: ${e.message}`); }
}

console.log('\n3. Cloudflare token + permissions');
if (!config.cfApiToken) bad('CF_API_TOKEN / CLOUDFLARE_API_TOKEN not set');
else {
  const H = { Authorization: `Bearer ${config.cfApiToken}` };
  try {
    const v = await (await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: H })).json();
    v.success ? ok('token is valid and active') : bad('token failed verification');
  } catch (e) { bad(`token verify: ${e.message}`); }

  try {
    const z = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}`, { headers: H })).json();
    z.success ? ok(`can read the dksites.com zone (${z.result.name})`) : bad('cannot read the zone — needs Zone:Read');
  } catch (e) { bad(`zone read: ${e.message}`); }

  // Zone:Create is the one that only shows up at launch time — probe it safely with a
  // deliberately invalid name. Permission errors and validation errors look different.
  try {
    const r = await (await fetch('https://api.cloudflare.com/client/v4/zones', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', account: { id: config.cfAccountId } }),
    })).json();
    const cs = (r.errors || []).map((e) => e.code);
    if (cs.includes(9109) || cs.includes(10000)) bad('token CANNOT create zones — add Account > Zone:Create');
    else ok('token appears able to create zones');
  } catch (e) { bad(`zone create probe: ${e.message}`); }

  try {
    const w = await (await fetch(`https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/workers/routes`, { headers: H })).json();
    w.success ? ok('can read Worker routes (Workers Routes scope present)') : bad('cannot read Worker routes — add Workers Routes:Edit');
  } catch (e) { bad(`worker routes: ${e.message}`); }
}

console.log('\n4. Flags');
console.log(`  LAUNCH_LIVE = ${config.launchLive}${config.launchLive ? '  ⚠ REAL registrations will happen' : '  (safe)'}`);
console.log(`  Worker name = ${config.workerName}`);

console.log(failures ? `\n✗ ${failures} problem(s) — fix before going live.\n` : '\n✓ All pre-flight checks passed. Safe to flip LAUNCH_LIVE=true.\n');
process.exit(failures ? 1 : 0);
