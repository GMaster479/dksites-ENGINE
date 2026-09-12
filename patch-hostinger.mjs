// Adds Hostinger to the registrar detector. Idempotent.
import { readFile, writeFile } from 'node:fs/promises';
const F = 'src/extract/whois.js';
let s = await readFile(F, 'utf8');
if (s.includes("'hostinger'")) { console.log('-- whois.js: Hostinger already mapped'); process.exit(0); }
if (!s.includes("[/porkbun/i, 'porkbun'],")) { console.error('x whois.js: registrar list not in the expected shape'); process.exit(1); }
s = s.replace("[/porkbun/i, 'porkbun'],", "[/porkbun/i, 'porkbun'],\n  [/hostinger/i, 'hostinger'],");
await writeFile(F, s);
console.log('OK whois.js: Hostinger mapped to its walkthrough');
