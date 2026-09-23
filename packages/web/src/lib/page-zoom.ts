/**
 * Page-zoom self-heal (phone).
 *
 * This app is a fixed-viewport shell: html/body don't scroll; scrolling is inside regions. Once the whole page
 * is zoomed, content runs off the visible area and the user has to pinch back — so "don't stay zoomed" is a product requirement.
 *
 * Zoom has three sources, each owned by a different layer:
 *  1. Focusing a control whose font-size is < 16px (iOS auto-zoom) → styles/tokens.css raises control font-size to 16px;
 *  2. Double-tap zoom → `* { touch-action: manipulation }` in styles/tokens.css;
 *  3. Pinch, and "lock screen / switch away and come back, the system restores the previous zoom" → this module.
 *
 * Why #3 can only be handled at the event layer: from iOS 10, Safari ignores viewport meta user-scalable=no /
 * maximum-scale (accessibility), so meta cannot block pinch; and `visualViewport.scale` is read-only
 * (those `scale = 1` snippets do nothing). The only action that pulls scale back to 1 is **rewriting meta content** —
 * Safari re-parses viewport and re-applies initial-scale. Do this only when actually zoomed, and restore the original
 * config next frame, so intentional pinch-to-zoom is not sacrificed (not installed on desktop, to avoid fighting the browser zoom).
 */

/** Original config, matching index.html. */
const PLAIN = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
/** One-shot lock config: parsing it necessarily pulls scale back to 1. */
const LOCKED
  = 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

/** Scale above this counts as "zoomed" — 1% slack for float error. */
const ZOOM_LIMIT = 1.01;

/** After returning to the foreground, the system may restore zoom after the event, so check once more. */
const RECHECK_DELAY_MS = 300;

function viewportMeta(): HTMLMetaElement | null {
  return document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
}

function isZoomed(): boolean {
  const scale = window.visualViewport?.scale;
  return typeof scale === 'number' && scale > ZOOM_LIMIT;
}

/**
 * Rewrite content once to trigger a re-parse that pulls scale back to 1.
 * setAttribute with the same value does not trigger a parse, so pick a different spelling from the current value.
 */
function resetScale(): void {
  const meta = viewportMeta();
  if (!meta)
    return;
  const original = meta.getAttribute('content') ?? PLAIN;
  const transient = original.includes('maximum-scale') ? PLAIN : LOCKED;
  meta.setAttribute('content', transient);
  window.setTimeout(() => meta.setAttribute('content', original), 16);
}

function recheck(): void {
  if (isZoomed())
    resetScale();
}

function watchResume(): void {
  // Lock screen → unlock, switch to another app and back, return to Safari from the app switcher: all go through these.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden)
      return;
    recheck();
    window.setTimeout(recheck, RECHECK_DELAY_MS);
  });
  window.addEventListener('pageshow', recheck);
  window.addEventListener('focus', recheck);
}

export function installPageZoomLock(): void {
  // Install only on touch devices: on desktop `visualViewport.scale` is raised by browser zoom (⌘+/⌘-),
  // and that path should be the user's own browser setting, not rewritten by us.
  const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (!touch)
    return;
  watchResume();
}
