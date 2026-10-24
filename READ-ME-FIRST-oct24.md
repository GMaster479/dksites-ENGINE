# ENGINE — Oct 24: edits change only what was asked

1. Edits no longer rebuild the site. The current files get small find/replace patches for
   exactly what was asked; everything else stays byte-for-byte. If a patch can't be applied
   cleanly, NOTHING changes and the owner is told (src/edit/inplace.js).
2. Every typed change is saved as a standing request and sent with every later edit, so
   nothing gets undone. Owners can undo one from the editor. Color/font picks are settings.
3. Short/vague requests make the smallest change. A full redesign only on an explicit ask
   ("Start over with a fresh design", or "redesign"/"start over" wording).
4. An uploaded logo no longer restyles the site; its colors are OFFERED ("Match my logo").
5. FIX: the pipeline ignored the business confirmed in the app and looked it up again
   (description-only builds searched Google with the description). It now uses it as-is.
6. Starting uploads (logo/outside/inside/more) and social links -> footer icons + JSON-LD sameAs.
7. DELETE /api/builds/:id (owner only; paid sites refused), GET /api/socials.
8. Security: preview ids validated before touching disk; uploads rate-limited.

server.js is patched in place by patch-oct24.mjs (safe to run twice). No new .env lines.

## Codespace (dksites-ENGINE)

    unzip -o ENGINE-oct24.zip
    node patch-oct24.mjs
    node --check src/api/server.js && echo OK
    git add -A && git commit -m "Oct 24: in-place edits, standing requests, uploads + socials, delete preview" && git push

## Box

    cd ~/dksites-ENGINE && git pull
    node patch-oct24.mjs                              # should say "Nothing to do."
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save
    curl -s https://api.dksites.com/health            # {"ok":true}
