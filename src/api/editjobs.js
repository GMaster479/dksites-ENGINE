import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { getDb, now } from './db.js';
import { isAdmin } from './accounts.js';

// EDITS THAT FINISH ON THEIR OWN (Nov 14)
//
// An edit is a saved job, not something the phone has to babysit:
//   - the phone drops the request off and can close, lose signal or switch apps — the
//     server finishes the change, saves it and publishes it regardless
//   - jobs live in the database, so a server restart mid-edit picks the job back up
//     (or, if the change was already saved, just finishes publishing it)
//   - edits to the same site run one after another, never on top of each other
//   - when it finishes and nobody is watching, the owner gets a notification on their
//     phone, or an email if they haven't turned notifications on
//   - the app can ask "is anything running for this site?" when it reopens

const WATCHING_MS = 12_000;          // polled this recently = they're looking at the screen
const SHOW_RECENT_MS = 2 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 2;

const chains = new Map();            // previewId -> promise of the job currently running

const row = (id) => getDb().prepare('SELECT * FROM edit_jobs WHERE id = ?').get(id);
function update(id, patch) {
  const keys = Object.keys(patch);
  getDb().prepare(`UPDATE edit_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), now(), id);
}

/** What the app sees — same shape as the old in-memory jobs. */
export function publicJob(r) {
  if (!r) return null;
  let result = null;
  try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch {}
  return {
    jobId: r.id, previewId: r.preview_id, status: r.status, stage: r.stage, progress: r.progress,
    result, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** Polling a job also records that someone is watching it. */
export function pollEditJob(id) {
  const r = row(id);
  if (!r) return null;
  getDb().prepare('UPDATE edit_jobs SET last_polled_at = ? WHERE id = ?').run(now(), id);
  return publicJob(r);
}

// The address an edit publishes to comes from OUR records, never from the request: a
// request naming someone else's address must not be able to overwrite their site.
export function slugFor(previewId, requested) {
  const db = getDb();
  const known =
    db.prepare("SELECT slug FROM sites WHERE preview_id = ? AND slug IS NOT NULL ORDER BY id DESC").get(previewId)?.slug ||
    db.prepare('SELECT slug FROM builds WHERE preview_id = ? AND slug IS NOT NULL').get(previewId)?.slug || null;
  if (known) return known;
  const s = typeof requested === 'string' && /^[a-z0-9-]{2,60}$/.test(requested) ? requested : null;
  if (!s) return null;
  const takenByOther =
    db.prepare('SELECT 1 FROM sites WHERE slug = ? AND (preview_id IS NULL OR preview_id != ?)').get(s, previewId) ||
    db.prepare('SELECT 1 FROM builds WHERE slug = ? AND preview_id != ?').get(s, previewId);
  return takenByOther ? null : s;
}

export function createEditJob({ previewId, userId = null, request }) {
  const id = randomUUID();
  const t = now();
  getDb().prepare(`INSERT INTO edit_jobs (id, preview_id, user_id, status, stage, progress, request_json, created_at, updated_at, last_polled_at)
    VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?)`)
    .run(id, previewId, userId, 'Waiting for your earlier change to finish…', JSON.stringify(request), t, t, t);
  enqueue(id, previewId);
  return id;
}

function enqueue(id, previewId) {
  const prev = chains.get(previewId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => runEditJob(id));
  chains.set(previewId, next);
  next.finally(() => { if (chains.get(previewId) === next) chains.delete(previewId); });
  return next;
}

// Swappable for tests: the real edit + publish.
let deps = null;
async function realDeps() {
  const { applyEdit, loadBuild } = await import('../edit/edit.js');
  const { deployPreview } = await import('../deploy/r2.js');
  return { applyEdit, loadBuild, deployPreview };
}
export const __setEditDepsForTests = (d) => { deps = d; };

export async function runEditJob(id) {
  const r = row(id);
  if (!r || r.status === 'done' || r.status === 'error') return;
  const d = deps || await realDeps();
  const req = JSON.parse(r.request_json);
  const attempts = r.attempts + 1;
  update(id, { status: 'running', attempts, stage: req.redesign ? 'Designing a fresh version of your site…' : 'Making your change…', progress: 0.2 });

  try {
    let version = null;
    try { version = (await d.loadBuild(r.preview_id)).version ?? null; } catch {}

    let result;
    let metaAfter = null;
    if (r.start_version != null && version != null && version > r.start_version) {
      // Restarted after the change was already saved: just finish publishing it.
      result = { version, summary: 'Your change was saved.', resumed: true };
    } else {
      update(id, { start_version: version });
      const change = { ...req };
      // Facebook / Instagram extras: download their photos, write the posts feed, etc.
      if (req.meta && typeof req.meta === 'object') {
        const { prepareEditExtras } = await import('./meta.js');
        const extra = await prepareEditExtras(r.preview_id, req.meta);
        change.photoFiles = [...(change.photoFiles || []), ...extra.photoFiles];
        change.instructions = [...(change.instructions || []), ...extra.instructions];
        change.extraContext = { ...(change.extraContext || {}), ...extra.context };
        change.mustContain = [...(change.mustContain || []), ...extra.mustContain];
        change.setSocials = extra.setSocials ?? change.setSocials ?? null;
        if (extra.ownerSocial) change.ownerSocial = extra.ownerSocial;
        if (extra.socialFeed !== undefined) change.socialFeed = extra.socialFeed;
        if (extra.removeRequestId && !change.removeRequestId) change.removeRequestId = extra.removeRequestId;
        metaAfter = extra.after;
      }
      const out = await d.applyEdit(r.preview_id, change);
      result = {
        version: out.preview?.version, applied: out.editInstruction, summary: out.summary,
        ownerRequests: out.ownerRequests, redesign: out.redesign,
      };
    }

    const slug = slugFor(r.preview_id, req.slug);
    if (slug) {
      update(id, { stage: 'Publishing your updated site…', progress: 0.85 });
      const deployed = await d.deployPreview(join(config.previewDir, r.preview_id), slug);
      result.url = deployed.url;
    }
    if (metaAfter) (await import('./meta.js')).afterEdit(r.preview_id, metaAfter);
    update(id, { status: 'done', stage: 'Your changes are live', progress: 1, result_json: JSON.stringify(result) });
  } catch (e) {
    console.error(`✗ edit ${id.slice(0, 8)} (${r.preview_id}):`, e.message);
    update(id, { status: 'error', error: e.message || 'Something went wrong while making your change.' });
  }
  await maybeNotify(id).catch((e) => console.error('✗ edit notify:', e.message));
}

// ---- telling them it's done --------------------------------------------------------

function siteInfo(previewId) {
  const db = getDb();
  const site = db.prepare("SELECT domain FROM sites WHERE preview_id = ? AND domain IS NOT NULL AND status != 'canceled' ORDER BY id DESC").get(previewId);
  const build = db.prepare('SELECT name, preview_url FROM builds WHERE preview_id = ?').get(previewId);
  return { live: !!site, domain: site?.domain || null, name: build?.name || null, previewUrl: build?.preview_url || null };
}

export async function maybeNotify(id, { force = false } = {}) {
  const r = row(id);
  if (!r || !r.user_id || r.notified_at) return null;
  if (!['done', 'error'].includes(r.status)) return null;
  const watching = r.last_polled_at && now() - r.last_polled_at < WATCHING_MS;
  if (watching && !force) return null;

  const info = siteInfo(r.preview_id);
  const job = publicJob(r);
  const ok = r.status === 'done';
  const what = info.name ? `${info.name}: ` : '';
  const payload = ok
    ? { title: info.live ? 'Your website was updated' : 'Your preview was updated',
        body: `${what}${String(job.result?.summary || 'Your change is done.').slice(0, 160)}`,
        url: `/?edited=${encodeURIComponent(r.preview_id)}`, tag: `edit-${r.preview_id}` }
    : { title: 'That change didn’t go through',
        body: `${what}Nothing on your site was changed. Open the app to try again.`,
        url: `/?edited=${encodeURIComponent(r.preview_id)}`, tag: `edit-${r.preview_id}` };

  const { notifyUser } = await import('./push.js');
  let how = null;
  if (await notifyUser(r.user_id, payload)) how = 'push';
  else {
    const user = getDb().prepare('SELECT email, name FROM users WHERE id = ?').get(r.user_id);
    if (user?.email) {
      const { sendEmail, layout, button, esc } = await import('./mailer.js');
      const app = config.appOrigin || 'https://app.dksites.com';
      const siteUrl = info.domain ? `https://${info.domain}` : (job.result?.url || info.previewUrl);
      await sendEmail({
        to: user.email,
        subject: ok ? payload.title : 'Your website change didn’t go through',
        text: `${payload.body}\n\n${ok && siteUrl ? `See it: ${siteUrl}\n` : ''}Open DK Sites: ${app}${payload.url}`,
        html: layout({
          heading: ok ? payload.title : 'That change didn’t go through',
          bodyHtml: `<p style="margin:0 0 18px">${esc(payload.body)}</p>` +
            (ok && siteUrl ? `<p style="margin:0 0 18px"><a href="${esc(siteUrl)}" style="color:#18181b">See it on your site</a></p>` : '') +
            button(`${app}${payload.url}`, ok ? 'Open DK Sites' : 'Try again'),
        }),
      });
      how = 'email';
    }
  }
  if (how) update(id, { notified_at: now(), notified_how: how });
  return how;
}

// ---- after a restart ---------------------------------------------------------------

export function resumeUnfinished() {
  const db = getDb();
  const stuck = db.prepare("SELECT id, preview_id, attempts FROM edit_jobs WHERE status IN ('queued','running') ORDER BY created_at").all();
  for (const j of stuck) {
    if (j.attempts >= MAX_ATTEMPTS) {
      update(j.id, { status: 'error', error: 'The server restarted twice during this change. Nothing on your site was changed — try it again.' });
      maybeNotify(j.id, { force: true }).catch(() => {});
      continue;
    }
    console.log(`↻ resuming edit ${j.id.slice(0, 8)} for ${j.preview_id}`);
    update(j.id, { status: 'queued', stage: 'Picking your change back up…' });
    enqueue(j.id, j.preview_id);
  }
  // Keep the table small: finished jobs older than 30 days go.
  db.prepare("DELETE FROM edit_jobs WHERE status IN ('done','error') AND created_at < ?").run(now() - 30 * 24 * 60 * 60 * 1000);
  return stuck.length;
}

// ---- routes ------------------------------------------------------------------------

export function readEditRequest(body = {}) {
  const b = body || {};
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const meta = b.meta && typeof b.meta === 'object' ? {
    useInfo: b.meta.useInfo === true,
    feed: b.meta.feed === true,
    removeFeed: b.meta.removeFeed === true,
    photoIds: list(b.meta.photoIds, 12).map(String),
    socials: b.meta.socials === true,
  } : null;
  return {
    slug: typeof b.slug === 'string' ? b.slug : null,
    instruction: typeof b.instruction === 'string' ? b.instruction.slice(0, 2000) : null,
    instructions: list(b.instructions, 12).map((t) => String(t).slice(0, 2000)),
    logoFile: b.logoFile || null,
    menuFilePath: b.menuFile?.path || null,
    menuFilePaths: Array.isArray(b.menuFiles) ? b.menuFiles.map((f) => f?.path).filter(Boolean) : null,
    photoFiles: list(b.photoFiles, 24),
    setPalette: b.setPalette || null,
    setFonts: b.setFonts || null,
    setSocials: Array.isArray(b.setSocials) ? b.setSocials.slice(0, 10).map(String) : null,
    removeRequestId: typeof b.removeRequestId === 'string' ? b.removeRequestId : null,
    redesign: b.redesign === true,
    ...(meta && (meta.useInfo || meta.feed || meta.removeFeed || meta.photoIds.length || meta.socials) ? { meta } : {}),
  };
}

export function mountEditJobs(app) {
  // Start an edit. Returns at once; the app polls /api/status/:jobId (or doesn't — it
  // finishes either way). guardPreview + the id check already ran for this path.
  app.post('/api/apply-edit', (req, res) => {
    const { previewId } = req.body || {};
    if (!previewId) return res.status(400).json({ error: 'previewId required' });
    const jobId = createEditJob({ previewId, userId: req.user?.id || null, request: readEditRequest(req.body) });
    res.json({ jobId });
  });

  // "Is anything running (or just finished) for this site?" — used when the app reopens.
  app.get('/api/edits/latest', (req, res) => {
    const previewId = String(req.query.previewId || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(previewId)) return res.status(400).json({ error: 'Invalid preview id.' });
    const owner = getDb().prepare('SELECT user_id FROM builds WHERE preview_id = ?').get(previewId);
    if (owner && (!req.user || (req.user.id !== owner.user_id && !isAdmin(req.user)))) {
      return res.json({ job: null });
    }
    const r = getDb().prepare('SELECT * FROM edit_jobs WHERE preview_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(previewId, now() - SHOW_RECENT_MS);
    res.json({ job: publicJob(r) });
  });

  setTimeout(() => {
    try {
      const n = resumeUnfinished();
      if (n) console.log(`↻ ${n} unfinished edit(s) picked back up after restart`);
    } catch (e) { console.error('✗ resume edits:', e.message); }
  }, 3000).unref();
}
