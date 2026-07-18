# Engine update — deploy-on-generate + facts handoff (Jul 11)

## What changed (2 files)
- **src/pipeline.js** — runPipeline now accepts `opts.facts`: pre-extracted business facts
  from /api/lookup are used directly. No re-extraction, no duplicate Places call, no
  resolving to the wrong business (RIP the Swiss relocation agency).
- **src/api/server.js** — /api/generate reworked:
  - Reads the confirmed facts from the request (business.facts) and hands them to the pipeline.
  - Description-only (greenfield) builds get a safe synthetic facts object.
  - Derives a slug from the business name (Elmer's Place -> elmers-place-…).
  - **Deploys the finished preview to R2** and returns the real https://<slug>.dksites.com/ URL.
  - Includes the trust-proxy line and the nested-path lookup fix (supersedes the box hotfixes).

## How to apply
1) Extract this zip into the **dksites-ENGINE repo root** in your Codespace
   (it only overwrites the two files above):
     unzip -o engine-update.zip
     cp -rf engine-update/. .
     rm -rf engine-update engine-update.zip
2) Commit + push from the Codespace:
     git add src/pipeline.js src/api/server.js
     git commit -m "Deploy-on-generate + facts handoff"
     git push
3) On the Hetzner box (SSH):
     cd ~/dksites-ENGINE
     git pull
     pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save
     pm2 logs dksites-api --lines 3   # confirm origin=https://app.dksites.com, no errors

No Worker redeploy needed. No front-end redeploy needed (the app already sends the facts).

## Test
From app.dksites.com: look up a real business -> confirm -> Build. Watch pm2 logs:
you should see "Using confirmed facts for: <the business>" (NOT "Extracting…"),
then "Publishing your live preview…", and the finished job returns a real
<slug>.dksites.com URL that loads the generated site.
