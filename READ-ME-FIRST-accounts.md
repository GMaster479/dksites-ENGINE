# ENGINE — Accounts (Oct 3)

New files (shipped whole — they didn't exist before):
- src/api/db.js — the database (one file on the box: db/dksites.sqlite, never committed)
- src/api/mailer.js — sign-in links + renewal emails through Resend
- src/api/accounts.js — sign-in (email link + Google), sessions, ownership, dashboard, admin
- src/api/renewals.js — 30-day and 7-day renewal emails with the custom-build upgrade offer
- patch-accounts.mjs — wires all of the above into server.js / stripe.js WITHOUT replacing them

server.js and stripe.js are NOT in this zip. The patch edits them in place, so every earlier
fix survives. It's safe to run twice.

What the patch changes:
1. CORS sends cookies (needed for the sign-in session)
2. Accounts mounted before every route (checkout now requires sign-in; a claimed preview can
   only be edited by its owner or an admin)
3. Stripe webhook records each purchase (paid date, renewal date, auto-renew choice)
4. Own-domain purchases no longer try to REGISTER the domain (that was a bug)
5. Checkout: Stripe customer record, prefilled email, auto-renew OPT-IN (saves the card
   only when checked), and success/cancel return to app.dksites.com (they pointed at
   localhost before)

## Codespace (dksites-ENGINE)

    unzip -o ENGINE-accounts.zip
    grep -c "trust proxy" src/api/server.js          # must print 1 — if 0, STOP and tell Claude
    node patch-accounts.mjs
    node --check src/api/server.js && node --check src/launch/stripe.js && echo OK
    git add -A && git commit -m "Accounts: sign-in, dashboard, admin, renewal reminders" && git push

## Box

    cd ~/dksites-ENGINE && git pull
    node patch-accounts.mjs                          # should say "Nothing to do."
    grep -c "mountAccounts" src/api/server.js        # must print 1 or more
    pm2 delete dksites-api && pm2 start "npm run api" --name dksites-api --cwd ~/dksites-ENGINE && pm2 save
    curl -s https://api.dksites.com/api/auth/me      # {"user":null,"googleClientId":...}

New .env lines on the box (nano ~/dksites-ENGINE/.env), then pm2 delete/start again:

    ADMIN_EMAILS=you@example.com,other@example.com
    API_BASE_URL=https://api.dksites.com
    COOKIE_DOMAIN=.dksites.com
    EMAIL_FROM="DK Sites <hello@dksites.com>"
    EMAIL_REPLY_TO=dylan@dksitesllc.com
    RESEND_API_KEY=re_...            # until set, sign-in emails print to: pm2 logs dksites-api
    GOOGLE_CLIENT_ID=....apps.googleusercontent.com
    UPGRADE_BASE_PRICE=750           # optional; custom-build price used in renewal emails
