# DK Sites Engine API

The HTTP layer that connects app.dksites.com to the pipeline. Runs as one always-on
Node process on the VPS, alongside the Stripe webhook (same process, same static IP that
Namecheap whitelists).

## Endpoints
- `POST /api/lookup`            `{name, city}` → business candidate (+ facts)
- `POST /api/generate`          `{mode, business|description}` → `{jobId}` (async)
- `GET  /api/status/:jobId`     → `{status, stage, progress, result}` (poll this)
- `GET  /api/edit-options/:previewId` → zones A+B options
- `POST /api/apply-edit`        `{previewId, instruction}` → `{version, url}`
- `GET  /api/check?domain=`     → availability + verified quote
- `POST /api/checkout`          `{domain, slug, previewId}` → `{url}`
- `POST /api/webhook`           Stripe (raw body, signature-verified)
- `GET  /health`                → `{ok:true}`

## Run locally
```bash
npm install
APP_ORIGIN=http://localhost:5173 npm run api   # serves on :8787
```

## Known limitation (next build)
`/api/generate` currently re-extracts from the business name via `runPipeline(query)`.
For the "existing business" path we already have full facts from `/api/lookup`; piping
those straight into generation (instead of re-extracting) is a small `runPipeline`
refactor to accept facts directly — faster and avoids a duplicate Places call. Greenfield
(description-based) works as-is.

## Deploy (VPS) — see DEPLOY-VPS.md
