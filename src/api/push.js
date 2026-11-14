import webpush from 'web-push';
import { getDb, getMeta, setMeta, now } from './db.js';
import { requireUser } from './accounts.js';

// "Your website was updated" notifications (Web Push).
//
// Works on Android and desktop browsers, and on iPhone (iOS 16.4+) once the app has been
// added to the Home Screen and the owner taps "Allow". The keys that sign our messages
// (VAPID) are made on first boot and kept in the database, so there is nothing to put in
// .env. They're in the nightly backup, so a restored box keeps working subscriptions.

const SUBJECT = () => `mailto:${process.env.EMAIL_REPLY_TO || 'dylan@dksitesllc.com'}`;

export function vapidKeys() {
  let pub = process.env.VAPID_PUBLIC_KEY || getMeta('vapid_public');
  let priv = process.env.VAPID_PRIVATE_KEY || getMeta('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    setMeta('vapid_public', pub);
    setMeta('vapid_private', priv);
    console.log('🔔 Made the push notification keys (stored in the database).');
  }
  return { publicKey: pub, privateKey: priv };
}

let sender = null; // tests swap this out
export const __setPushSenderForTests = (fn) => { sender = fn; };

function send(sub, payload) {
  if (sender) return sender(sub, payload);
  const { publicKey, privateKey } = vapidKeys();
  return webpush.sendNotification(sub, JSON.stringify(payload), {
    TTL: 60 * 60 * 24, urgency: 'normal',
    vapidDetails: { subject: SUBJECT(), publicKey, privateKey },
  });
}

/** Send to every device this person turned notifications on for. Returns how many got it. */
export async function notifyUser(userId, payload) {
  if (!userId) return 0;
  const db = getDb();
  const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(userId);
  let delivered = 0;
  for (const s of subs) {
    const sub = { endpoint: s.endpoint, keys: JSON.parse(s.keys_json) };
    try {
      await send(sub, payload);
      delivered++;
      db.prepare('UPDATE push_subs SET last_ok_at = ? WHERE endpoint = ?').run(now(), s.endpoint);
    } catch (e) {
      // 404/410: the browser threw this subscription away (app removed, permission reset).
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
      } else {
        console.error('✗ push:', e?.statusCode || '', e?.body || e?.message);
      }
    }
  }
  return delivered;
}

const validSub = (b) =>
  b && typeof b.endpoint === 'string' && /^https:\/\//.test(b.endpoint) && b.endpoint.length < 1000 &&
  b.keys && typeof b.keys.p256dh === 'string' && typeof b.keys.auth === 'string';

export function mountPush(app) {
  vapidKeys(); // make them at boot so the first subscribe is instant

  app.get('/api/push/key', (_req, res) => res.json({ publicKey: vapidKeys().publicKey }));

  app.post('/api/push/subscribe', requireUser, (req, res) => {
    const sub = req.body?.subscription;
    if (!validSub(sub)) return res.status(400).json({ error: 'That notification setup didn’t look right. Try again.' });
    getDb().prepare(`INSERT INTO push_subs (endpoint, user_id, keys_json, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json`)
      .run(sub.endpoint, req.user.id, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), now());
    res.json({ ok: true });
  });

  app.post('/api/push/unsubscribe', requireUser, (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    getDb().prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
    res.json({ ok: true });
  });

  // A test message, so the owner (or Dylan) can see it works right after allowing.
  app.post('/api/push/test', requireUser, async (req, res) => {
    const n = await notifyUser(req.user.id, {
      title: 'Notifications are on',
      body: 'We’ll let you know here when a change to your website is finished.',
      url: '/?view=dashboard',
    });
    res.json({ delivered: n });
  });
}
