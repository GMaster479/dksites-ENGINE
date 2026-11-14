import express from 'express';
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb, now, getMeta, setMeta } from './db.js';
import { requireUser, isAdmin } from './accounts.js';
import {
  normalizeMeta, toOwnerSocial, profileLinks, photoCandidates, feedEditContext, feedJson,
  FEED_JS, FEED_HOOK, FEED_SCRIPT, FEED_FACT,
} from '../extract/social-meta.js';

// FACEBOOK PAGE + INSTAGRAM CONNECTION (Nov 14)
//
// The owner signs in with Facebook ("Facebook Login for Business"), picks their Page, and
// we read — never post — their Page info, the Instagram account linked to it, and recent
// posts. That feeds three things:
//   1. new builds: their own description, hours/phone if Google had none, social links,
//      and their best recent photos
//   2. edits on an existing site: "use what we say on Facebook", "use these photos",
//      "show our latest posts" (a feed section, refreshed nightly, photos self-hosted)
//   3. the nightly feed refresh
//
// UNTIL META APPROVES THE APP (App Review + Business Verification) only people with a
// role on the Meta app can sign in, so the Connect button is shown only to admins and
// the emails in META_TESTERS. Set META_PUBLIC=true in .env once the app is approved.
//
// .env:  META_APP_ID, META_APP_SECRET            (required)
//        META_CONFIG_ID   Facebook Login for Business configuration id (recommended)
//        META_TESTERS     extra emails allowed to connect before approval, comma-separated
//        META_PUBLIC      true once Meta has approved the app
//        META_GRAPH_VERSION (default v24.0), META_REDIRECT_URI (default api.dksites.com)
//        META_SCOPES      permissions to ask for, comma-separated (default: the four we use)

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v24.0';
const REDIRECT_URI = () => process.env.META_REDIRECT_URI || 'https://api.dksites.com/api/meta/callback';
const APP = () => config.appOrigin || 'https://app.dksites.com';
// Which permissions to ask for. Override in .env (META_SCOPES=a,b,c) if the Meta app hasn't
// been given one of these yet — Facebook rejects the whole sign-in over a single unknown one.
const SCOPES = () => (process.env.META_SCOPES || 'pages_show_list,pages_read_engagement,instagram_basic,business_management')
  .split(',').map((x) => x.trim()).filter(Boolean).join(',');
const STATE_TTL = 15 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

const keysSet = () => !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
const testers = () => String(process.env.META_TESTERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Who may see the Connect button right now. */
export function metaAvailableFor(user) {
  if (!keysSet()) return { enabled: false, reason: 'not_configured' };
  if (process.env.META_PUBLIC === 'true') return { enabled: true, testing: false };
  if (user && (isAdmin(user) || testers().includes(String(user.email).toLowerCase()))) return { enabled: true, testing: true };
  return { enabled: false, reason: user ? 'not_approved_yet' : 'sign_in' };
}

// ---- secrets at rest ------------------------------------------------------------------
// Page tokens never expire, so they're encrypted in the database (and in its backups).
// The key comes from the app secret: rotate the secret and owners simply reconnect.
const key = () => createHash('sha256').update(`dksites-meta:${process.env.META_APP_SECRET || ''}`).digest();
export function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}
export function unseal(s) {
  try {
    const [iv, tag, body] = String(s || '').split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
  } catch { return null; }
}

// ---- OAuth state (signed, so nobody can attach their Page to someone else's site) ----
export function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now(), n: randomBytes(6).toString('hex') })).toString('base64url');
  const sig = createHmac('sha256', key()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function readState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', key()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Date.now() - p.t < STATE_TTL ? p : null;
  } catch { return null; }
}

// ---- Graph API ------------------------------------------------------------------------
let fetchImpl = (...a) => fetch(...a);
export const __setMetaFetchForTests = (f) => { fetchImpl = f; };

export class GraphError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export async function graph(path, params = {}) {
  const u = new URL(`https://graph.facebook.com/${GRAPH_VERSION()}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const r = await fetchImpl(u.toString(), { signal: AbortSignal.timeout(20000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) {
    const e = body.error || {};
    throw new GraphError(e.message || `Facebook said ${r.status}`, e.code || r.status);
  }
  return body;
}
const expired = (e) => e instanceof GraphError && (e.code === 190 || e.code === 102);

export function loginUrl(state) {
  const u = new URL(`https://www.facebook.com/${GRAPH_VERSION()}/dialog/oauth`);
  u.searchParams.set('client_id', process.env.META_APP_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI());
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  if (process.env.META_CONFIG_ID) {
    u.searchParams.set('config_id', process.env.META_CONFIG_ID);
    u.searchParams.set('override_default_response_type', 'true');
  } else {
    u.searchParams.set('scope', SCOPES());
  }
  return u.toString();
}

/** code -> long-lived user token -> the Pages they manage (each with a Page token). */
export async function pagesFromCode(code) {
  const app = { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET };
  const short = await graph('oauth/access_token', { ...app, redirect_uri: REDIRECT_URI(), code });
  // A Page token made from a LONG-lived user token never expires.
  const long = await graph('oauth/access_token', { ...app, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token })
    .catch(() => short);
  const token = long.access_token || short.access_token;
  const me = await graph('me', { fields: 'id,name', access_token: token });
  const pages = [];
  let next = { fields: 'id,name,category,access_token,picture.type(square){url},instagram_business_account{id,username}', limit: '50', access_token: token };
  for (let i = 0; i < 4 && next; i++) {
    const r = await graph('me/accounts', next);
    for (const p of r.data || []) {
      pages.push({
        id: String(p.id), name: p.name || 'Untitled Page', category: p.category || null, token: p.access_token,
        picture: p.picture?.data?.url || null,
        instagram: p.instagram_business_account?.id ? { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username || null } : null,
      });
    }
    next = r.paging?.cursors?.after && r.paging?.next ? { ...next, after: r.paging.cursors.after } : null;
  }
  return { fbUserId: String(me.id), pages };
}

const PAGE_FIELDS = 'id,name,username,about,description,category,phone,emails,website,link,single_line_address,hours,picture.type(large){url},cover{source},instagram_business_account{id,username,name,biography,website,profile_picture_url,followers_count}';
const PAGE_FIELDS_BASIC = 'id,name,about,category,phone,website,link,single_line_address,hours,picture.type(large){url},instagram_business_account{id,username,name,biography,profile_picture_url}';

/** Read the Page, its Instagram and recent posts. Read-only. */
export async function fetchPageData(pageId, token) {
  let page;
  try { page = await graph(pageId, { fields: PAGE_FIELDS, access_token: token }); }
  catch (e) {
    if (expired(e)) throw e;
    page = await graph(pageId, { fields: PAGE_FIELDS_BASIC, access_token: token }); // some fields need extra access
  }
  const posts = await graph(`${pageId}/posts`, { fields: 'id,message,created_time,full_picture,permalink_url', limit: '15', access_token: token })
    .then((r) => r.data || []).catch((e) => { if (expired(e)) throw e; return []; });
  const igId = page.instagram_business_account?.id;
  const media = igId
    ? await graph(`${igId}/media`, { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp', limit: '15', access_token: token })
      .then((r) => r.data || []).catch((e) => { if (expired(e)) throw e; return []; })
    : [];
  return normalizeMeta({ page, posts, media });
}

// ---- stored connection --------------------------------------------------------------

const conn = (previewId) => getDb().prepare('SELECT * FROM meta_connections WHERE preview_id = ?').get(previewId);
const dataOf = (c) => { try { return c?.data_json ? JSON.parse(c.data_json) : null; } catch { return null; } };

/** Pull fresh data for a connected Page and store it. Returns the data (or the last good copy). */
export async function refreshConnection(previewId) {
  const c = conn(previewId);
  if (!c?.page_id) throw new Error('Facebook isn’t connected for this site.');
  const sealed = unseal(c.page_token_enc);
  if (!sealed?.token) throw new Error('Your Facebook connection needs to be renewed. Connect it again.');
  try {
    const data = await fetchPageData(c.page_id, sealed.token);
    getDb().prepare('UPDATE meta_connections SET data_json = ?, fetched_at = ?, ig_id = ?, ig_username = ? WHERE preview_id = ?')
      .run(JSON.stringify(data), now(), data.instagram?.id || null, data.instagram?.username || null, previewId);
    return data;
  } catch (e) {
    if (expired(e)) {
      getDb().prepare('UPDATE meta_connections SET page_token_enc = NULL WHERE preview_id = ?').run(previewId);
      throw new Error('Facebook ended this connection (a password change or removed access does that). Connect it again.');
    }
    const old = dataOf(c);
    if (old) return old;
    throw e;
  }
}

async function choosePage(previewId, pageId) {
  const c = conn(previewId);
  const pages = unseal(c?.pages_enc) || [];
  const p = pages.find((x) => x.id === String(pageId));
  if (!p) throw new Error('That Page isn’t one of the ones Facebook gave us. Connect again and tick it.');
  getDb().prepare(`UPDATE meta_connections SET page_id = ?, page_name = ?, page_token_enc = ?, ig_id = ?, ig_username = ? WHERE preview_id = ?`)
    .run(p.id, p.name, seal({ token: p.token }), p.instagram?.id || null, p.instagram?.username || null, previewId);
  return refreshConnection(previewId);
}

// ---- images: always downloaded and self-hosted, never hotlinked ------------------------

const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
async function downloadImage(url, dest /* without extension */) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`image ${r.status}`);
  const ext = IMG_EXT[(r.headers.get('content-type') || '').split(';')[0].trim()] || 'jpg';
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 15 * 1024 * 1024) throw new Error('image size');
  await writeFile(`${dest}.${ext}`, buf);
  return ext;
}
const fileId = (id) => String(id).replace(/[^\w-]/g, '').slice(0, 60);

/** Copy chosen post photos into the site's images/ folder as owner photos. */
async function importPhotos(previewId, posts) {
  const dir = join(config.previewDir, previewId, 'images');
  await mkdir(dir, { recursive: true });
  const out = [];
  for (const p of posts) {
    try {
      const name = `social-${fileId(p.id)}`;
      const ext = await downloadImage(p.image, join(dir, name));
      out.push({
        kind: 'photo', assetPath: `images/${name}.${ext}`, path: join(dir, `${name}.${ext}`),
        note: `From their ${p.source === 'instagram' ? 'Instagram' : 'Facebook'}${p.caption ? `: ${p.caption.slice(0, 90)}` : ''}`,
      });
    } catch (e) { console.error(`  social photo ${p.id}: ${e.message}`); }
  }
  return out;
}

/** Write dk-feed.json, dk-feed.js and the feed photos. Returns which files changed. */
export async function writeFeed(previewId, data) {
  const root = join(config.previewDir, previewId);
  const dir = join(root, 'images', 'social');
  await mkdir(dir, { recursive: true });
  const existing = new Map();
  for (const f of await readdir(dir).catch(() => [])) existing.set(f.replace(/\.\w+$/, ''), f);

  const local = {};
  const changed = [];
  for (const p of (data?.posts || []).slice(0, 12)) {
    const base = fileId(p.id);
    if (existing.has(base)) { local[p.id] = `images/social/${existing.get(base)}`; continue; }
    try {
      const ext = await downloadImage(p.image, join(dir, base));
      local[p.id] = `images/social/${base}.${ext}`;
      changed.push(local[p.id]);
    } catch (e) { console.error(`  feed photo ${p.id}: ${e.message}`); }
  }
  const keep = new Set(Object.values(local).map((x) => x.split('/').pop()));
  const removed = [];
  for (const f of existing.values()) {
    if (!keep.has(f)) { await rm(join(dir, f), { force: true }); removed.push(`images/social/${f}`); }
  }
  await writeFile(join(root, 'dk-feed.json'), JSON.stringify(feedJson(data, local), null, 1));
  await writeFile(join(root, FEED_SCRIPT), FEED_JS);
  changed.push('dk-feed.json', FEED_SCRIPT);
  return { changed, removed, shown: Object.keys(local).length };
}

// ---- used by builds and edits -----------------------------------------------------------

/** For /api/generate: their Page data + their best photos, if this draft is connected. */
export async function metaInputsForBuild(previewId, userId) {
  const c = conn(previewId);
  if (!c || !c.page_id || (userId && c.user_id !== userId)) return null;
  let data = dataOf(c);
  try { data = await refreshConnection(previewId); } catch (e) { if (!data) return null; }
  const uploads = await importPhotos(previewId, photoCandidates(data, 6));
  return { data, uploads };
}

export const FEED_REQUEST = 'Show our latest Instagram and Facebook posts on the site';
export const INFO_REQUEST = 'Use how we describe ourselves on Facebook and Instagram in the site’s intro and about text';

/** For an edit job: turn the owner's Facebook/Instagram choices into a normal edit. */
export async function prepareEditExtras(previewId, req = {}) {
  const out = { photoFiles: [], instructions: [], context: {}, mustContain: [], setSocials: null, after: {} };
  const c = conn(previewId);
  if (!c?.page_id) throw new Error('Facebook isn’t connected for this site anymore. Connect it again, then try this.');
  let data;
  try { data = await refreshConnection(previewId); } catch (e) { data = dataOf(c); if (!data) throw e; }

  const { loadBuild } = await import('../edit/edit.js');
  const build = await loadBuild(previewId).catch(() => null);

  if (req.socials) {
    const have = build?.facts?.identity?.sameAs || [];
    const seen = new Set(have.map((u) => u.replace(/\/+$/, '').toLowerCase()));
    out.setSocials = [...have, ...profileLinks(data).filter((u) => !seen.has(u.toLowerCase()))];
  }
  if (req.useInfo) {
    const own = toOwnerSocial(data);
    if (own) {
      out.ownerSocial = own;
      out.instructions.push(INFO_REQUEST);
      out.context.ownerSocial = {
        ...own,
        howToUse: 'Rewrite ONLY the intro/hero tagline and the about text so they say what the business says about itself here, in a voice that fits the site. Keep layout, headings structure, images and every other section unchanged. Use only claims written here; skip specials, events or dates from old posts.',
      };
    }
  }
  if (req.photoIds?.length) {
    const want = new Set(req.photoIds);
    out.photoFiles = await importPhotos(previewId, (data.posts || []).filter((p) => want.has(p.id) && p.image));
  }
  if (req.feed) {
    const w = await writeFeed(previewId, data);
    if (!w.shown) throw new Error('We couldn’t find any recent photo posts on your Facebook or Instagram to show.');
    out.instructions.push(FEED_REQUEST);
    Object.assign(out.context, feedEditContext(data));
    out.mustContain.push(FEED_HOOK, FEED_SCRIPT);
    out.socialFeed = FEED_FACT;
    out.after.feedOn = true;
  }
  if (req.removeFeed) {
    const r = (build?.ownerRequests || []).find((x) => x.text === FEED_REQUEST);
    if (r) out.removeRequestId = r.id;
    else out.instructions.push('Remove the latest social posts section');
    out.socialFeed = false;
    out.after.feedOn = false;
  }
  return out;
}

/** After an edit with Facebook/Instagram parts finished successfully. */
export function afterEdit(previewId, after = {}) {
  if (typeof after.feedOn === 'boolean') {
    getDb().prepare('UPDATE meta_connections SET feed_on = ?, feed_synced_at = ? WHERE preview_id = ?')
      .run(after.feedOn ? 1 : 0, after.feedOn ? now() : null, previewId);
  }
}

// ---- nightly feed refresh ---------------------------------------------------------------

function liveSlug(previewId) {
  const db = getDb();
  return db.prepare("SELECT slug FROM sites WHERE preview_id = ? AND slug IS NOT NULL ORDER BY id DESC").get(previewId)?.slug ||
    db.prepare('SELECT slug FROM builds WHERE preview_id = ?').get(previewId)?.slug || null;
}

export async function refreshFeeds({ deploy = null } = {}) {
  const rows = getDb().prepare('SELECT preview_id FROM meta_connections WHERE feed_on = 1 AND page_id IS NOT NULL').all();
  const push = deploy || (await import('../deploy/r2.js')).deployFiles;
  let ok = 0, failed = 0;
  for (const { preview_id: id } of rows) {
    try {
      const data = await refreshConnection(id);
      const w = await writeFeed(id, data);
      const slug = liveSlug(id);
      if (slug) await push(join(config.previewDir, id), slug, w.changed, w.removed);
      getDb().prepare('UPDATE meta_connections SET feed_synced_at = ? WHERE preview_id = ?').run(now(), id);
      ok++;
    } catch (e) {
      failed++;
      console.error(`✗ feed refresh ${id}: ${e.message}`);
    }
  }
  if (rows.length) console.log(`📸 social feeds refreshed: ${ok} ok, ${failed} failed`);
  return { ok, failed };
}

const today = () => new Date().toISOString().slice(0, 10);
async function nightly() {
  if (getMeta('feeds_refreshed_day') === today() || new Date().getUTCHours() < 8) return; // ~3–4am Eastern
  setMeta('feeds_refreshed_day', today());
  await refreshFeeds().catch((e) => console.error('✗ feed refresh:', e.message));
}

// ---- routes -----------------------------------------------------------------------------

function previewAllowed(user, previewId) {
  if (!SAFE_ID.test(String(previewId || ''))) return 'Invalid preview id.';
  const b = getDb().prepare('SELECT user_id FROM builds WHERE preview_id = ?').get(previewId);
  if (b && b.user_id !== user.id && !isAdmin(user)) return 'This site belongs to another account.';
  const c = conn(previewId);
  if (c && c.user_id !== user.id && !isAdmin(user)) return 'This site belongs to another account.';
  return null;
}

function publicConnection(c, user) {
  const avail = metaAvailableFor(user);
  if (!c) return { ...avail, connected: false };
  if (!c.page_id) {
    const pages = (unseal(c.pages_enc) || []).map(({ token, ...p }) => p);
    return { ...avail, connected: false, choosing: pages };
  }
  const d = dataOf(c) || {};
  return {
    ...avail,
    connected: true,
    needsReconnect: !c.page_token_enc,
    page: d.page ? { name: d.page.name, link: d.page.link, picture: d.page.picture, category: d.page.category } : { name: c.page_name },
    instagram: d.instagram ? { username: d.instagram.username, url: d.instagram.url, picture: d.instagram.picture } : null,
    about: d.page?.about || d.page?.description || d.instagram?.bio || null,
    found: {
      description: !!(d.page?.about || d.page?.description || d.instagram?.bio),
      hours: !!d.page?.hours, phone: !!d.page?.phone,
      posts: (d.posts || []).length, photos: photoCandidates(d, 24).length,
    },
    posts: (d.posts || []).slice(0, 12).map((p) => ({ id: p.id, image: p.image, caption: p.caption, source: p.source, date: (p.at || '').slice(0, 10), video: p.video })),
    feedOn: !!c.feed_on,
    fetchedAt: c.fetched_at,
  };
}

export function mountMeta(app) {
  setTimeout(nightly, 2 * 60 * 1000).unref();
  setInterval(nightly, 60 * 60 * 1000).unref();

  app.get('/api/meta/available', (req, res) => res.json(metaAvailableFor(req.user)));

  // Step 1: the app sends the owner here (a real page navigation, not fetch).
  app.get('/api/meta/start', (req, res) => {
    const previewId = String(req.query.previewId || '');
    const back = req.query.return === 'extras' ? 'extras' : 'editor';
    if (!req.user) return res.redirect(`${APP()}/?meta=signin&preview=${encodeURIComponent(previewId)}&return=${back}`);
    if (!metaAvailableFor(req.user).enabled) return res.redirect(`${APP()}/?meta=unavailable`);
    const bad = previewAllowed(req.user, previewId);
    if (bad) return res.redirect(`${APP()}/?meta=error&reason=${encodeURIComponent(bad)}`);
    res.redirect(loginUrl(signState({ u: req.user.id, p: previewId, r: back })));
  });

  // Step 2: Facebook sends them back here.
  app.get('/api/meta/callback', async (req, res) => {
    const st = readState(req.query.state);
    const back = (q) => res.redirect(`${APP()}/?${new URLSearchParams({ meta: q, ...(st ? { preview: st.p, return: st.r } : {}) })}`);
    if (!st) return back('expired');
    if (req.query.error || !req.query.code) return back('cancel');
    if (!req.user || req.user.id !== st.u) return back('signin');
    try {
      const { fbUserId, pages } = await pagesFromCode(String(req.query.code));
      if (!pages.length) return back('nopages');
      const db = getDb();
      db.prepare(`INSERT INTO meta_connections (preview_id, user_id, fb_user_id, pages_enc, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(preview_id) DO UPDATE SET user_id = excluded.user_id, fb_user_id = excluded.fb_user_id, pages_enc = excluded.pages_enc,
          page_id = NULL, page_token_enc = NULL`)
        .run(st.p, st.u, fbUserId, seal(pages), now());
      if (pages.length === 1) {
        await choosePage(st.p, pages[0].id);
        console.log(`🔗 Facebook connected for ${st.p}: ${pages[0].name}${pages[0].instagram ? ` + @${pages[0].instagram.username}` : ''}`);
        return back('connected');
      }
      return back('choose');
    } catch (e) {
      console.error('✗ Facebook connect:', e.message);
      return back('error');
    }
  });

  app.get('/api/meta/connection', requireUser, (req, res) => {
    const previewId = String(req.query.previewId || '');
    const bad = previewAllowed(req.user, previewId);
    if (bad) return res.status(403).json({ error: bad });
    res.json(publicConnection(conn(previewId), req.user));
  });

  app.post('/api/meta/choose', requireUser, async (req, res) => {
    const { previewId, pageId } = req.body || {};
    const bad = previewAllowed(req.user, previewId);
    if (bad) return res.status(403).json({ error: bad });
    try {
      await choosePage(previewId, pageId);
      res.json(publicConnection(conn(previewId), req.user));
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  app.post('/api/meta/refresh', requireUser, async (req, res) => {
    const { previewId } = req.body || {};
    const bad = previewAllowed(req.user, previewId);
    if (bad) return res.status(403).json({ error: bad });
    try {
      await refreshConnection(previewId);
      res.json(publicConnection(conn(previewId), req.user));
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  // Disconnect. If their site shows the posts feed, empty it so the section hides itself.
  app.delete('/api/meta/connection', requireUser, async (req, res) => {
    const previewId = String(req.query.previewId || '');
    const bad = previewAllowed(req.user, previewId);
    if (bad) return res.status(403).json({ error: bad });
    const c = conn(previewId);
    getDb().prepare('DELETE FROM meta_connections WHERE preview_id = ?').run(previewId);
    if (c?.feed_on) {
      try {
        const w = await writeFeed(previewId, { posts: [] });
        const slug = liveSlug(previewId);
        if (slug) await (await import('../deploy/r2.js')).deployFiles(join(config.previewDir, previewId), slug, w.changed, w.removed);
      } catch (e) { console.error('✗ empty feed:', e.message); }
    }
    res.json({ connected: false });
  });

  // Meta calls these when someone removes our app from their Facebook settings or asks for
  // their data to be deleted. Required for App Review. We delete every connection made
  // with that Facebook account and return a confirmation code they can quote.
  const deletion = (req, res) => {
    const [sig, payload] = String(req.body?.signed_request || '').split('.');
    if (!sig || !payload) return res.status(400).json({ error: 'missing signed_request' });
    const want = createHmac('sha256', process.env.META_APP_SECRET || '').update(payload).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(400).json({ error: 'bad signature' });
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return res.status(400).json({ error: 'bad payload' }); }
    const fbUser = String(data.user_id || '');
    const n = fbUser ? getDb().prepare('DELETE FROM meta_connections WHERE fb_user_id = ?').run(fbUser).changes : 0;
    const code = randomBytes(6).toString('hex');
    console.log(`🗑  Meta data deletion for FB user …${fbUser.slice(-4)}: ${n} connection(s) removed (code ${code})`);
    res.json({ url: `${APP()}/privacy.html#facebook-data`, confirmation_code: code });
  };
  app.post('/api/meta/data-deletion', express.urlencoded({ extended: false }), deletion);
  app.post('/api/meta/deauthorize', express.urlencoded({ extended: false }), deletion);
}

