# Engine update — VISION PASS (photo labeling)

## Files (4)
- **src/analyze/vision.js** (NEW) — looks at every photo via Haiku and returns a caption,
  tags, kind, and quality issues per image, plus a hero pick and logo detection.
- **src/triage/triage.js** — runs the pass and merges labels ONTO the photo objects, so a
  caption can never drift onto the wrong file. Promotes a logo found inside the photo set
  to assets.logo (palette anchor) and removes it from the scene photos. Sorts menu boards /
  screenshots / unclear shots to the back. Now async.
- **src/generate/generate.js** — the asset manifest now carries caption/tags/kind/issues and
  recommendedHero, plus an IMAGE PLACEMENT instruction telling the generator that an image
  whose caption contradicts its section is a defect.
- **src/pipeline.js** — awaits triage, logs the photo summary and logo discovery.

## Apply
In the **dksites-ENGINE** Codespace:
    unzip -o engine-update4.zip
    cp -rf engine-update4/. .
    rm -rf engine-update4 engine-update4.zip
    git add -A && git commit -m "Vision pass: label photos before generation" && git push

Then on the box:
    cd ~/dksites-ENGINE && git pull
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save

## Watch for (pm2 logs)
    > Triage: standard - N usable photos - photos labeled by vision
    > Photos: <one-line summary of the whole set>
    > Logo found inside the photo set - using it for the palette.   (when applicable)

## Notes
- Soft failure by design: no key, network trouble, or unparseable output => generation
  proceeds exactly as before with unlabeled photos. It cannot break a build.
- Cost: one Haiku call per generation, ~10 images fetched at 800px (not 4800px).
- Dry runs skip the vision call.
