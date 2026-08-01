# Engine update 5 — vision pass, round 2 (activity matching)

Round 1 grouped photos better but still crossed activities (mini golf shots in the driving
range section). Cause: vision was labeling pixels with NO idea what the business does — and
a patch of green grass is genuinely ambiguous without that context.

## Changes (4 files)
- **vision.js** — now receives business CONTEXT (name, type, categories, description, what
  reviewers talk about) and returns an `activity` per photo naming which offering it shows,
  plus a `confidence`. Told explicitly how to tell lookalikes apart (obstacles/props = mini
  golf; distance markers/mats/netting = driving range; screens/projectors = simulator) and
  to return null rather than guess.
- **triage.js** — builds that context from the facts; keeps an activity ONLY at confidence
  >= 0.6, so an unsure label becomes "general" instead of a confident mistake.
- **generate.js** — manifest carries `activity`; placement rules are now strict:
  1. A section about a named activity uses ONLY photos whose activity matches.
  2. If nothing matches, use NO photo — an empty slot beats a wrong image.
  3. Reusing one apt photo beats filling a slot with an unrelated one.
  4. Photos with no activity are for generic use only (hero/ambience), never to illustrate
     a specific offering.
- **pipeline.js** — LOGS EVERY CAPTION so you can see exactly what vision said.

## Apply
dksites-ENGINE Codespace:
    unzip -o engine-update5.zip
    cp -rf engine-update5/. .
    rm -rf engine-update5 engine-update5.zip
    git add -A && git commit -m "Vision pass round 2: business context + activity matching" && git push
Box:
    cd ~/dksites-ENGINE && git pull
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save

## The diagnostic that matters
pm2 logs now print, per photo:
    photo-3: [mini golf] Mini golf hole with windmill obstacle
    photo-5: [general] Green grass, unclear whether range or course
If the captions/activities are RIGHT but images still land wrong -> the generator is
ignoring the rules (prompt problem). If the labels themselves are wrong -> vision needs
better context or the photos are truly ambiguous. Read the log before guessing.
