# Deploying the engine API + webhook to a Hetzner VPS

Goal: one always-on Node service at **api.dksites.com**, with a **fixed IP** whitelisted
in Namecheap. Caddy gives automatic HTTPS. PM2 keeps it running.

## 1. Create the box
Hetzner Cloud → new project → Add Server → Ubuntu 24.04 → CX22 → a US location.
Add your SSH key (or set a root password). Note the server's **IPv4** — this is the IP you
whitelist in Namecheap (Profile → Tools → API Access).

## 2. First login + Node
```bash
ssh root@YOUR_SERVER_IP
apt update && apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs git
node -v
```

## 3. Get the code + install
```bash
git clone https://github.com/GMaster479/dksites-engine.git   # or copy the engine repo
cd dksites-engine
npm install
```

## 4. Secrets (a .env file on the box — never in git)
```bash
nano .env
```
Paste all the keys (ANTHROPIC_API_KEY, GOOGLE_PLACES_KEY, STRIPE_SECRET_KEY,
STRIPE_WEBHOOK_SECRET, NAMECHEAP_*, CLOUDFLARE_API_TOKEN, R2_*, CF_ACCOUNT_ID, CF_ZONE_ID),
plus:
```
APP_ORIGIN=https://app.dksites.com
NAMECHEAP_CLIENT_IP=YOUR_SERVER_IP
LAUNCH_LIVE=false
PORT=8787
```

## 5. Keep it running with PM2
```bash
npm i -g pm2
pm2 start "npm run api" --name dksites-api
pm2 save && pm2 startup   # run the line it prints, to survive reboots
```

## 6. HTTPS + domain with Caddy
```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/...'  # (Caddy install steps — see caddyserver.com/docs/install)
```
Then a one-line Caddyfile reverse-proxying api.dksites.com → localhost:8787:
```
api.dksites.com {
  reverse_proxy localhost:8787
}
```
Point an **A record** for `api.dksites.com` → YOUR_SERVER_IP in Cloudflare DNS
(DNS-only / grey cloud, so Caddy can issue its own cert). Caddy auto-provisions HTTPS.

## 7. Connect the front end
In Cloudflare Pages (the app) → Settings → Environment variables:
```
VITE_ENGINE_URL = https://api.dksites.com
```
Redeploy the app. It now calls the real engine.

## 8. Stripe webhook
Point a Stripe webhook endpoint at `https://api.dksites.com/api/webhook` (or keep using
`stripe listen` while testing). Update STRIPE_WEBHOOK_SECRET to the endpoint's secret.

## Go-live checklist
- [ ] registrant.json filled in (ICANN contact)
- [ ] Cloudflare for SaaS enabled on dksites.com zone + fallback origin → Worker
- [ ] CF_API_TOKEN has custom-hostname edit scope
- [ ] one real throwaway-domain end-to-end test
- [ ] flip LAUNCH_LIVE=true
