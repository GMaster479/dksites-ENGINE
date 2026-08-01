# Engine update 6 — photo label contact sheet (diagnostic)

## What this is
One file changed (src/generate/writer.js). Every build now also writes `_labels.html` into
the preview and deploys it with the site. Open:

    https://<slug>.dksites.com/_labels.html

You get a grid of every downloaded photo (the exact images/photo-N.webp the generator was
given) with, beside each: the activity + confidence, the caption, the kind, hero flags, and
any quality issues. Page is noindex.

## Why
It answers the only question that matters right now, visually and in seconds:

- Labels look CORRECT but the site still puts them in the wrong sections
    -> the generator is ignoring the placement rules. Fix = prompt/spec enforcement.
- Labels are WRONG (a range photo labeled "mini golf")
    -> vision is mis-seeing. Fix = better context, a stronger model for this pass, or
       accepting that some photos are genuinely ambiguous and must fall back to "general".

Until we know which, any further change is guesswork.

## Apply
dksites-ENGINE Codespace:
    unzip -o engine-update6.zip
    cp -rf engine-update6/. .
    rm -rf engine-update6 engine-update6.zip
    git add -A && git commit -m "Photo label contact sheet for diagnosis" && git push
Box:
    cd ~/dksites-ENGINE && git pull
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api && pm2 save

Then rebuild Great Brook and open /_labels.html on the new preview.
