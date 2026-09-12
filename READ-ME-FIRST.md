# ENGINE ONLY — multi-page menus, existing-site reading, domain connect

`ls` must show run.js and worker/. Two NEW files ship whole; everything else is applied by
a PATCH SCRIPT so all your existing fixes survive. The script is idempotent.

## Apply — dksites-ENGINE Codespace
    unzip -o ENGINE-sep6.zip
    cp -rf ENGINE-sep6/. .
    rm -rf ENGINE-sep6 ENGINE-sep6.zip
    node patch-sep6.mjs
    node --check src/api/server.js && echo OK
    grep -c "trust proxy" src/api/server.js        # must still be 1
    git add -A && git commit -m "Multi-page menus, existing-site reading, domain connect" && git push

## !! THEN PUSH IT TO THE BOX !! Nothing changes until you do.
    cd ~/dksites-ENGINE
    git pull
    node patch-sep6.mjs
    grep -c "domain/inspect" src/api/server.js     # must be 1
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save

## What changed
NEW src/extract/site-reader.js — fetches their existing site, strips it to text, follows
    menu-looking internal links, and hands the text to the menu extractor.
NEW src/launch/walkthroughs.js — click-by-click nameserver instructions for 12 registrars
    plus a generic fallback, written for a business owner.
menu.js      — extractMenuFromFile takes an ARRAY: a two-page menu goes in one request so
               the model merges the pages instead of the second overwriting the first.
               New extractMenuFromText for website content.
pipeline.js  — when facts.identity.website exists and no menu is known, reads the site and
               pulls a real menu from it. Soft-fails; a build never breaks on it.
namecheap.js — setNameservers no longer reports failure when it actually succeeded (the
               thing that aborted the dksitesretro launch after the domain was paid for).
edit.js      — applyEdit accepts menuFilePaths.
server.js    — menu uploads increment (menu-1, menu-2…); apply-edit forwards menuFiles;
               plus /api/domain/inspect, /api/domain/connect and /api/domain/status.

## Test
- Menus: upload one page, then "Add another page", then Apply. Watch pm2 logs for a single
  merged item count rather than two separate extractions.
- Existing site: run a business that has a website. Look for
  "Reading their existing site: …" and "pulled a real menu from their site: N items".
- Domain connect: in the app choose "Use my own", enter a domain you own. It should name
  your registrar and produce the nameservers. NOTE: /connect creates a real Cloudflare
  zone, so use a domain you actually control.
