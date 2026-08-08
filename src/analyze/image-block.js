import { readFile } from 'node:fs/promises';

// Turns an image SOURCE into an Anthropic vision block. A source is either a remote URL
// (Google Places photo, scraped logo) or a local path to something the owner uploaded.
// Both brand analysis and the vision pass use this, so an uploaded logo anchors the
// palette exactly the way a scraped one does.

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif',
};

const isRemote = (s) => /^https?:\/\//i.test(String(s || ''));

export async function imageBlockFrom(src, { timeoutMs = 20000 } = {}) {
  if (!src) return null;
  try {
    let media_type;
    let buf;

    if (isRemote(src)) {
      const res = await fetch(src, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      media_type = (res.headers.get('content-type') || '').split(';')[0].trim();
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      media_type = BY_EXT[String(src).split('.').pop().toLowerCase()];
      buf = await readFile(src);
    }

    if (!ALLOWED.includes(media_type) || !buf?.length) return null;
    return { type: 'image', source: { type: 'base64', media_type, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

export { isRemote };
