// DK Sites router Worker. One Worker serves every client site from one R2 bucket.
//
// Hostname -> slug -> R2 key:
//   rileys.dksites.com/        -> clients/rileys/index.html
//   rileys.dksites.com/css/x   -> clients/rileys/css/x
//   <live custom domain>/      -> slug looked up in routes/<host> (Cloudflare for SaaS)
//
// Previews (*.dksites.com) get X-Robots-Tag: noindex. Live custom domains do NOT.

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json',
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon',
  webm: 'video/webm', mp4: 'video/mp4', woff2: 'font/woff2', woff: 'font/woff',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', webmanifest: 'application/manifest+json',
};

const PREVIEW_BASE = 'dksites.com';

function typeFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

async function resolveSlug(host, env) {
  // Preview subdomain: <slug>.dksites.com
  if (host === PREVIEW_BASE || host === `www.${PREVIEW_BASE}`) return { slug: null, isApex: true, isPreview: true };
  if (host.endsWith(`.${PREVIEW_BASE}`)) {
    return { slug: host.slice(0, -1 * (`.${PREVIEW_BASE}`).length), isPreview: true };
  }
  // Live custom domain: look up routes/<host> -> { slug }
  try {
    const obj = await env.BUCKET.get(`routes/${host}.json`);
    if (obj) {
      const { slug } = JSON.parse(await obj.text());
      return { slug, isPreview: false };
    }
  } catch {}
  return { slug: null, isPreview: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    // app.dksites.com is the Pages-hosted builder app, not a client site — proxy to Pages.
    if (host === 'app.dksites.com') {
      return fetch(`https://dksites.pages.dev${url.pathname}${url.search}`, request);
    }
    const { slug, isApex, isPreview } = await resolveSlug(host, env);
    // Apex/root of the preview domain: reserved for the builder app/marketing site later.
    if (isApex) {
      return new Response('DK Sites Builder — coming soon.', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
      });
    }
    if (!slug) return new Response('Site not found.', { status: 404 });

    // Normalize path -> R2 key.
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    if (!path.includes('.')) path = path.replace(/\/?$/, '/index.html'); // extensionless -> dir index
    const key = `clients/${slug}${path.startsWith('/') ? path : '/' + path}`;

    let obj = await env.BUCKET.get(key);
    if (!obj) {
      // Try the site's own 404, else a plain one.
      obj = await env.BUCKET.get(`clients/${slug}/404.html`);
      if (!obj) return new Response('Not found.', { status: 404 });
    }

    const headers = new Headers();
    headers.set('content-type', obj.httpMetadata?.contentType || typeFor(key));
    headers.set('cache-control', isPreview ? 'no-cache, max-age=0' : 'public, max-age=3600');
    if (isPreview) headers.set('x-robots-tag', 'noindex, nofollow');
    headers.set('x-dksites-slug', slug);

    return new Response(obj.body, { headers });
  },
};
