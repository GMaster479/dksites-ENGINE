# ENGINE — Oct 10 fixes

1. Real launch progress — each launch step is saved as it happens; the app's Launching
   screen shows it (it used to be a timer). Failed launches email ADMIN_EMAILS, and the
   admin page has Retry (never re-buys a domain) and Mark done.
2. Auto-renew switch — POST /api/sites/:id/auto-renew. Off = instant. On = instant if a
   card is saved, otherwise Stripe saves one (no charge) and the webhook turns it on.
3. Nightly DB backup — ~3:30 AM Eastern to R2 at backups/db/YYYY-MM-DD.sqlite.gz.
   30 days kept in R2, 3 on the box (db/backups/). Admin page: last backup + Back up now.
4. "Nameservers were not accepted" — now retries, then READS the nameservers back from
   Namecheap to confirm. If it still can't confirm, the launch finishes as
   "needs attention" (you get an email with the exact nameservers) instead of failing.

New whole files: src/api/launches.js, autorenew.js, backup.js
Replaced whole:  src/api/db.js (adds columns on boot, safely), src/api/accounts.js,
                 src/launch/launch.js, src/launch/namecheap.js
server.js is patched in place by patch-oct10.mjs (safe to run twice). No new .env lines.

## Codespace (dksites-ENGINE)

    unzip -o ENGINE-oct10.zip
    node patch-oct10.mjs
    node --check src/api/server.js && echo OK
    git add -A && git commit -m "Oct 10: launch progress, auto-renew switch, DB backups, nameserver fix" && git push

## Box

    cd ~/dksites-ENGINE && git pull
    node patch-oct10.mjs                              # should say "Nothing to do."
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save
    curl -s https://api.dksites.com/health            # {"ok":true}

Wait 2 minutes, then:

    pm2 logs dksites-api --lines 30 --nostream | grep -i backup
    # want: 💾 DB backup backups/db/2026-10-10.sqlite.gz (...) -> R2 dksites-previews

## Restoring a backup (only if the box is ever lost)

Download the newest backups/db/*.sqlite.gz from R2 (Cloudflare → R2 → dksites-previews),
then on the new box: gunzip it, rename it dksites.sqlite, put it at ~/dksites-ENGINE/db/,
and start pm2.
