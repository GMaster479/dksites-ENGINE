# ENGINE — Nov 8

1. Own-domain connect keeps their EMAIL working. Before creating the Cloudflare zone, the
   engine reads the domain's current DNS (MX, SPF/verification TXT, DMARC, DKIM keys, Outlook/
   Teams records, mail hosts, and common service subdomains like shop./order./booking.) and
   copies them into the new zone. The app shows the owner what was found and copied. If the
   DNS couldn't be read, the app tells them to text you before switching.
   (src/launch/dns-copy.js, src/launch/cloudflare.js)
2. Preview addresses are unique. A new preview can no longer land on — and overwrite — a paid
   live site with the same business name. Reserved names (www, app, api, dksites-home…) are
   never given out.
3. "Hosting, SSL & email" -> "Hosting, SSL & site editing". Nothing sets up email inboxes,
   so we stop saying it's included.
4. src/api/renewals.js — the Oct 10 version (CT cancellation instructions) was committed to
   the repo ROOT by mistake and never went live. This puts it where the engine loads it.
5. dksites.com homepage: site/home/ + publish-home.mjs + Worker change (worker/).

## Codespace (dksites-ENGINE)

    unzip -o ENGINE-nov8.zip
    node patch-nov8.mjs
    node --check src/api/server.js && echo OK
    git rm -q -r renewals.js ENGINE-async.zip ENGINE-oct10.zip ENGINE-oct24.zip engine-update5
    git add -A && git commit -m "Nov 8: keep email on domain connect, unique slugs, homepage, renewals fix" && git push

    cd worker && npx wrangler deploy && cd ..       # Worker: dksites.com homepage support

## Box

    cd ~/dksites-ENGINE && git pull
    node patch-nov8.mjs                              # should say "Nothing to do."
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save
    curl -s https://api.dksites.com/health
    node publish-home.mjs                            # homepage preview -> https://dksites-home.dksites.com
