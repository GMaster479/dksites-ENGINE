# ENGINE ONLY — Hostinger + own-domain pricing ($128.70)

Includes the Hostinger walkthrough (Tony's registrar) and own-domain pricing. Both
patches are idempotent; run them in either order.

## Apply — dksites-ENGINE Codespace
    unzip -o ENGINE-own.zip
    cp -rf ENGINE-own/. .
    rm -rf ENGINE-own ENGINE-own.zip
    node patch-hostinger.mjs
    node patch-owndomain.mjs
    node --check src/api/server.js && echo OK
    grep -c "trust proxy" src/api/server.js       # must still be 1
    git add -A && git commit -m "Hostinger walkthrough + own-domain pricing" && git push

## !! THEN PUSH IT TO THE BOX !!
    cd ~/dksites-ENGINE
    git pull
    node patch-hostinger.mjs
    node patch-owndomain.mjs
    grep -c "ownDomainQuote" src/api/server.js    # must be 3
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save

## Pricing
Own domain = hosting ($99) + 30% service fee = $128.70. No domain line, because there is
nothing to pass through. The quote carries a renewalNote reminding them to keep paying
their own registrar — if the domain lapses the site goes down regardless of hosting.

/api/domain/inspect now returns that quote, and /api/checkout accepts ownDomain:true
(which skips the availability check — the domain being taken is the entire point).
