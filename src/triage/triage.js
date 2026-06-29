// Triage runs before generation. It scores photos so only strong assets get promoted,
// decides whether this is a "Greenfield" build, and builds the 2-3 targeted post-preview
// asks the app surfaces AFTER showing the generated site (never as a pre-build gate).

const MIN_HERO_WIDTH = 1600; // below this, a photo isn't hero-grade

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

export function triage(facts) {
  const scored = (facts.assets.photos || [])
    .map(scorePhoto)
    .sort((a, b) => b.score - a.score);

  const heroCandidates = scored.filter((p) => p.heroGrade);
  const usablePhotos = scored.filter((p) => p.score >= 3);

  const lightText =
    !facts.atmosphere.editorialSummary && (facts.socialProof.userRatingCount || 0) < 5;
  const thinPhotos = usablePhotos.length < 2;
  const greenfield = !facts.identity.website && lightText && thinPhotos;

  const typeStr = `${facts.atmosphere.primaryType || ''} ${(facts.atmosphere.types || []).join(' ')}`;
  const needsMenu = MENU_TYPES.test(typeStr);

  return {
    ...facts,
    triage: {
      greenfield,
      needsMenu, // signals the generator used honest menu placeholders that need real data
      heroCandidate: heroCandidates[0]?.url || null,
      rankedPhotos: scored,
      usableCount: usablePhotos.length,
      suggestedAsks: buildAsks(facts, { greenfield, usableCount: usablePhotos.length, heroCandidates, needsMenu }),
    },
  };
}

function buildAsks(facts, { greenfield, usableCount, heroCandidates, needsMenu }) {
  const asks = [];
  // Menu/list businesses: the #1 thing public data can't give us, so ask for it first.
  if (needsMenu) {
    asks.push(
      `I built ${facts.identity.name}'s site with placeholder menu slots — send me your real ` +
        `tap list / menu (a photo or a link works) and I'll drop the actual items in.`
    );
  }
  if (greenfield) {
    asks.push(`I couldn't find many photos online — got a few good ones on your phone?`);
  } else {
    if (!heroCandidates.length)
      asks.push('I found photos but none big enough for a hero banner — do you have one high-res shot?');
    if (usableCount < 4)
      asks.push('A couple more interior/product photos would round out the gallery — want to add some?');
  }
  if (!facts.assets.logo)
    asks.push("I couldn't find your logo — upload it and I'll rebuild the palette around it.");
  return asks.slice(0, 3);
}
