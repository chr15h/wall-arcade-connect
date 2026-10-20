// FULL ROW: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// A copy of the most common Block Blast / 1010! rules, nothing invented: an 8×8 grid without gravity, three pieces in a
// tray placed in any order (no rotation), full rows and full columns empty, consecutive clears build a combo, the run
// ends when none of the pieces in hand fits anywhere. Integer arithmetic only, a seeded generator (src/common/det.ts),
// a state that round-trips through JSON exactly, no clock, no network. The engine knows no name: the names of the wall
// are a skin the client paints over the pieces from their draw index.
import { fnv1a, mulberry32 } from '../../common/det.js';

/* ================================ RULES ====================================
   Score (Block Blast's community-documented base, the brief's multipliers; see the report):
   +placeCell per cell placed · a cleared line = lineCell × 8 cells, × the simultaneity bonus (in halves: 1 line ×1,
   2 ×1.5, 3 ×2, 4+ ×3) × the combo factor (1 + 0.5 × combo), combo = consecutive clearing placements before this one,
   capped at comboCap; a placement that clears nothing resets it · an emptied grid +allClear (not multiplied).
   Generator: weighted draw per trio, at least `minSmall` pieces of `smallMax` cells or fewer in every trio. */
export const RULES = {
  size: 8,
  placeCell: 1,
  lineCell: 10,
  simulHalves: [0, 2, 3, 4, 6] as readonly number[],   // index = lines cleared at once (4 = four or more)
  comboCap: 10,
  allClear: 300,
  minSmall: 1, smallMax: 3,
  endDelayTicks: 10,                                   // 0.5 s of server time between "nothing fits" and the end
  // draw weight of each piece, per orientation (see PIECES for the order)
  weights: {
    dot: 1, i2: 2, i3: 2, i4: 2, i5: 2, o2: 2, o3: 4, r23: 3, l3: 1, l5: 3, t4: 2,
  } as Record<string, number>,
};
export const N = RULES.size;
export const FULL = (1 << N) - 1;

/* ================================ PIECES ====================================
   Cells as [x, y] from the top-left of the piece's box. The order is part of the rules (a piece id is its index). */
type Shape = { key: string; family: string; cells: readonly (readonly [number, number])[] };
const box = (w: number, h: number): [number, number][] => { const out: [number, number][] = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push([x, y]); return out; };
const line = (n: number, vertical: boolean): [number, number][] => Array.from({ length: n }, (_, i) => (vertical ? [0, i] : [i, 0]) as [number, number]);
const SHAPES: Shape[] = [
  { key: '1', family: 'dot', cells: [[0, 0]] },
  { key: 'I2-', family: 'i2', cells: line(2, false) }, { key: 'I2|', family: 'i2', cells: line(2, true) },
  { key: 'I3-', family: 'i3', cells: line(3, false) }, { key: 'I3|', family: 'i3', cells: line(3, true) },
  { key: 'I4-', family: 'i4', cells: line(4, false) }, { key: 'I4|', family: 'i4', cells: line(4, true) },
  { key: 'I5-', family: 'i5', cells: line(5, false) }, { key: 'I5|', family: 'i5', cells: line(5, true) },
  { key: 'O2', family: 'o2', cells: box(2, 2) },
  { key: 'O3', family: 'o3', cells: box(3, 3) },
  { key: 'R2x3', family: 'r23', cells: box(2, 3) }, { key: 'R3x2', family: 'r23', cells: box(3, 2) },
  // L of 3 cells: a 2×2 corner, missing one cell
  { key: 'L3a', family: 'l3', cells: [[0, 0], [0, 1], [1, 1]] }, { key: 'L3b', family: 'l3', cells: [[0, 0], [1, 0], [0, 1]] },
  { key: 'L3c', family: 'l3', cells: [[0, 0], [1, 0], [1, 1]] }, { key: 'L3d', family: 'l3', cells: [[1, 0], [0, 1], [1, 1]] },
  // L of 5 cells: a 3×3 corner (one full row and one full column sharing a corner)
  { key: 'L5a', family: 'l5', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] }, { key: 'L5b', family: 'l5', cells: [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]] },
  { key: 'L5c', family: 'l5', cells: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]] }, { key: 'L5d', family: 'l5', cells: [[2, 0], [2, 1], [0, 2], [1, 2], [2, 2]] },
  // T of 4 cells
  { key: 'T4a', family: 't4', cells: [[0, 0], [1, 0], [2, 0], [1, 1]] }, { key: 'T4b', family: 't4', cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  { key: 'T4c', family: 't4', cells: [[0, 0], [0, 1], [1, 1], [0, 2]] }, { key: 'T4d', family: 't4', cells: [[1, 0], [0, 1], [1, 1], [1, 2]] },
];

export type Piece = {
  id: number; key: string; family: string; cells: readonly (readonly [number, number])[];
  w: number; h: number; size: number;
  /** Row bit masks of the piece at x = 0 (bit x = column x). */
  rowMask: readonly number[];
};
export const PIECES: readonly Piece[] = SHAPES.map((shape, id) => {
  const w = Math.max(...shape.cells.map(([x]) => x)) + 1, h = Math.max(...shape.cells.map(([, y]) => y)) + 1;
  const rowMask = Array.from({ length: h }, () => 0);
  for (const [x, y] of shape.cells) rowMask[y] = (rowMask[y] as number) | (1 << x);
  return { id, key: shape.key, family: shape.family, cells: shape.cells, w, h, size: shape.cells.length, rowMask };
});
export const PIECE_COUNT = PIECES.length;

/* ============================ TYPES & VALIDATION =============================
   Hand-written and dependency-free, so the verifier module stays small and starts fast (no schema library to load in a
   cold isolate). engine.ts holds the equivalent zod schemas for the page; tests/full-row.test.ts checks they agree. */
export type FrConfig = { game: 'full-row'; maxTicks: number; roundTicks: number };
export type Play = {
  /** The 64-bit grid as 8 row bytes: bit x of rows[y] is the cell (x, y). */
  rows: number[];
  /** The tray: a piece id per slot, -1 once placed. */
  hand: number[];
  /** Pieces drawn so far (the tray of slot s holds draw `drawn - 3 + s`): the client hangs the names on this index. */
  drawn: number;
  score: number; combo: number; placed: number; lines: number;
  /** The last accepted placement [slot, x, y] (display only: lets the client attribute the cells to a piece). */
  last: [number, number, number] | null;
  /** Server tick at which no piece in hand fit any more; the run ends `endDelayTicks` later. */
  stuckTick: number | null;
};
export type FrState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: FrConfig; play: Play };
export type FrInput = { action: 'start' } | { action: 'place'; slot: number; x: number; y: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const fail = (what: string): never => { throw new Error(`Invalid FULL ROW ${what}`); };

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): FrConfig {
  if (!isObject(value) || value.game !== 'full-row' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'full-row', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, out-of-range number). */
export function parseInput(value: unknown): FrInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'place' && exactKeys(value, ['action', 'slot', 'x', 'y'])
    && isInt(value.slot, 0, 2) && isInt(value.x, 0, N - 1) && isInt(value.y, 0, N - 1)) return { action: 'place', slot: value.slot, x: value.x, y: value.y };
  return null;
}
const PLAY_KEYS = ['rows', 'hand', 'drawn', 'score', 'combo', 'placed', 'lines', 'last', 'stuckTick'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): FrState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  const rows = p.rows, hand = p.hand, last = p.last;
  if (!Array.isArray(rows) || rows.length !== N || !rows.every((r) => isInt(r, 0, FULL))) return fail('state');
  if (!Array.isArray(hand) || hand.length !== 3 || !hand.every((h) => isInt(h, -1, PIECE_COUNT - 1))) return fail('state');
  if (!isInt(p.drawn, 0, 1_000_000) || !isInt(p.score, 0, MAX_INT) || !isInt(p.combo, 0, RULES.comboCap)
    || !isInt(p.placed, 0, 1_000_000) || !isInt(p.lines, 0, 1_000_000)) return fail('state');
  if (last !== null && !(Array.isArray(last) && last.length === 3 && isInt(last[0], 0, 2) && isInt(last[1], 0, N - 1) && isInt(last[2], 0, N - 1))) return fail('state');
  if (p.stuckTick !== null && !isInt(p.stuckTick, 0, MAX_INT)) return fail('state');
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || p.drawn < 3 || p.drawn % 3 !== 0) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: { rows: rows.slice(), hand: hand.slice(), drawn: p.drawn, score: p.score, combo: p.combo, placed: p.placed, lines: p.lines,
      last: last === null ? null : [last[0], last[1], last[2]], stuckTick: p.stuckTick },
  };
}

/* ================================ GRID ====================================== */
export function fits(rows: readonly number[], piece: Piece, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x + piece.w > N || y + piece.h > N) return false;
  for (let dy = 0; dy < piece.h; dy++) if (((rows[y + dy] as number) & ((piece.rowMask[dy] as number) << x)) !== 0) return false;
  return true;
}
export function fitsAnywhere(rows: readonly number[], piece: Piece): boolean {
  for (let y = 0; y + piece.h <= N; y++) for (let x = 0; x + piece.w <= N; x++) if (fits(rows, piece, x, y)) return true;
  return false;
}
/** Full rows and columns of a grid, as bit masks (bit i = row i / column i). */
export function fullLines(rows: readonly number[]): { rowMask: number; colMask: number } {
  let rowMask = 0, colMask = FULL;
  for (let y = 0; y < N; y++) { const r = rows[y] as number; if (r === FULL) rowMask |= 1 << y; colMask &= r; }
  return { rowMask, colMask };
}
export const bitCount = (v: number): number => { let n = 0; while (v) { v &= v - 1; n++; } return n; };

export type PlaceResult = {
  rows: number[]; rowMask: number; colMask: number; lines: number;
  gain: number; lineGain: number; allClear: boolean; combo: number;
};
/** The pure effect of one placement (no state change): the grid after the clears and the points it earns. */
export function evaluatePlacement(rows: readonly number[], combo: number, piece: Piece, x: number, y: number): PlaceResult {
  const next = rows.slice();
  for (let dy = 0; dy < piece.h; dy++) next[y + dy] = (next[y + dy] as number) | ((piece.rowMask[dy] as number) << x);
  const { rowMask, colMask } = fullLines(next);
  const lines = bitCount(rowMask) + bitCount(colMask);
  let gain = piece.size * RULES.placeCell, lineGain = 0, allClear = false, nextCombo = 0;
  if (lines > 0) {
    const before = combo < RULES.comboCap ? combo : RULES.comboCap;
    const halves = RULES.simulHalves[lines < 4 ? lines : 4] as number;
    // lineCell × 8 × lines × (halves / 2) × (2 + before) / 2: always a whole number
    lineGain = (RULES.lineCell * N * lines * halves * (2 + before)) / 4;
    for (let yy = 0; yy < N; yy++) next[yy] = (rowMask & (1 << yy)) ? 0 : ((next[yy] as number) & ~colMask & FULL);
    allClear = next.every((r) => r === 0);
    gain += lineGain + (allClear ? RULES.allClear : 0);
    nextCombo = combo + 1 < RULES.comboCap ? combo + 1 : RULES.comboCap;
  }
  return { rows: next, rowMask, colMask, lines, gain, lineGain, allClear, combo: nextCombo };
}

/* ================================ GENERATOR ================================= */
const weightOf = (piece: Piece): number => RULES.weights[piece.family] ?? 0;
function weightedDraw(rnd: () => number, pool: readonly Piece[]): number {
  let total = 0;
  for (const piece of pool) total += weightOf(piece);
  let r = Math.floor(rnd() * total);
  for (const piece of pool) { r -= weightOf(piece); if (r < 0) return piece.id; }
  return (pool[pool.length - 1] as Piece).id;
}
const SMALL = PIECES.filter((piece) => piece.size <= RULES.smallMax);
/** Trio number `t` of a run: a pure function of (seed, t), the same for every player of the same seed. No hidden
 *  rescue: the draw never looks at the grid. */
export function trio(seed: number, t: number): [number, number, number] {
  const rnd = mulberry32(fnv1a(`full-row:${seed}:${t}`));
  const out = [weightedDraw(rnd, PIECES), weightedDraw(rnd, PIECES), weightedDraw(rnd, PIECES)] as [number, number, number];
  let small = out.filter((id) => (PIECES[id] as Piece).size <= RULES.smallMax).length;
  for (let i = 2; i >= 0 && small < RULES.minSmall; i--) {
    if ((PIECES[out[i] as number] as Piece).size > RULES.smallMax) { out[i] = weightedDraw(rnd, SMALL); small++; }
  }
  return out;
}

/* ================================ ENGINE ==================================== */
export function createEngine() {
  function deal(play: Play, seed: number): void {
    play.hand = trio(seed, play.drawn / 3);
    play.drawn += 3;
  }
  function stuck(play: Play): boolean {
    for (const id of play.hand) if (id >= 0 && fitsAnywhere(play.rows, PIECES[id] as Piece)) return false;
    return true;
  }

  function newPlay(seed: number): Play {
    const play: Play = { rows: Array.from({ length: N }, () => 0), hand: [-1, -1, -1], drawn: 0, score: 0, combo: 0, placed: 0, lines: 0, last: null, stuckTick: null };
    deal(play, seed);
    return play;
  }

  /** Places hand[slot] at (x, y) when legal. False (and no change) otherwise. */
  function place(state: FrState, slot: number, x: number, y: number): boolean {
    const play = state.play;
    if (play.stuckTick !== null) return false;
    const id = play.hand[slot];
    if (id === undefined || id < 0) return false;
    const piece = PIECES[id] as Piece;
    if (!fits(play.rows, piece, x, y)) return false;
    const result = evaluatePlacement(play.rows, play.combo, piece, x, y);
    play.rows = result.rows; play.score += result.gain; play.combo = result.combo;
    play.lines += result.lines; play.placed++; play.last = [slot, x, y];
    play.hand[slot] = -1;
    if (play.hand.every((h) => h < 0)) deal(play, state.seed);
    if (stuck(play)) play.stuckTick = state.tick;
    return true;
  }

  /* ----------------------- run lifecycle (coordinator contract) ----------------------- */
  function endTickOf(state: FrState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  /** Mutating advance. Nothing moves with time on this board: time only ends a run (the 8-minute cap, or the short
   *  pause after the last piece stopped fitting). */
  function advanceInPlace(state: FrState, serverTick: number): FrState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const endTick = endTickOf(state);
    state.tick = Math.min(serverTick, state.rules.maxTicks);
    if (state.tick >= endTick) { state.tick = endTick; state.gameOver = true; }
    const stuckAt = state.play.stuckTick;
    if (stuckAt !== null && state.tick >= stuckAt + RULES.endDelayTicks) {
      state.tick = Math.min(state.tick, stuckAt + RULES.endDelayTicks);
      state.gameOver = true;
    }
    return state;
  }
  const clone = (state: FrState): FrState => structuredClone(state);

  function createRun(seed: unknown, config: unknown): FrState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return { tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules, play: newPlay(validSeed) };
  }
  function advance(state: FrState, serverTick: number): FrState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: FrState, input: unknown, serverTick: number): FrState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; }
      return state;
    }
    if (!state.started) return state;
    place(state, action.slot, action.x, action.y);
    return state;
  }
  function applyInput(state: FrState, input: unknown, serverTick: number): FrState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: FrState): FrState => state;
  const isFinished = (state: FrState): boolean => state.gameOver;
  const score = (state: FrState): number => state.play.score;

  return { createRun, advance, applyInput, view, isFinished, score, advanceInPlace, applyInputInPlace, place, clone, endTickOf, newPlay, stuck };
}
export type FullRowEngine = ReturnType<typeof createEngine>;
