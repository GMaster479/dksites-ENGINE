# ENGINE ONLY — add Hostinger (Tony's registrar)

Tony's Central Pizza is on Hostinger, which wasn't in the registrar list, so it fell back
to the generic walkthrough. This adds real hPanel steps.

## Apply — dksites-ENGINE Codespace
    unzip -o ENGINE-hostinger.zip
    cp -rf ENGINE-hostinger/. .
    rm -rf ENGINE-hostinger ENGINE-hostinger.zip
    node patch-hostinger.mjs
    git add -A && git commit -m "Add Hostinger registrar walkthrough" && git push

## !! THEN PUSH IT TO THE BOX !!
    cd ~/dksites-ENGINE
    git pull
    node patch-hostinger.mjs
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save

Then re-run inspect on tonyscentralpizza.com — it should say Hostinger instead of falling back.
