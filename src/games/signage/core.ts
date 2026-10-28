// SIGNAGE: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// Rush hour at the Summit door. People walk in from the street at the bottom of a plaza, each one heading for their
// own brick in the wall at the top. Left alone they walk straight up and reach the wrong brick: the player lays
// arrow signs on the plaza to steer them. A sign turns every walker that stands on it, so the crowd shares the signs.
// Integer arithmetic only, spawns a pure function of (seed, walker number), a state that round-trips through JSON
// exactly, no clock, no network. The engine knows no name: the client hangs the wall's names on the 8 bricks.
import { fnv1a, mulberry32 } from '../../common/det.js';

/* ================================ RULES ====================================
   The board: row 0 is the wall (8 bricks), rows 1..10 the plaza, walkers appear on row 10 facing up.
   Each step (every `stepTicks` server ticks, faster as the run goes on) every walker first takes the sign under its
   feet, if any, then moves one cell: into a brick from row 1 (its own: delivered; another: it turns back down), off
   a side (it turns around and waits), off the bottom (it leaves: a miss). Every step costs one patience; at zero the
   walker gives up (a miss). The run ends at the `strikes`-th miss or at the server cap.
   Score: a delivery pays (deliverBase + patience left × patiencePoints) × the streak factor, 1 + ⌊streak / 5⌋ capped
   at multCap, streak = deliveries since the last miss. */
export const RULES = {
  cols: 8,
  rows: 11,
  maxSigns: 8,                     // the oldest sign is taken down when a ninth one goes up
  strikes: 5,
  patience: 40,                    // steps
  maxWalkers: 24,
  firstSpawnTicks: 20,             // the first walker 1 s after the start
  spawnStart: 70, spawnMin: 14, spawnRampTicks: 60,     // spawn interval: −1 tick every 3 s, 3.5 s → 0.7 s
  stepStart: 7, stepMin: 3, stepRampTicks: 900,         // step interval: −1 tick every 45 s, 350 ms → 150 ms
  deliverBase: 50, patiencePoints: 5, streakPerMult: 5, multCap: 5,
  logSize: 16,
};
export const COLS = RULES.cols, ROWS = RULES.rows, BOTTOM = ROWS - 1;
/** Directions are the sprite sheets' rows: 0 up, 1 right, 2 down, 3 left. */
export const DX: readonly number[] = [0, 1, 0, -1];
export const DY: readonly number[] = [-1, 0, 1, 0];
export const UP = 0, DOWN = 2;
/** Outcome codes in the log (entry = walker id × 4 + code). */
export const DELIVERED = 0, LEFT = 1, GAVE_UP = 2;

/* ============================ TYPES & VALIDATION ============================= */
export type SgConfig = { game: 'signage'; maxTicks: number; roundTicks: number };
export type Walker = {
  /** Walker number in the run (spawn order): the same person for every player of the same seed. */
  id: number;
  x: number; y: number; dir: number;
  /** The brick (column 0..7) this walker is heading for. */
  to: number;
  life: number;
};
export type Play = {
  /** Signs in the order they went up: [cell, dir], cell = y × COLS + x. */
  signs: [number, number][];
  walkers: Walker[];
  spawned: number;
  /** Server ticks of the last step and of the next step / spawn. */
  lastStep: number; nextStep: number; nextSpawn: number;
  steps: number;
  score: number; delivered: number; missed: number; streak: number; bestStreak: number;
  /** The last outcomes, oldest first (display only: lets the client name who arrived and who gave up). */
  log: number[];
};
export type SgState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: SgConfig; play: Play };
export type SgInput = { action: 'start' } | { action: 'sign'; x: number; y: number; dir: number } | { action: 'clear'; x: number; y: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const fail = (what: string): never => { throw new Error(`Invalid SIGNAGE ${what}`); };
/** A plaza cell (signs never go on the wall row). */
const isPlazaCell = (cell: number): boolean => cell >= COLS && cell < ROWS * COLS;

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): SgConfig {
  if (!isObject(value) || value.game !== 'signage' || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: 'signage', maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, out-of-range number). */
export function parseInput(value: unknown): SgInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'sign' && exactKeys(value, ['action', 'x', 'y', 'dir'])
    && isInt(value.x, 0, COLS - 1) && isInt(value.y, 1, BOTTOM) && isInt(value.dir, 0, 3)) return { action: 'sign', x: value.x, y: value.y, dir: value.dir };
  if (value.action === 'clear' && exactKeys(value, ['action', 'x', 'y'])
    && isInt(value.x, 0, COLS - 1) && isInt(value.y, 1, BOTTOM)) return { action: 'clear', x: value.x, y: value.y };
  return null;
}
const WALKER_KEYS = ['id', 'x', 'y', 'dir', 'to', 'life'] as const;
const PLAY_KEYS = ['signs', 'walkers', 'spawned', 'lastStep', 'nextStep', 'nextSpawn', 'steps', 'score', 'delivered', 'missed', 'streak', 'bestStreak', 'log'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): SgState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  const { signs, walkers, log } = p;
  if (!Array.isArray(signs) || signs.length > RULES.maxSigns) return fail('state');
  const cells = new Set<number>();
  for (const s of signs) {
    if (!Array.isArray(s) || s.length !== 2 || !isInt(s[0], 0, ROWS * COLS - 1) || !isPlazaCell(s[0]) || !isInt(s[1], 0, 3) || cells.has(s[0])) return fail('state');
    cells.add(s[0]);
  }
  if (!Array.isArray(walkers) || walkers.length > RULES.maxWalkers) return fail('state');
  for (const w of walkers) {
    if (!isObject(w) || !exactKeys(w, WALKER_KEYS) || !isInt(w.id, 0, 1_000_000) || !isInt(w.x, 0, COLS - 1) || !isInt(w.y, 1, BOTTOM)
      || !isInt(w.dir, 0, 3) || !isInt(w.to, 0, COLS - 1) || !isInt(w.life, 1, RULES.patience)) return fail('state');
  }
  if (!Array.isArray(log) || log.length > RULES.logSize || !log.every((e) => isInt(e, 0, 4_000_003))) return fail('state');
  if (!isInt(p.spawned, 0, 1_000_000) || !isInt(p.lastStep, 0, MAX_INT) || !isInt(p.nextStep, 0, MAX_INT) || !isInt(p.nextSpawn, 0, MAX_INT)
    || !isInt(p.steps, 0, 1_000_000) || !isInt(p.score, 0, MAX_INT) || !isInt(p.delivered, 0, 1_000_000) || !isInt(p.missed, 0, RULES.strikes)
    || !isInt(p.streak, 0, 1_000_000) || !isInt(p.bestStreak, 0, 1_000_000)) return fail('state');
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || walkers.length > p.spawned || p.delivered + p.missed > p.spawned || (p.missed >= RULES.strikes && !gameOver)
    || (started && !gameOver && !(p.lastStep <= tick && p.nextStep > tick && p.nextSpawn > tick))
    || (!gameOver && tick >= (startTick === null ? rules.maxTicks : Math.min(rules.maxTicks, startTick + rules.roundTicks)))) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      signs: signs.map((s) => [s[0], s[1]] as [number, number]),
      walkers: walkers.map((w) => ({ id: w.id, x: w.x, y: w.y, dir: w.dir, to: w.to, life: w.life } as Walker)),
      spawned: p.spawned, lastStep: p.lastStep, nextStep: p.nextStep, nextSpawn: p.nextSpawn, steps: p.steps,
      score: p.score, delivered: p.delivered, missed: p.missed, streak: p.streak, bestStreak: p.bestStreak, log: log.slice() as number[],
    },
  };
}

/* ================================ TIMING ==================================== */
/** Server ticks between two steps, `elapsed` ticks after the start. */
export const stepTicks = (elapsed: number): number => Math.max(RULES.stepMin, RULES.stepStart - Math.floor(elapsed / RULES.stepRampTicks));
/** Server ticks between two walkers, `elapsed` ticks after the start. */
export const spawnTicks = (elapsed: number): number => Math.max(RULES.spawnMin, RULES.spawnStart - Math.floor(elapsed / RULES.spawnRampTicks));

/** Walker number `k` of a run: where it enters (column of row 10) and which brick it wants, never the one straight
 *  ahead. A pure function of (seed, k), the same for every player of the same seed; it never looks at the board. */
export function spawnOf(seed: number, k: number): { x: number; to: number } {
  const rnd = mulberry32(fnv1a(`signage:${seed}:${k}`));
  const x = Math.floor(rnd() * COLS);
  let to = Math.floor(rnd() * (COLS - 1));
  if (to >= x) to++;
  return { x, to };
}

/** Points of a delivery with `life` patience left, after `streak` deliveries in a row. */
export function deliveryPoints(life: number, streak: number): number {
  const mult = 1 + Math.min(RULES.multCap - 1, Math.floor(streak / RULES.streakPerMult));
  return (RULES.deliverBase + life * RULES.patiencePoints) * mult;
}

/* ================================ ENGINE ==================================== */
export function createEngine() {
  function newPlay(): Play {
    return { signs: [], walkers: [], spawned: 0, lastStep: 0, nextStep: 0, nextSpawn: 0, steps: 0, score: 0, delivered: 0, missed: 0, streak: 0, bestStreak: 0, log: [] };
  }
  const signAt = (play: Play, cell: number): number => { for (const s of play.signs) if (s[0] === cell) return s[1]; return -1; };
  function record(play: Play, id: number, code: number): void {
    play.log.push(id * 4 + code);
    if (play.log.length > RULES.logSize) play.log.shift();
  }
  function miss(play: Play, w: Walker, code: number): void {
    play.missed++; play.streak = 0; record(play, w.id, code);
  }

  /** Every walker, in spawn order: take the sign underfoot, then one cell. */
  function step(state: SgState): void {
    const play = state.play;
    const kept: Walker[] = [];
    for (const w of play.walkers) {
      const sign = signAt(play, w.y * COLS + w.x);
      if (sign >= 0) w.dir = sign;
      w.life--;
      const nx = w.x + (DX[w.dir] as number), ny = w.y + (DY[w.dir] as number);
      if (ny === 0) {
        if (w.to === nx) {
          play.score += deliveryPoints(w.life, play.streak);
          play.delivered++; play.streak++; if (play.streak > play.bestStreak) play.bestStreak = play.streak;
          record(play, w.id, DELIVERED);
          continue;
        }
        w.dir = DOWN;                                // someone else's brick: turn back
      } else if (nx < 0 || nx >= COLS) {
        w.dir = (w.dir + 2) % 4;                     // the plaza's side: turn around
      } else if (ny > BOTTOM) {
        miss(play, w, LEFT); continue;               // back to the street
      } else { w.x = nx; w.y = ny; }
      if (w.life <= 0) { miss(play, w, GAVE_UP); continue; }
      kept.push(w);
    }
    play.walkers = kept;
    play.steps++;
    if (play.missed >= RULES.strikes) { play.missed = RULES.strikes; state.gameOver = true; }
  }
  function spawn(state: SgState): void {
    const play = state.play;
    if (play.walkers.length >= RULES.maxWalkers) return;
    const { x, to } = spawnOf(state.seed, play.spawned);
    play.walkers.push({ id: play.spawned, x, y: BOTTOM, dir: UP, to, life: RULES.patience });
    play.spawned++;
  }

  /** Puts up a sign (a sign already on that cell is replaced and counts as the newest); the oldest of nine goes. */
  function sign(play: Play, x: number, y: number, dir: number): void {
    const cell = y * COLS + x;
    play.signs = play.signs.filter((s) => s[0] !== cell);
    play.signs.push([cell, dir]);
    if (play.signs.length > RULES.maxSigns) play.signs.shift();
  }
  function clear(play: Play, x: number, y: number): void {
    const cell = y * COLS + x;
    play.signs = play.signs.filter((s) => s[0] !== cell);
  }

  /* ----------------------- run lifecycle (coordinator contract) ----------------------- */
  function endTickOf(state: SgState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }
  /** Mutating advance (the browser's prediction uses it directly). Jumps from event to event: a step, a spawn or the
   *  end, so a long call costs one pass per event, never one per tick. A step and a spawn on the same tick: step first. */
  function advanceInPlace(state: SgState, serverTick: number): SgState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const endTick = endTickOf(state);
    const target = Math.min(serverTick, endTick);
    const play = state.play;
    while (!state.gameOver) {
      const next = state.started ? Math.min(play.nextStep, play.nextSpawn) : Number.MAX_SAFE_INTEGER;
      if (next > target) { state.tick = target; break; }
      state.tick = next;
      const elapsed = next - (state.startTick as number);
      if (next === play.nextStep) { step(state); play.lastStep = next; play.nextStep = next + stepTicks(elapsed); }
      if (!state.gameOver && next === play.nextSpawn) { spawn(state); play.nextSpawn = next + spawnTicks(elapsed); }
    }
    if (state.tick >= endTick) { state.tick = endTick; state.gameOver = true; }
    return state;
  }
  const clone = (state: SgState): SgState => structuredClone(state);

  function createRun(seed: unknown, config: unknown): SgState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return { tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules, play: newPlay() };
  }
  function advance(state: SgState, serverTick: number): SgState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: SgState, input: unknown, serverTick: number): SgState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) {
        state.started = true; state.startTick = state.tick;
        state.play.lastStep = state.tick;
        state.play.nextStep = state.tick + stepTicks(0);
        state.play.nextSpawn = state.tick + RULES.firstSpawnTicks;
      }
      return state;
    }
    if (!state.started) return state;
    if (action.action === 'sign') sign(state.play, action.x, action.y, action.dir);
    else clear(state.play, action.x, action.y);
    return state;
  }
  function applyInput(state: SgState, input: unknown, serverTick: number): SgState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: SgState): SgState => state;
  const isFinished = (state: SgState): boolean => state.gameOver;
  const score = (state: SgState): number => state.play.score;

  return { createRun, advance, applyInput, view, isFinished, score, advanceInPlace, applyInputInPlace, clone, endTickOf, signAt, step };
}
export type SignageEngine = ReturnType<typeof createEngine>;
