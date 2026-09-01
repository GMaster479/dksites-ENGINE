# ENGINE ONLY — async apply + build-specific prompts

`ls` must show run.js and worker/. This ships a PATCH SCRIPT, not files, so everything
already on the box (trust proxy, nested lookup, deploy-on-generate, uploads, image
import, prompt cleanup, provided flags) survives untouched.

## Apply — dksites-ENGINE Codespace
    unzip -o ENGINE-async.zip
    cp -rf ENGINE-async/. .
    rm -rf ENGINE-async ENGINE-async.zip
    node patch-ui-round.mjs
    node --check src/api/server.js && echo OK
    grep -c "trust proxy" src/api/server.js      # must still be 1
    git add -A && git commit -m "Async apply-edit + example prompts" && git push

## !! THEN PUSH IT TO THE BOX !!
    cd ~/dksites-ENGINE
    git pull
    node patch-ui-round.mjs
    grep -c "createJob(); // apply-edit" src/api/server.js    # must be 1
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save

## What changed
1. /api/apply-edit now returns a jobId and runs in the background; the app polls
   /api/status/:jobId. A 2-4 minute synchronous request was fragile on mobile — losing
   the tab or signal threw away a rebuild the server had actually finished.
2. apply-edit forwards setPalette / setFonts, so a colour or type pick updates the stored
   decisions. That is the root cause of the stale "in use" panel: the staged editor was
   only ever sending prose, so the CSS changed but the recorded decisions never did.
3. buildEditOptions returns examplePrompts — placeholder text written against THIS build.
