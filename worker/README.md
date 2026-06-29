# DK Sites Router Worker

One Worker serves every client site from one R2 bucket, keyed by hostname.

## One-time setup (after dksites.com is Active in Cloudflare)

1. **Create the R2 bucket** (Cloudflare dashboard → R2 → Create bucket): name it
   `dksites-previews` (must match wrangler.toml + R2_BUCKET).

2. **Add the wildcard DNS record** so `*.dksites.com` resolves to Cloudflare's edge:
   dksites.com zone → DNS → Add record → Type `AAAA`, Name `*`, IPv6 `100::`,
   Proxy status **Proxied (orange cloud)**. (A dummy address is fine — the Worker route
   intercepts before it's ever used. The orange cloud is what matters.)

3. **Deploy the Worker**: from this folder, `npx wrangler deploy`. Wrangler will prompt
   you to log in to Cloudflare the first time (browser auth — no token pasting).

4. Visit `https://anything.dksites.com/` — you should get a 404 from the Worker (no site
   uploaded yet), which confirms routing works. The apex `dksites.com` returns the
   "coming soon" placeholder.

## Pushing a site

From the project root: `node run.js --deploy <preview-id> --slug rileys`
→ uploads to `clients/rileys/` in R2 → live at `https://rileys.dksites.com/`.

## Live client domains (later — Cloudflare for SaaS)

When a client goes live on their own domain, you (1) add it as a custom hostname via the
launch flow, and (2) map it to a slug so the Worker serves the right files:
the `mapCustomDomain(host, slug)` helper writes `routes/<host>.json` to R2.
