// Triage runs before generation. It scores photos so only strong assets get promoted,
// runs the VISION PASS so every photo carries a caption the generator can place it by,
// decides whether this is a "Greenfield" build, and builds the 2-3 targeted post-preview
// asks the app surfaces AFTER showing the generated site (never as a pre-build gate).

import { describePhotos } from '../analyze/vision.js';

const MIN_HERO_WIDTH = 1600; // below this, a photo isn't hero-grade

// Vision "kind" values that should never be used as scene photography on the site.
const NON_SCENE = new Set(['logo', 'menu', 'screenshot', 'unclear']);

function scorePhoto(p) {
  let score = 0;
  if (p.source === 'google') score += 3;
  else if (p.source === 'legacy') score += 2;
  else score += 1;
  if (p.widthPx) {
    if (p.widthPx >= 2400) score += 3;
    else if (p.widthPx >= MIN_HERO_WIDTH) score += 2;
  } else {
    score += 1;
  }
  const heroGrade = (p.widthPx || 0) >= MIN_HERO_WIDTH || p.role === 'hero';
  return { ...p, score, heroGrade };
}

// Business types whose sites lean on a menu/list the public APIs don't expose.
const MENU_TYPES = /brewery|bar|restaurant|cafe|coffee|bakery|food|winery|pizza|deli|distillery/i;

/**
 * @param {object} facts   business_facts
 * @param {object} opts    { vision = true, visionFn } — vision:false skips the call
 *                          (dry runs); visionFn injects a stub for deterministic tests.
 */
export async function triage(facts, opts = {}) {
  const { vision = true, visionFn = describePhotos } = opts;

  let scored = (facts.assets.photos || [])
    .map(scorePhoto)
    .sort((a, b) => b.score - a.score);

  // ---- VISION PASS -------------------------------------------------------------
  // Labels are attached to the photo OBJECTS (not held as an index map) so that any
  // later reordering or removal carries each caption with its own image. The writer
  // and generator both re-index this array into images/photo-N.webp, so they stay in
  // lockstep automatically.
  let visionSummary = null;
  let assets = facts.assets;

  if (vision && scored.length) {
    const seen = await visionFn(scored, visionContext(facts));
    if (seen) {
      visionSummary = seen.summary || null;
      for (const label of seen.photos || []) {
        const target = scored[Number(label.i) - 1];
        if (!target) continue;
        target.caption = label.caption || null;
        target.tags = Array.isArray(label.tags) ? label.tags.slice(0, 6) : [];
        target.kind = label.kind || null;
        // Only trust an activity label the model is actually sure of — a confident wrong
        // label is what put mini-golf photos in the driving-range section.
        if (label.activity && (label.confidence ?? 1) >= 0.6) {
          target.activity = label.activity;
          target.activityConfidence = label.confidence ?? null;
        }
        target.issues = Array.isArray(label.issues) ? label.issues : [];
        if (typeof label.heroGrade === 'boolean') target.heroGrade = label.heroGrade;
        if (label.isLogo) target.isLogo = true;
      }

      // DECIDE #1 - hero. Vision's pick wins, but only if the file is big enough to
      // survive a full-width crop; otherwise fall back to the resolution ranking.
      const heroPick = seen.heroIndex ? scored[seen.heroIndex - 1] : null;
      if (heroPick && (heroPick.widthPx || 0) >= MIN_HERO_WIDTH) heroPick.isHero = true;

      // DECIDE #2 - logo. A logo hiding in the photo set is worth more as the palette
      // anchor than as another gallery image, so promote it and pull it out of the
      // scene photos (brand.js reads assets.logo as a vision input for the palette).
      const logoPick = seen.logoIndex ? scored[seen.logoIndex - 1] : null;
      if (logoPick && !facts.assets.logo) {
        assets = { ...facts.assets, logo: logoPick.url, logoFromPhotos: true };
      }
      if (logoPick) scored = scored.filter((p) => p !== logoPick);

      // Anything vision flagged as not-real-photography drops to the back of the pack
      // rather than being deleted - a thin photo set still needs something to show.
      scored = scored.sort((a, b) => {
        const bad = (p) => (NON_SCENE.has(p.kind) ? 1 : 0);
        return bad(a) - bad(b) || b.score - a.score;
      });
    }
  }

  const heroFromVision = scored.find((p) => p.isHero) || null;
  const heroCandidates = scored.filter((p) => p.heroGrade && !NON_SCENE.has(p.kind));
  const usablePhotos = scored.filter((p) => p.score >= 3 && !NON_SCENE.has(p.kind));

  const lightText =
    !facts.atmosphere.editorialSummary && (facts.socialProof.userRatingCount || 0) < 5;
  const thinPhotos = usablePhotos.length < 2;
  const greenfield = !facts.identity.website && lightText && thinPhotos;

  const typeStr = `${facts.atmosphere.primaryType || ''} ${(facts.atmosphere.types || []).join(' ')}`;
  const needsMenu = MENU_TYPES.test(typeStr);

  return {
    ...facts,
    assets,
    triage: {
      greenfield,
      needsMenu, // signals the generator used honest menu placeholders that need real data
      heroCandidate: (heroFromVision || heroCandidates[0])?.url || null,
      rankedPhotos: scored,
      usableCount: usablePhotos.length,
      photoSummary: visionSummary,
      labeled: scored.some((p) => p.caption),
      suggestedAsks: buildAsks(
        { ...facts, assets },
        { greenfield, usableCount: usablePhotos.length, heroCandidates, needsMenu }
      ),
    },
  };
}

// What the business actually offers, so vision can tell its similar-looking areas apart.
function visionContext(facts) {
  const reviews = (facts.socialProof?.reviews || [])
    .map((r) => r.text || '')
    .join(' ')
    .slice(0, 1200);
  return {
    name: facts.identity?.name || null,
    type: facts.atmosphere?.primaryTypeDisplayName || facts.atmosphere?.primaryType || null,
    summary: facts.atmosphere?.editorialSummary || null,
    offerings: [
      ...new Set(
        (facts.atmosphere?.types || [])
          .map((t) => String(t).replace(/_/g, ' '))
          .filter((t) => !/point of interest|establishment|store$/i.test(t))
      ),
    ].slice(0, 12),
    reviewGist: reviews || null,
  };
}

function buildAsks(facts, { greenfield, usableCount, heroCandidates, needsMenu }) {
  const asks = [];
  // Menu/list businesses: the #1 thing public data can't give us, so ask for it first.
  if (needsMenu) {
    asks.push(
      `I built ${facts.identity.name}'s site with placeholder menu slots - send me your real ` +
        `tap list / menu (a photo or a link works) and I'll drop the actual items in.`
    );
  }
  if (greenfield) {
    asks.push(`I couldn't find many photos online - got a few good ones on your phone?`);
  } else {
    if (!heroCandidates.length)
      asks.push('I found photos but none big enough for a hero banner - do you have one high-res shot?');
    if (usableCount < 4)
      asks.push('A couple more interior/product photos would round out the gallery - want to add some?');
  }
  if (!facts.assets.logo)
    asks.push("I couldn't find your logo - upload it and I'll rebuild the palette around it.");
  return asks.slice(0, 3);
}
