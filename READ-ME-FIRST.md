# ENGINE ONLY — placement rebalance (1 file: src/generate/generate.js)

Vision labels are accurate now. This fixes the OTHER direction: the rules were too strict,
so good photos went unused (batting cages, pro shop) and the exterior shot never made it
into "Visit Us".

## What changed
The IMAGE PLACEMENT rules now treat two failures as equally bad: a photo that contradicts
its section, AND a good photo left on the table.
  - MATCH kept strict (no mini-golf shots in the driving-range section).
  - COVER added: use every usable photo at least once; a good photo of an offering means
    that offering deserves a section — let the photo set shape what the site covers.
  - EXTERIOR/storefront shots explicitly belong with location / hours / Visit Us / the map.
  - Removed "an empty slot beats a wrong image"; now: no matching photo -> illustrative SVG,
    signature element, or type-led layout (the self-drawn simulator SVG was the right call
    and this keeps that behavior).

## Apply — dksites-ENGINE Codespace (ls must show run.js and worker/)
    unzip -o ENGINE-coverage.zip
    cp -rf ENGINE-coverage/. .
    rm -rf ENGINE-coverage ENGINE-coverage.zip
    grep -c "COVER" src/generate/generate.js        # must print 1+
    git add -A && git commit -m "Rebalance image placement: match + coverage" && git push

## !! THEN PUSH IT TO THE BOX !! (nothing changes until you do)
    cd ~/dksites-ENGINE
    git pull
    grep -c "COVER" src/generate/generate.js        # MUST print 1+ before continuing
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save
