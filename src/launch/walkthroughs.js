// Registrar-specific instructions for pointing an EXISTING domain at us.
//
// Most prospects already own a domain and a bad site — this is the path that matters
// commercially. We change nameservers rather than individual records: it's one setting,
// it works for apex and www together, and it hands us full DNS control so SSL and any
// later changes are ours to make.
//
// Written for a business owner, not a developer: exact menu names, in order, no jargon.

const NS_NOTE =
  'Replace BOTH existing nameservers with the two below. Remove any others — leaving an ' +
  'old one in place will make your site load inconsistently.';

export const WALKTHROUGHS = {
  godaddy: {
    registrar: 'GoDaddy',
    steps: [
      'Sign in at godaddy.com and open "My Products".',
      'Find your domain and click "DNS" next to it.',
      'Scroll to the "Nameservers" section and click "Change".',
      'Choose "Enter my own nameservers (custom)".',
      'Replace what\'s there with the two nameservers below, then Save.',
      'GoDaddy will warn you this changes where your site lives — that\'s expected. Confirm.',
    ],
  },
  namecheap: {
    registrar: 'Namecheap',
    steps: [
      'Sign in at namecheap.com and open "Domain List".',
      'Click "Manage" next to your domain.',
      'Find the "Nameservers" dropdown and choose "Custom DNS".',
      'Enter the two nameservers below, then click the green checkmark to save.',
    ],
  },
  bluehost: {
    registrar: 'Bluehost',
    steps: [
      'Sign in at bluehost.com and go to "Domains".',
      'Select your domain, then open the "DNS" or "Name Servers" tab.',
      'Click "Edit" next to Name Servers and choose "Custom".',
      'Enter the two nameservers below and save.',
    ],
  },
  networksolutions: {
    registrar: 'Network Solutions',
    steps: [
      'Sign in at networksolutions.com and open "My Domain Names".',
      'Click your domain, then "Manage Advanced DNS Records" / "Change Where Domain Points".',
      'Choose the option to use custom nameservers.',
      'Enter the two nameservers below and save.',
    ],
    note: 'Network Solutions\' layout changes often — if you can\'t find it, look for anything labelled "Name Servers" or "Domain Host".',
  },
  squarespace: {
    registrar: 'Squarespace Domains (formerly Google Domains)',
    steps: [
      'Sign in at account.squarespace.com and open "Domains".',
      'Click your domain, then "DNS" → "DNS Settings".',
      'Find "Nameservers" and switch from Squarespace defaults to custom.',
      'Enter the two nameservers below and save.',
    ],
  },
  cloudflare: {
    registrar: 'Cloudflare',
    steps: [
      'Your domain is already at Cloudflare, which makes this easy.',
      "Tell me and I'll send you an invitation to move the domain into our account — no nameserver change needed on your end.",
    ],
    note: 'Cloudflare-registered domains have to stay on Cloudflare nameservers, so we handle this one differently. It usually takes a day.',
    special: 'cloudflare-to-cloudflare',
  },
  namecom: {
    registrar: 'Name.com',
    steps: [
      'Sign in at name.com and open "My Domains".',
      'Click your domain, then "Nameservers" in the left menu.',
      'Remove the existing entries, add the two below, and save.',
    ],
  },
  hover: {
    registrar: 'Hover',
    steps: [
      'Sign in at hover.com and open your domain list.',
      'Click your domain, then the "Nameservers" tab.',
      'Click "Edit", replace both entries with the two below, and save.',
    ],
  },
  wix: {
    registrar: 'Wix',
    steps: [
      'Sign in at wix.com and go to "Domains" in your account.',
      'Click the three dots next to your domain → "Manage DNS".',
      'Look for "Nameservers" and switch to "Use external nameservers".',
      'Enter the two below and save.',
    ],
    note: 'If your old Wix site is still published it will stop being visible once this takes effect — which is the point, since your new site replaces it.',
  },
  hostgator: {
    registrar: 'HostGator',
    steps: [
      'Sign in to your HostGator Customer Portal and open "Domains".',
      'Select your domain and find "Nameservers".',
      'Click "Change", choose custom, enter the two below, and save.',
    ],
  },
  ionos: {
    registrar: 'IONOS',
    steps: [
      'Sign in at ionos.com and open "Domains & SSL".',
      'Click the gear icon next to your domain → "Nameserver".',
      'Choose "Use custom nameservers", enter the two below, and save.',
    ],
  },
  porkbun: {
    registrar: 'Porkbun',
    steps: [
      'Sign in at porkbun.com and open "Domain Management".',
      'Click "Details" on your domain, then find "Authoritative Nameservers" and click "Edit".',
      'Replace the entries with the two below and save.',
    ],
  },
  generic: {
    registrar: 'your domain provider',
    steps: [
      'Sign in wherever you bought your domain.',
      'Find your domain\'s settings — look for "DNS", "Nameservers", or "Domain Host".',
      'Choose the option for custom or external nameservers.',
      'Replace the existing entries with the two below and save.',
    ],
    note: "If you can't find it, send me a screenshot of your domain settings and I'll point you to the right spot.",
  },
};

export function getWalkthrough(key = 'generic', nameservers = []) {
  const w = WALKTHROUGHS[key] || WALKTHROUGHS.generic;
  return {
    key: WALKTHROUGHS[key] ? key : 'generic',
    ...w,
    nameservers,
    nameserverNote: NS_NOTE,
    propagation:
      'Changes usually take 15 minutes to a couple of hours, occasionally up to a day. ' +
      'Your current site stays up the whole time — nothing goes dark.',
  };
}
