import { extractMenuFromText } from './menu.js';

// Reads a business's EXISTING website for real content.
//
// The scraper already pulls visual assets (logo, hero, colors). This reads the words —
// most importantly the menu, which is usually the single most valuable thing on a
// restaurant's old site and the thing public APIs never have.
//
// Everything here is the owner's own published content, so it satisfies the truth policy:
// we are transcribing their site, not inventing anything.

const MENU_HINTS = /menu|food|drinks?|eat|dine|dinner|lunch|breakfast|order|pizza|specials|takeout/i;
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mov|css|js)(\?|$)/i;
const MAX_PAGES = 5;

/** Strip tags/scripts and collapse whitespace into readable text. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Same-origin links whose text or href suggests a menu, best candidates first. */
export function findMenuLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const [, href, inner] = m;
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.hostname.replace(/^www\./, '') !== new URL(baseUrl).hostname.replace(/^www\./, '')) continue;
    if (SKIP.test(abs.pathname)) continue;
    const label = htmlToText(inner);
    const score = (MENU_HINTS.test(label) ? 2 : 0) + (MENU_HINTS.test(abs.pathname) ? 1 : 0);
    if (!score) continue;
    const key = abs.href.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, label, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function getHtml(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DKSitesBuilder/1.0)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    if (!/text\/html/i.test(res.headers.get('content-type') || '')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Read the site: home page text plus the most menu-looking internal pages.
 * @returns {Promise<null | {pages: Array, text: string, knownMenu: object|null}>}
 */
export async function readExistingSite(website, { wantMenu = true } = {}) {
  if (!website) return null;
  const base = /^https?:\/\//i.test(website) ? website : `https://${website}`;

  const homeHtml = await getHtml(base);
  if (!homeHtml) return null;

  const pages = [{ url: base, text: htmlToText(homeHtml) }];

  if (wantMenu) {
    for (const link of findMenuLinks(homeHtml, base).slice(0, MAX_PAGES - 1)) {
      const html = await getHtml(link.url);
      if (html) pages.push({ url: link.url, text: htmlToText(html), label: link.label });
    }
  }

  const combined = pages.map((p) => `--- ${p.url} ---\n${p.text}`).join('\n\n');

  let knownMenu = null;
  if (wantMenu) {
    // Prefer a dedicated menu page's text; fall back to everything we read.
    const menuPage = pages.find((p) => p !== pages[0]) || pages[0];
    try {
      knownMenu = await extractMenuFromText(menuPage.text, menuPage.url);
      if (!knownMenu && menuPage !== pages[0]) {
        knownMenu = await extractMenuFromText(combined, base);
      }
    } catch {
      knownMenu = null; // soft failure — the build proceeds without it
    }
  }

  return { pages: pages.map((p) => ({ url: p.url, chars: p.text.length })), text: combined, knownMenu };
}
