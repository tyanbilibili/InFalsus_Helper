'use strict';

const drawer = document.getElementById('drawer');
const ratingNode = document.getElementById('ov-rating');
const playerNode = document.getElementById('ov-player');
const deltaNode = document.getElementById('ov-delta');
const phaseNode = document.getElementById('ov-phase');
let previousRating = null;

function playerLabel(state) {
  const name = state?.nickname;
  return name && name !== 'LOCAL PLAYER' ? name : 'LOCAL PLAYER';
}

function applyState(state, expanded, visible) {
  const rating = state?.result?.rating_text || '--.---';
  playerNode.textContent = playerLabel(state);
  ratingNode.textContent = rating;
  // The delta covers the whole "results -> song select" window, so it stays
  // readable after the drawer was auto-opened by the result screen.
  const delta = state?.rating_change || '-.-';
  deltaNode.textContent = delta;
  deltaNode.className = 'delta' + (delta.startsWith('+') ? ' positive' : delta.startsWith('-') && delta !== '-.-' ? ' negative' : '');
  phaseNode.textContent = state?.phase?.phase === 'Results'
    ? 'RESULT / 本次结算'
    : state?.phase?.phase === 'Playing'
      ? 'PLAYING / 浮窗折叠'
      : state?.phase?.notice || '等待成绩';
  drawer.classList.toggle('expanded', !!expanded);
  drawer.classList.toggle('collapsed', !expanded);
  drawer.style.visibility = visible ? 'visible' : 'hidden';
  if (previousRating && previousRating !== rating && expanded) {
    drawer.classList.remove('flash');
    void drawer.offsetWidth;
    drawer.classList.add('flash');
  }
  previousRating = rating;
}

window.helperAPI.onOverlayState(({ state, expanded, visible }) => {
  applyState(state, expanded, visible);
});

window.helperAPI.getState().then(state => {
  if (!state) return;
  applyState(state, false, false);
});

