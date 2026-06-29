import express from 'express';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';

// Serves generated previews locally at /<id>/.  In production this role is the
// Cloudflare Worker reading from R2 — same files, different host.

const app = express();

// noindex everything in preview (drafts must never hit Google)
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use(express.static(config.previewDir, { extensions: ['html'] }));

// Branded index listing all previews.
app.get('/', async (_req, res) => {
  let ids = [];
  try {
    const entries = await readdir(config.previewDir, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  const cards = ids
    .map((id) => `<a class="card" href="/${id}/"><span class="id">${id.slice(0, 8)}</span><span class="go">open preview →</span></a>`)
    .join('') || '<p class="empty">No previews yet. Run <code>node run.js "&lt;business&gt;"</code></p>';

  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DK Sites — Preview Server</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root{ --charcoal:#1a1a1d; --gold:#d4af37; --brown:#9c7a3c; --ink:#0f0f11; }
  *{box-sizing:border-box} body{margin:0;background:var(--ink);color:#eee;font-family:Inter,system-ui,sans-serif}
  header{padding:48px 24px 24px;border-bottom:1px solid #2a2a2e}
  h1{font-family:Orbitron,sans-serif;font-weight:800;letter-spacing:.04em;margin:0;font-size:clamp(1.4rem,4vw,2.2rem);
     background:linear-gradient(92deg,var(--gold),#f3e3a3,var(--brown));-webkit-background-clip:text;background-clip:text;color:transparent}
  p.sub{color:#9a9aa0;margin:.5rem 0 0}
  main{max-width:900px;margin:0 auto;padding:24px}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
  .card{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border:1px solid #2a2a2e;border-radius:12px;
        background:var(--charcoal);text-decoration:none;color:#eee;transition:border-color .2s,transform .2s}
  .card:hover{border-color:var(--gold);transform:translateY(-2px)}
  .id{font-family:Orbitron,sans-serif;color:var(--gold)} .go{color:#9a9aa0;font-size:.85rem}
  .empty{color:#9a9aa0} code{background:#222;padding:2px 6px;border-radius:5px;color:var(--gold)}
</style></head>
<body>
  <header><h1>DK SITES · PREVIEW SERVER</h1><p class="sub">Local preview of generated client sites · noindex enforced</p></header>
  <main><div class="grid">${cards}</div></main>
</body></html>`);
});

app.listen(config.port, () => {
  console.log(`DK Sites preview server → ${config.previewBaseUrl}`);
});
