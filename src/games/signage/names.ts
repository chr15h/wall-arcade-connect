// SIGNAGE's skin: which names of the wall the 8 bricks carry. Display only, never a rule: the engine and the verifier
// only know brick numbers 0..7. A run shows 8 real neighbours, a stretch of one row of the painted wall where every
// panel has a name in the build-time snapshot, picked from the seed (the same stretch for everyone with the same seed).
import { WALL_PANELS } from '../../generated/wall.js';
import { COLS } from './core.js';

const NAMED = new Set(WALL_PANELS.filter((panel) => panel.p <= 500).map((panel) => panel.p));
/** First panels of every stretch of COLS named neighbours on one row of the wall (25 panels a row). */
export const STRETCHES: readonly number[] = (() => {
  const out: number[] = [];
  for (let row = 0; row < 20; row++) {
    for (let c = 0; c + COLS <= 25; c++) {
      const first = row * 25 + c + 1;
      let all = true;
      for (let k = 0; k < COLS && all; k++) all = NAMED.has(first + k);
      if (all) out.push(first);
    }
  }
  return out;
})();
const ANY: readonly number[] = WALL_PANELS.map((panel) => panel.p);

/** The panel on each brick of a run (left to right). */
export function bricksFor(seed: number): number[] {
  if (STRETCHES.length) {
    const first = STRETCHES[seed % STRETCHES.length] as number;
    return Array.from({ length: COLS }, (_, k) => first + k);
  }
  // a wall without 8 named neighbours on a row (never with the current snapshot): any 8 names, from the seed on
  return Array.from({ length: COLS }, (_, k) => (ANY.length ? ANY[(seed + k) % ANY.length] as number : 0));
}
