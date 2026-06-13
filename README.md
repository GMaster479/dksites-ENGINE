# DK Sites — Preview Pipeline

The site-designer engine: scrape a local business's **public** data → triage assets →
make committed brand decisions → generate a bespoke vanilla HTML/CSS/JS site against the
DK Sites rule spec → QA at real breakpoints → serve a preview.

This is the backend pipeline. It runs as a Node service, not as a static site. Run it
locally this weekend; deploy it to a Node host later and point a subdomain at it.

## Pipeline stages

```
run.js
  └─ src/pipeline.js
       1. extract/   Google Places (New) + Yelp + legacy scrape + RDAP registrar  → business_facts
       2. triage/    score photos, flag greenfield, build 2–3 targeted owner asks
       3. analyze/   Anthropic → design_decisions.json (palette, type, tone, signature element)
       4. generate/  Anthropic + rules/generation-spec.md → site files
       5. writer     write files + download assets → previews/<id>/
       6. qa/         Playwright screenshots at 325/375/768/1080/1440/1920 (+ self-correct hook)
```

`src/rules/generation-spec.md` is the product. It encodes the DK house style. Edit it to
tune output — every build reads from it.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in keys

# 1) Offline dry run — no keys, no token spend. Proves the pipeline + rule spec assemble:
node run.js --dry-run --facts data/sample-business.json

# 2) Live build (needs ANTHROPIC_API_KEY + GOOGLE_PLACES_KEY):
node run.js "Cole's Road Brewing, Wallingford CT"

# 3) View the result:
npm run serve               # http://localhost:8787
```

## Keys you need

| Key | Required | Where |
|-----|----------|-------|
| `ANTHROPIC_API_KEY` | yes | console.anthropic.com → Billing (prepaid credits) → API keys |
| `GOOGLE_PLACES_KEY` | yes (live) | Google Cloud Console → enable **Places API (New)** → create key |
| `YELP_API_KEY` | optional | yelp.com/developers (extra gallery photos) |

Model routing defaults: Sonnet for brand + generation, Haiku for cheap triage tasks.
Override in `.env` if you want.

## Notes / extension points (good first jobs for Claude Code)

- **Self-correct loop** (`src/qa/screenshot.js`) is stubbed — wire screenshots back to a
  vision model + the str_replace edit loop to auto-fix layout before a human sees it.
- **Multi-page**: `generate.js` builds the homepage; the generator lists other needed
  pages in `notes`. Loop it per page, sharing the design decisions.
- **Yelp categorized photos** (inside/outside/food) aren't reliably public anymore; the
  client takes what Fusion returns and labels it generically.
- **Production hosting**: the `previews/` folder + `preview-server.js` is the local stand-in
  for an R2 bucket + Cloudflare Worker. Same files, different host.
