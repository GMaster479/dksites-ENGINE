import * as cheerio from 'cheerio';

// Crawls the existing site (if any) for brand assets and color signals.
// Best-effort and defensive — a missing or hostile site must not break the pipeline.

const ASSET_PATTERNS = {
  logo: /logo/i,
  favicon: /favicon|apple-touch-icon/i,
  hero: /hero|banner|cover|masthead|splash/i,
};

function abs(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function scrapeLegacySite(websiteUri) {
  if (!websiteUri) return { assets: [], colors: [], reachable: false };
  let html;
  try {
    const res = await fetch(websiteUri, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DKSitesBot/0.1)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return { assets: [], colors: [], reachable: false, status: res.status };
    html = await res.text();
  } catch (e) {
    return { assets: [], colors: [], reachable: false, error: String(e.message || e) };
  }

  const $ = cheerio.load(html);
  const assets = [];
  const seen = new Set();
  const add = (role, url) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    assets.push({ source: 'legacy', role, url });
  };

  // favicons / touch icons
  $('link[rel*="icon"]').each((_, el) => add('favicon', abs(websiteUri, $(el).attr('href'))));
  // og:image is usually the best hero candidate
  $('meta[property="og:image"], meta[name="og:image"]').each((_, el) =>
    add('hero', abs(websiteUri, $(el).attr('content')))
  );
  // images matching role patterns by src/class/alt/id
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (!src) return;
    const hay = `${src} ${$(el).attr('class') || ''} ${$(el).attr('alt') || ''} ${$(el).attr('id') || ''}`;
    for (const [role, re] of Object.entries(ASSET_PATTERNS)) {
      if (re.test(hay)) {
        add(role, abs(websiteUri, src));
        return;
      }
    }
  });

  // brand colors: hex codes from inline styles + <style> blocks
  const colorCount = {};
  const hexRe = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
  const bump = (txt) => {
    if (!txt) return;
    const m = txt.match(hexRe) || [];
    for (let hex of m) {
      hex = hex.toLowerCase();
      if (hex.length === 4) hex = '#' + hex.slice(1).split('').map((c) => c + c).join(''); // #abc -> #aabbcc
      // ignore pure black/white/near-grays as "brand" signal
      if (['#000000', '#ffffff'].includes(hex)) continue;
      colorCount[hex] = (colorCount[hex] || 0) + 1;
    }
  };
  $('[style]').each((_, el) => bump($(el).attr('style')));
  $('style').each((_, el) => bump($(el).text()));

  const colors = Object.entries(colorCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([hex, count]) => ({ hex, count }));

  return {
    reachable: true,
    title: $('title').first().text().trim() || null,
    metaDescription: $('meta[name="description"]').attr('content') || null,
    assets,
    colors,
  };
}
