'use strict';
/**
 * Overlay drawer state machine — pure data in, pure data out.
 *
 * The drawer has two independent reasons to be open:
 *   manualOpen — it opened by itself when a result appeared (and stays open on the
 *                song-select screen until the next chart starts or the game closes)
 *   hoverOpen  — the cursor is resting on the top-centre summon strip
 *
 * Keeping both flags plus the timers in ONE object, with every transition in
 * `overlayNext`, is what makes the behaviour testable. The previous version kept
 * them as eight loose module variables mutated from three different functions,
 * which is how the "drawer collapses on the song select screen" bugs kept coming
 * back.
 */

/** A momentary "Unknown" while the game swaps scenes must not close the drawer. */
const UNKNOWN_GRACE_MS = 4000;
/** How long the cursor may leave the hotzone before the drawer retracts. */
const HOVER_HOLD_MS = 1500;

const INITIAL = Object.freeze({
  phase: 'Unknown',
  manualOpen: false,
  hoverOpen: false,
  hoverLeftAt: 0,
  unknownSince: 0,
  expanded: false
});

/** Phases where the drawer is allowed to appear at all. */
function isSummonable(phase) {
  return phase === 'Results' || phase === 'Menu';
}

/**
 * Advance the state by one step.
 *
 * @param {object} state  previous state (INITIAL on first call)
 * @param {object} input
 * @param {string} input.phase      current game phase
 * @param {boolean} input.enabled   settings.overlayEnabled
 * @param {boolean} input.cursorInside  cursor within the summon hotzone
 * @param {number} input.now        Date.now()
 * @returns {object} next state (including `expanded`)
 */
function overlayNext(state, { phase, enabled, cursorInside, now }) {
  const previous = state || INITIAL;
  let manualOpen = previous.manualOpen;
  let hoverOpen = previous.hoverOpen;
  let hoverLeftAt = previous.hoverLeftAt;
  let unknownSince = previous.unknownSince;
  const lastPhase = previous.phase;

  // --- 1. phase transitions -------------------------------------------------
  if (phase === 'Results' && lastPhase !== 'Results') {
    manualOpen = true;
    unknownSince = 0;
  } else if (phase === 'Playing' && lastPhase !== 'Playing') {
    manualOpen = false;
    hoverOpen = false;
    hoverLeftAt = 0;
    unknownSince = 0;
  } else if (phase === 'Unknown') {
    if (!unknownSince) unknownSince = now;
    if (now - unknownSince > UNKNOWN_GRACE_MS) {
      manualOpen = false;
      hoverOpen = false;
      hoverLeftAt = 0;
    }
  } else {
    unknownSince = 0;
  }

  // --- 2. hover -------------------------------------------------------------
  // A brief Unknown (scene swap) keeps the drawer summonable so it doesn't blink;
  // only once the grace period lapses does it become non-summonable.
  const inUnknownGrace = phase === 'Unknown' && unknownSince !== 0 &&
    now - unknownSince <= UNKNOWN_GRACE_MS;
  const summonable = enabled && (isSummonable(phase) || inUnknownGrace);
  if (!summonable) {
    hoverOpen = false;
    hoverLeftAt = 0;
  } else if (cursorInside) {
    hoverOpen = true;
    hoverLeftAt = 0;
  } else if (hoverOpen) {
    if (!hoverLeftAt) hoverLeftAt = now + HOVER_HOLD_MS;
    if (now >= hoverLeftAt) {
      hoverOpen = false;
      hoverLeftAt = 0;
    }
  }

  // --- 3. result ------------------------------------------------------------
  const expanded = summonable && (manualOpen || hoverOpen);

  return { phase, manualOpen, hoverOpen, hoverLeftAt, unknownSince, expanded };
}

/** F5 / hotkey: flip the manual flag (only meaningful while summonable). */
function overlayToggle(state) {
  const previous = state || INITIAL;
  return { ...previous, manualOpen: !previous.manualOpen };
}

module.exports = {
  INITIAL,
  HOVER_HOLD_MS,
  UNKNOWN_GRACE_MS,
  isSummonable,
  overlayNext,
  overlayToggle
};
