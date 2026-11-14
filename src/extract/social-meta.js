// FACEBOOK PAGE + INSTAGRAM → BUILD (pure helpers, no network)
//
// The Graph API calls live in src/api/meta.js. Everything here only reshapes what came
// back, so it's easy to test and reason about:
//   normalizeMeta   raw Graph responses  -> { page, instagram, posts[] }
//   toOwnerSocial   normalized           -> the compact "in their own words" block the
//                                           generator and in-place editor read
//   enrichFacts     facts + normalized   -> fills GAPS only (never overwrites Google data)
//   FEED_JS         the small script that shows recent posts on a site

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const okUrl = (u, hosts) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && hosts.test(x.hostname) ? x.toString() : null;
  } catch { return null; }
};
const FB_HOSTS = /(^|\.)facebook\.com$/i;
const IG_HOSTS = /(^|\.)instagram\.com$/i;

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
function to12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const ap = h >= 12 && h < 24 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
}

/** Facebook's {mon_1_open:"11:00", mon_1_close:"21:00", …} → Google-style weekday lines. */
export function hoursFromFacebook(hours) {
  if (!hours || typeof hours !== 'object' || !Object.keys(hours).length) return null;
  const lines = DAYS.map(([k, name]) => {
    const spans = [];
    for (let i = 1; i <= 3; i++) {
      const o = to12(hours[`${k}_${i}_open`]);
      const c = to12(hours[`${k}_${i}_close`]);
      if (o && c) spans.push(`${o} – ${c}`);
    }
    return `${name}: ${spans.length ? spans.join(', ') : 'Closed'}`;
  });
  return { weekdayDescriptions: lines, source: 'facebook' };
}

/**
 * @param {object} raw { page: Graph page object, posts: [Graph post], media: [Graph IG media] }
 */
export function normalizeMeta(raw = {}) {
  const p = raw.page || {};
  const ig = p.instagram_business_account || null;
  const page = p.id ? {
    id: String(p.id),
    name: p.name || null,
    about: clip(p.about, 600) || null,
    description: clip(p.description, 1500) || null,
    category: p.category || null,
    phone: p.phone || null,
    website: p.website ? String(p.website).split(/\s+/)[0] : null,
    address: p.single_line_address || null,
    link: okUrl(p.link, FB_HOSTS) || (p.username ? `https://www.facebook.com/${p.username}` : `https://www.facebook.com/${p.id}`),
    picture: p.picture?.data?.url || null,
    cover: p.cover?.source || null,
    hours: hoursFromFacebook(p.hours),
  } : null;
  const instagram = ig?.id ? {
    id: String(ig.id),
    username: ig.username || null,
    name: ig.name || null,
    bio: clip(ig.biography, 600) || null,
    website: ig.website || null,
    url: ig.username ? `https://www.instagram.com/${ig.username}` : null,
    picture: ig.profile_picture_url || null,
    followers: Number.isFinite(ig.followers_count) ? ig.followers_count : null,
  } : null;

  const posts = [];
  for (const m of raw.media || []) {
    const image = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
    if (!image) continue;
    posts.push({
      id: `ig-${m.id}`, source: 'instagram', caption: clip(m.caption, 500), image,
      link: okUrl(m.permalink, IG_HOSTS), at: m.timestamp || null, video: m.media_type === 'VIDEO',
    });
  }
  for (const f of raw.posts || []) {
    if (!f.full_picture) continue; // text-only posts don't belong in a photo feed
    posts.push({
      id: `fb-${String(f.id).replace(/[^0-9_]/g, '')}`, source: 'facebook', caption: clip(f.message, 500),
      image: f.full_picture, link: okUrl(f.permalink_url, FB_HOSTS), at: f.created_time || null, video: false,
    });
  }
  posts.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { page, instagram, posts: posts.slice(0, 24), fetchedAt: new Date().toISOString() };
}

/** The business in its own words — what the generator and editor read. */
export function toOwnerSocial(data) {
  if (!data) return null;
  const { page, instagram, posts = [] } = data;
  const out = {
    facebook: page ? { name: page.name, about: page.about, description: page.description, category: page.category } : null,
    instagram: instagram ? { username: instagram.username, bio: instagram.bio } : null,
    recentCaptions: posts.filter((p) => p.caption).slice(0, 8)
      .map((p) => ({ from: p.source, date: (p.at || '').slice(0, 10) || null, text: clip(p.caption, 300) })),
  };
  if (!out.facebook?.about && !out.facebook?.description && !out.instagram?.bio && !out.recentCaptions.length) return null;
  return out;
}

/** Profile links that belong in sameAs / the site's social icons. */
export function profileLinks(data) {
  return [data?.page?.link, data?.instagram?.url].filter(Boolean);
}

/**
 * Fill gaps in the facts from their own Page. Google data is never overwritten: the Page
 * only supplies what Google didn't have. Returns a list of what was filled, for the log.
 */
export function enrichFacts(facts, data) {
  const filled = [];
  if (!facts || !data) return filled;
  const { page, instagram } = data;
  facts.identity = facts.identity || {};
  facts.atmosphere = facts.atmosphere || {};
  facts.operational = facts.operational || {};

  const own = toOwnerSocial(data);
  if (own) { facts.ownerSocial = own; filled.push('their own words'); }

  const links = profileLinks(data);
  if (links.length) {
    const have = new Set((facts.identity.sameAs || []).map((u) => u.replace(/\/+$/, '').toLowerCase()));
    const add = links.filter((u) => !have.has(u.replace(/\/+$/, '').toLowerCase()));
    if (add.length) { facts.identity.sameAs = [...(facts.identity.sameAs || []), ...add]; filled.push('social links'); }
  }
  if (!facts.identity.name && (page?.name || instagram?.name)) { facts.identity.name = page?.name || instagram.name; filled.push('name'); }
  if (!facts.identity.phone && page?.phone) { facts.identity.phone = page.phone; filled.push('phone'); }
  if (!facts.identity.address && page?.address) { facts.identity.address = page.address; filled.push('address'); }
  if (!facts.operational.hours && page?.hours) { facts.operational.hours = page.hours; filled.push('hours'); }
  if (!facts.atmosphere.editorialSummary) {
    const s = page?.about || page?.description || instagram?.bio;
    if (s) { facts.atmosphere.editorialSummary = clip(s, 400); filled.push('description'); }
  }
  facts._sources = { ...(facts._sources || {}), facebook: !!page, instagram: !!instagram };
  return filled;
}

/** The best photo posts to offer as site photos (no videos, newest first). */
export function photoCandidates(data, n = 6) {
  return (data?.posts || []).filter((p) => p.image && !p.video).slice(0, n);
}

// ---- the posts feed on the site -----------------------------------------------------

export const FEED_HOOK = 'data-dk-feed';
export const FEED_SCRIPT = 'dk-feed.js';

/** What the in-place editor is told when the owner asks for the feed. */
export function feedEditContext(data) {
  const igName = data?.instagram?.username ? `@${data.instagram.username}` : null;
  return {
    socialFeed: {
      what: 'A section showing the business\'s latest Facebook/Instagram posts. Our script fills it in and refreshes it nightly.',
      required: `Add ONE new section near the end of the page (before the contact/visit section or the footer) that contains exactly <div ${FEED_HOOK} data-dk-feed-count="6"></div>, and add <script src="${FEED_SCRIPT}" defer></script> just before </body>. Do not put any posts, images or captions in the HTML yourself — the script renders them.`,
      design: 'Give the section a short heading in the site\'s voice (e.g. "Latest from us" or "On Instagram") and, if there is an Instagram account, a small "Follow us" link to it. Match the site\'s existing section styling, spacing and colors. The script renders a responsive grid of square photos with short captions that inherits the section\'s text color and font.',
      instagram: data?.instagram?.url || null,
      instagramHandle: igName,
      facebook: data?.page?.link || null,
    },
  };
}

/** Standing instruction for a fresh design to keep the feed. */
export const FEED_FACT = {
  on: true,
  required: `Include one section for the latest social posts containing exactly <div ${FEED_HOOK} data-dk-feed-count="6"></div>, and <script src="${FEED_SCRIPT}" defer></script> before </body>. Never put posts in the HTML; the script fills them in.`,
};

/** dk-feed.json — only what the site needs, with our self-hosted image paths. */
export function feedJson(data, localImages) {
  return {
    updated: new Date().toISOString(),
    instagram: data?.instagram?.url || null,
    instagramHandle: data?.instagram?.username || null,
    facebook: data?.page?.link || null,
    posts: (data?.posts || [])
      .filter((p) => localImages[p.id])
      .slice(0, 12)
      .map((p) => ({
        image: localImages[p.id], caption: p.caption || '', link: p.link || null,
        source: p.source, date: (p.at || '').slice(0, 10) || null, video: !!p.video,
      })),
  };
}

// Plain JS, no dependencies. Reads dk-feed.json next to itself, builds the grid with
// textContent only (captions can never inject HTML), lazy-loads images, and hides the
// whole section if there's nothing to show rather than leaving an empty block.
export const FEED_JS = `/* DK Sites — latest posts. Refreshed nightly from the business's own Facebook/Instagram. */
(function () {
  var me = document.currentScript;
  var base = me && me.src ? me.src : location.href;
  function run() {
    var spots = document.querySelectorAll('[data-dk-feed]');
    if (!spots.length) return;
    fetch(new URL('dk-feed.json', base), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { spots.forEach(function (el) { render(el, d); }); })
      .catch(function () { spots.forEach(function (el) { render(el, null); }); });
  }
  function style() {
    if (document.getElementById('dkfeed-css')) return;
    var s = document.createElement('style');
    s.id = 'dkfeed-css';
    s.textContent =
      '.dkfeed{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:clamp(10px,2vw,18px)}' +
      '@media (min-width:760px){.dkfeed{grid-template-columns:repeat(3,minmax(0,1fr))}}' +
      '.dkfeed a{display:block;color:inherit;text-decoration:none}' +
      '.dkfeed__img{position:relative;display:block;overflow:hidden;border-radius:var(--radius,8px);aspect-ratio:1/1;background:rgba(127,127,127,.12)}' +
      '.dkfeed__img img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s ease}' +
      '.dkfeed a:hover .dkfeed__img img,.dkfeed a:focus-visible .dkfeed__img img{transform:scale(1.04)}' +
      '.dkfeed__play{position:absolute;right:8px;top:8px;width:26px;height:26px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center}' +
      '.dkfeed__cap{margin:.55em 0 0;font-size:.9em;line-height:1.4;opacity:.85;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.dkfeed__meta{display:block;margin-top:.3em;font-size:.75em;opacity:.6;letter-spacing:.02em}' +
      '@media (prefers-reduced-motion:reduce){.dkfeed__img img{transition:none}}';
    document.head.appendChild(s);
  }
  function fmt(d) {
    try { return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
  function render(el, d) {
    var posts = d && d.posts ? d.posts : [];
    var n = parseInt(el.getAttribute('data-dk-feed-count') || '6', 10) || 6;
    if (!posts.length) {
      var sec = el.closest('section');
      (sec || el).hidden = true;
      return;
    }
    style();
    var ul = document.createElement('ul');
    ul.className = 'dkfeed';
    posts.slice(0, n).forEach(function (p) {
      var li = document.createElement('li');
      var a = document.createElement(p.link ? 'a' : 'div');
      if (p.link) { a.href = p.link; a.target = '_blank'; a.rel = 'noopener'; }
      var box = document.createElement('span');
      box.className = 'dkfeed__img';
      var img = document.createElement('img');
      img.src = new URL(p.image, base).toString();
      img.alt = p.caption ? p.caption.slice(0, 120) : (p.source === 'instagram' ? 'Instagram post' : 'Facebook post');
      img.loading = 'lazy'; img.decoding = 'async'; img.width = 600; img.height = 600;
      box.appendChild(img);
      if (p.video) { var pl = document.createElement('span'); pl.className = 'dkfeed__play'; pl.textContent = '\\u25B6'; pl.setAttribute('aria-hidden', 'true'); box.appendChild(pl); }
      a.appendChild(box);
      if (p.caption) { var c = document.createElement('p'); c.className = 'dkfeed__cap'; c.textContent = p.caption; a.appendChild(c); }
      var m = document.createElement('span');
      m.className = 'dkfeed__meta';
      m.textContent = (p.source === 'instagram' ? 'Instagram' : 'Facebook') + (p.date ? ' \\u00B7 ' + fmt(p.date) : '');
      a.appendChild(m);
      li.appendChild(a);
      ul.appendChild(li);
    });
    el.textContent = '';
    el.appendChild(ul);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
`;
