import { join } from 'node:path';

// Visual self-QA: screenshot the generated homepage at the DK test widths, then (later)
// feed the screenshots back to the model to fix layout issues before a human sees it.
// Playwright is an optional dependency — if it isn't installed, QA is skipped gracefully.
// Install browsers once with:  npx playwright install chromium

export const TEST_WIDTHS = [325, 375, 768, 1080, 1440, 1920];

export async function screenshotPreview(previewDir, indexPath = 'index.html') {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { skipped: true, reason: 'playwright not installed (npm i playwright && npx playwright install chromium)' };
  }

  const fileUrl = 'file://' + join(process.cwd(), previewDir, indexPath);
  const browser = await chromium.launch();
  const shots = [];
  try {
    for (const w of TEST_WIDTHS) {
      const page = await browser.newPage({ viewport: { width: w, height: 900 } });
      await page.goto(fileUrl, { waitUntil: 'networkidle' }).catch(() => {});
      const out = join(previewDir, `qa-${w}.png`);
      await page.screenshot({ path: out, fullPage: true });
      shots.push({ width: w, path: out });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { skipped: false, shots };
}

/**
 * Self-correct hook. Pass the screenshots back to a vision-capable model with the rule
 * spec and ask for surgical fixes. Stubbed as a clear extension point — wire to
 * Anthropic with image blocks + the str_replace edit loop (the Agent SDK pattern).
 */
export async function selfCorrect(/* previewDir, shots, generated */) {
  return { applied: false, note: 'self-correct loop not yet wired — see qa/screenshot.js' };
}
