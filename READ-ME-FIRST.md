# ENGINE ONLY — uploads (logo / menu / photos)

`ls` must show run.js and worker/ before you extract. If you see index.html, wrong repo.

## Files
  src/analyze/image-block.js  (NEW) shared image loader — handles URLs *and* local uploads
  src/analyze/brand.js        uses it, so an uploaded logo anchors the palette
  src/analyze/vision.js       uses it, so uploaded photos get captioned too
  src/edit/edit.js            applyEdit accepts logoFile / menuFilePath / photoFiles
  src/generate/generate.js    manifest points at uploaded files by their real path
  src/generate/writer.js      never re-downloads an uploaded file; index alignment fixed
  patch-server.mjs            PATCHES src/api/server.js in place (does NOT replace it)

## Why a patch script for server.js
Your server.js has fixes I don't have a clean copy of (trust proxy, nested lookup paths,
deploy-on-generate, redeploy-on-edit). Overwriting it would undo them — that is exactly the
regression that bit us on July 4. The script only adds what's new and is safe to run twice.

## Apply — dksites-ENGINE Codespace
    ls                                   # run.js and worker/ must be here
    unzip -o ENGINE-uploads.zip
    cp -rf ENGINE-uploads/. .
    rm -rf ENGINE-uploads ENGINE-uploads.zip
    node patch-server.mjs                # must print "patched src/api/server.js"
    grep -c "api/upload" src/api/server.js          # must print 1
    grep -c "trust proxy" src/api/server.js         # must STILL print 1 (fix preserved)
    node --check src/api/server.js && echo OK
    git add -A && git commit -m "Uploads: logo, menu, photos" && git push

## !! THEN PUSH IT TO THE BOX !! Nothing changes until you do.
    cd ~/dksites-ENGINE
    git pull
    node patch-server.mjs                # the patch runs on the box's own file
    grep -c "api/upload" src/api/server.js          # MUST print 1
    grep -c "trust proxy" src/api/server.js         # MUST print 1
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save

(No npm install needed — uploads are base64 JSON, no new dependency.)

## What it does
- Logo upload -> becomes assets.logo, brand is RE-ANALYZED, palette rebuilt from the real
  logo. This is the fix for the Retro Subs palette.
- Menu upload -> knownMenu, placeholders replaced (existing path, now reachable).
- Photo upload -> captioned by the vision pass and added to the ranked set, so the
  generator places them by what they show.
- Uploads land inside the preview's images/ dir, so they are never re-fetched and deploy
  to R2 with the site.
