// NFT INVADERS: the deterministic rules, shared by the browser (prediction, practice) and the server verifier (zod-free).
//
// The wall's names sit along the bottom of the screen, the dragon stands guard in front of them and sprays upwards on
// its own. City cleaners with paint rollers hover in formation at the top, swaying, and peel off in diving runs at one
// of the names: a cleaner that reaches the wall whitewashes it, then flies back up to its place. Shoot them down.
// One input moves the dragon: { action: 'move', x }, where it should go. Everything else follows from the server tick
// and the seed. Integer arithmetic only (positions in logical pixels of a 420 × 800 board), a state that round-trips
// through JSON exactly, no clock, no network. The engine knows no name: the client hangs 8 names on the 8 bricks.
import { fnv1a, mulberry32 } from '../../common/det.js';

/* ================================ RULES ====================================
   Every server tick: the dragon walks towards its target, sprays when it may, shots fly up, drips fall, the
   formation sways, divers dive. A shot that meets a cleaner downs it: 50 in formation, 150 when diving or flying
   back, × the streak factor: 1 + ⌊streak / streakPerMult⌋ up to multCap, streak = cleaners downed since a name was
   last whitewashed (a whitewashed name resets it). A drip that meets the dragon stuns it (no walking, no spray) for `stunTicks`. A wave downed: 100 × standing
   names × the wave number (up to ×5), one whitewashed name repainted, and the next, larger wave after a short pause.
   The run ends when no name is left standing, at the server cap, or after `idleTicks` without any input (the dragon
   sprays by itself, so an abandoned run would otherwise go on: the idle limit also bounds the span one verifier call can
   be asked to simulate, under the platform's 10 ms CPU budget). */
export const RULES = {
  bricks: 8,
  formationCols: 6,
  speed: 40,                      // dragon, px per tick (800 px/s: it keeps up with a mouse)
  shotSpeed: 34, maxShots: 2, fireTicks: 7,
  dripSpeed: 12, stunTicks: 36,
  maxRows: 5,
  idleTicks: 600,                 // 30 s without an input ends the run (the page sends a keep-alive while played)
  formationPoints: 50, divePoints: 150, waveBonus: 100, waveCap: 5,
  streakPerMult: 8, multCap: 4,
  wavePauseTicks: 40,
  swayPeriod: 200, swayAmp: 30,
  returnSpeed: 12, steer: 5,
};
export const W = 420, H = 800;
export const SHIP_Y = 636, SHIP_HW = 22, SHIP_HH = 24;
export const WALL_Y = 700, BRICK_W = 52, BRICK_X0 = 2;
export const CLEANER_HW = 20, CLEANER_HH = 20;                // the 44 px character art (client) fits this box
export const FORM_X0 = 60, FORM_DX = 60, FORM_Y0 = 120, FORM_DY = 46;
export const ALL_BRICKS = (1 << RULES.bricks) - 1;
/** Cleaner modes. */
export const IN_FORMATION = 0, DIVING = 1, RETURNING = 2;

/* ============================ TYPES & VALIDATION ============================= */
/** The games these rules run: NFT INVADERS (XCOPY) and CC0 INVADERS (other CC0 collections), the same rules and verifier. */
export const WW_GAMES = ['whitewash', 'cc0-invaders'] as const;
export type WwGame = (typeof WW_GAMES)[number];
export type WwConfig = { game: WwGame; maxTicks: number; roundTicks: number };
export type Cleaner = {
  /** wave × 100 + slot: unique in a run (the client follows a cleaner by it). */
  id: number;
  /** Place in the formation: row × formationCols + column. */
  slot: number;
  mode: number;
  x: number; y: number;
  /** The brick a diver is heading for (-1 otherwise). */
  to: number;
  /** Server tick at which a diver lets its drip go (-1: none left). */
  dropAt: number;
};
export type Play = {
  x: number; target: number;
  stunUntil: number; fireAt: number;
  shots: [number, number][];
  drips: [number, number][];
  cleaners: Cleaner[];
  wave: number; waveStart: number;
  /** Tick the next wave arrives (while the screen is empty), else -1. */
  waveAt: number;
  dives: number; nextDive: number;
  /** Standing names: bit b = brick b. */
  bricks: number;
  score: number; downed: number; cleared: number; washed: number;
  /** Cleaners downed since a name was last whitewashed. */
  streak: number;
  /** Server tick of the last input (the start counts): the run ends `idleTicks` after it. */
  lastInput: number;
};
export type WwState = { tick: number; gameOver: boolean; started: boolean; startTick: number | null; seed: number; rules: WwConfig; play: Play };
export type WwInput = { action: 'start' } | { action: 'move'; x: number };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const MAX_INT = Number.MAX_SAFE_INTEGER;
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}
const fail = (what: string): never => { throw new Error(`Invalid NFT INVADERS ${what}`); };
const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && isInt(p[0], -100, W + 100) && isInt(p[1], -200, H + 200);

export function parseSeed(seed: unknown): number { return isInt(seed, 0, 0xffffffff) ? seed : fail('seed'); }
/** The scoring config (extra keys are dropped, like a non-strict object schema). */
export function parseConfig(value: unknown): WwConfig {
  if (!isObject(value) || !WW_GAMES.includes(value.game as WwGame) || !isInt(value.maxTicks, 1, 100_000) || !isInt(value.roundTicks, 1, 100_000)
    || value.maxTicks < value.roundTicks) return fail('config');
  return { game: value.game as WwGame, maxTicks: value.maxTicks, roundTicks: value.roundTicks };
}
/** An input, or null when it is not one (unknown action, extra field, out-of-range number). */
export function parseInput(value: unknown): WwInput | null {
  if (!isObject(value)) return null;
  if (value.action === 'start') return exactKeys(value, ['action']) ? { action: 'start' } : null;
  if (value.action === 'move' && exactKeys(value, ['action', 'x']) && isInt(value.x, 0, W)) return { action: 'move', x: value.x };
  return null;
}
const CLEANER_KEYS = ['id', 'slot', 'mode', 'x', 'y', 'to', 'dropAt'] as const;
const PLAY_KEYS = ['x', 'target', 'stunUntil', 'fireAt', 'shots', 'drips', 'cleaners', 'wave', 'waveStart', 'waveAt', 'dives', 'nextDive', 'bricks', 'score', 'downed', 'cleared', 'washed', 'streak', 'lastInput'] as const;
const STATE_KEYS = ['tick', 'gameOver', 'started', 'startTick', 'seed', 'rules', 'play'] as const;
const MAX_CLEANERS = RULES.formationCols * RULES.maxRows;
/** A run state as the coordinator hands it back: strict shape, bounded numbers, a coherent timeline. Throws otherwise. */
export function checkState(value: unknown): WwState {
  if (!isObject(value) || !exactKeys(value, STATE_KEYS)) return fail('state');
  const p = value.play;
  if (!isObject(p) || !exactKeys(p, PLAY_KEYS)) return fail('state');
  const { shots, drips, cleaners } = p;
  if (!Array.isArray(shots) || shots.length > RULES.maxShots || !shots.every(isPoint)) return fail('state');
  if (!Array.isArray(drips) || drips.length > MAX_CLEANERS || !drips.every(isPoint)) return fail('state');
  if (!Array.isArray(cleaners) || cleaners.length > MAX_CLEANERS) return fail('state');
  const slots = new Set<number>();
  for (const c of cleaners) {
    if (!isObject(c) || !exactKeys(c, CLEANER_KEYS) || !isInt(c.id, 0, 10_000_000) || !isInt(c.slot, 0, MAX_CLEANERS - 1) || slots.has(c.slot)
      || !isInt(c.mode, 0, 2) || !isInt(c.x, -100, W + 100) || !isInt(c.y, -200, H + 200) || !isInt(c.to, -1, RULES.bricks - 1)
      || !isInt(c.dropAt, -1, MAX_INT) || (c.mode === DIVING) !== (c.to >= 0)) return fail('state');
    slots.add(c.slot);
  }
  if (!isInt(p.x, 0, W) || !isInt(p.target, 0, W) || !isInt(p.stunUntil, 0, MAX_INT) || !isInt(p.fireAt, 0, MAX_INT)
    || !isInt(p.wave, 0, 1_000_000) || !isInt(p.waveStart, 0, MAX_INT) || !isInt(p.waveAt, -1, MAX_INT)
    || !isInt(p.dives, 0, 10_000_000) || !isInt(p.nextDive, 0, MAX_INT) || !isInt(p.bricks, 0, ALL_BRICKS)
    || !isInt(p.score, 0, MAX_INT) || !isInt(p.downed, 0, 10_000_000) || !isInt(p.cleared, 0, 1_000_000) || !isInt(p.washed, 0, 10_000_000)
    || !isInt(p.streak, 0, 10_000_000) || !isInt(p.lastInput, 0, MAX_INT)) return fail('state');
  const { tick, gameOver, started, startTick, seed } = value;
  if (!isInt(tick, 0, MAX_INT) || typeof gameOver !== 'boolean' || typeof started !== 'boolean'
    || (startTick !== null && !isInt(startTick, 0, MAX_INT)) || !isInt(seed, 0, 0xffffffff)) return fail('state');
  const rules = parseConfig(value.rules);
  // a run not over is before its end: the cap, the round, the idle limit (the engine never hands back anything else)
  const end = startTick === null ? rules.maxTicks : Math.min(rules.maxTicks, startTick + rules.roundTicks, p.lastInput + RULES.idleTicks);
  if (started !== (startTick !== null) || (startTick !== null && startTick > tick) || tick > rules.maxTicks
    || (p.bricks === 0 && !gameOver) || (startTick !== null && (p.lastInput < startTick || p.lastInput > tick))
    || (!gameOver && tick >= end)) return fail('timeline');
  return {
    tick, gameOver, started, startTick, seed, rules,
    play: {
      x: p.x, target: p.target, stunUntil: p.stunUntil, fireAt: p.fireAt,
      shots: shots.map((s) => [s[0], s[1]] as [number, number]), drips: drips.map((d) => [d[0], d[1]] as [number, number]),
      cleaners: cleaners.map((c) => ({ id: c.id, slot: c.slot, mode: c.mode, x: c.x, y: c.y, to: c.to, dropAt: c.dropAt } as Cleaner)),
      wave: p.wave, waveStart: p.waveStart, waveAt: p.waveAt, dives: p.dives, nextDive: p.nextDive, bricks: p.bricks,
      score: p.score, downed: p.downed, cleared: p.cleared, washed: p.washed, streak: p.streak, lastInput: p.lastInput,
    },
  };
}

/* ================================ GEOMETRY ================================== */
export const brickCenter = (b: number): number => BRICK_X0 + b * BRICK_W + BRICK_W / 2;
/** The formation's sideways offset, `t` ticks into a wave: a triangle wave of ±swayAmp. */
export function sway(t: number): number {
  const half = RULES.swayPeriod / 2, p = t % RULES.swayPeriod;
  const u = p < half ? p : RULES.swayPeriod - p;                 // 0 .. half .. 0
  return Math.floor((u * 2 * RULES.swayAmp) / half) - RULES.swayAmp;
}
export const slotX = (slot: number, t: number): number => FORM_X0 + (slot % RULES.formationCols) * FORM_DX + sway(t);
export const slotY = (slot: number): number => FORM_Y0 + Math.floor(slot / RULES.formationCols) * FORM_DY;
/** Rows of raiders in wave `n` (1-based): 3, 3, 4, 4, 5, … */
export const waveRows = (n: number): number => Math.min(RULES.maxRows, 3 + Math.floor((n - 1) / 2));
/** Divers in the air at once (2, 2, 3, 3, … 5), ticks between two dives, a diver's speed, ticks between its drips. */
export const maxDivers = (n: number): number => Math.min(5, 2 + Math.floor((n - 1) / 2));
export const diveTicks = (n: number): number => Math.max(12, 48 - 5 * n);
export const diveSpeed = (n: number): number => Math.min(18, 8 + n);
export const dripTicks = (n: number): number => Math.max(10, 22 - 2 * n);
/** The streak factor after `streak` cleaners downed without a name lost: ×1 … ×multCap. */
export const streakMult = (streak: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(streak / RULES.streakPerMult));
export const bitCount = (v: number): number => { let n = 0; while (v) { v &= v - 1; n++; } return n; };

/* ================================ ENGINE ==================================== */
export function createEngine() {
  function newPlay(): Play {
    return {
      x: W / 2, target: W / 2, stunUntil: 0, fireAt: 0, shots: [], drips: [], cleaners: [],
      wave: 0, waveStart: 0, waveAt: -1, dives: 0, nextDive: 0, bricks: ALL_BRICKS, score: 0, downed: 0, cleared: 0, washed: 0, streak: 0, lastInput: 0,
    };
  }
  function startWave(play: Play, tick: number): void {
    play.wave++; play.waveStart = tick; play.waveAt = -1;
    const n = waveRows(play.wave) * RULES.formationCols;
    play.cleaners = Array.from({ length: n }, (_, slot) => ({ id: play.wave * 100 + slot, slot, mode: IN_FORMATION, x: slotX(slot, 0), y: slotY(slot), to: -1, dropAt: -1 }));
    play.nextDive = tick + diveTicks(play.wave) + 20;
  }
  /** Dive number `k` of a run: which cleaner in formation goes and at which standing name, from (seed, k) only. */
  function launchDive(state: WwState): void {
    const play = state.play;
    const ready = play.cleaners.filter((c) => c.mode === IN_FORMATION);
    const flying = play.cleaners.length - ready.length;
    if (!ready.length || flying >= maxDivers(play.wave) || play.bricks === 0) return;
    const rnd = mulberry32(fnv1a(`whitewash:${state.seed}:dive:${play.dives}`));
    play.dives++;
    const c = ready[Math.floor(rnd() * ready.length)] as Cleaner;
    const standing: number[] = [];
    for (let b = 0; b < RULES.bricks; b++) if (play.bricks & (1 << b)) standing.push(b);
    c.mode = DIVING; c.to = standing[Math.floor(rnd() * standing.length)] as number;
    c.dropAt = state.tick + 8 + Math.floor(rnd() * 16);
  }
  const hitsBox = (px: number, py0: number, py1: number, cx: number, cy: number, hw: number, hh: number): boolean =>
    px >= cx - hw - 3 && px <= cx + hw + 3 && py1 >= cy - hh && py0 <= cy + hh;

  /** One server tick of the world. */
  function tickOnce(state: WwState): void {
    const play = state.play, t = state.tick;
    // the dragon walks, unless stunned, and sprays when it may
    if (t >= play.stunUntil) {
      const d = play.target - play.x;
      play.x += d > RULES.speed ? RULES.speed : (d < -RULES.speed ? -RULES.speed : d);
      if (t >= play.fireAt && play.shots.length < RULES.maxShots && play.cleaners.length) {
        play.shots.push([play.x, SHIP_Y - SHIP_HH]); play.fireAt = t + RULES.fireTicks;
      }
    }
    // the formation sways; divers dive, drip, whitewash, fly back
    const ft = t - play.waveStart;
    for (const c of play.cleaners) {
      const hx = slotX(c.slot, ft), hy = slotY(c.slot);
      if (c.mode === IN_FORMATION) { c.x = hx; c.y = hy; continue; }
      if (c.mode === DIVING) {
        const d = brickCenter(c.to) - c.x;
        c.x += d > RULES.steer ? RULES.steer : (d < -RULES.steer ? -RULES.steer : d);
        c.y += diveSpeed(play.wave);
        if (c.dropAt >= 0 && t >= c.dropAt) {                                   // it drips on the way down, again and again
          if (c.y < SHIP_Y - 80) { play.drips.push([c.x, c.y + CLEANER_HH]); c.dropAt = t + dripTicks(play.wave); } else c.dropAt = -1;
        }
        if (c.y >= WALL_Y) {
          if (play.bricks & (1 << c.to)) { play.bricks &= ~(1 << c.to); play.washed++; play.streak = 0; }
          c.mode = RETURNING; c.to = -1; c.dropAt = -1;
        }
        continue;
      }
      // returning: straight back up to its place
      const dx = hx - c.x;
      c.x += dx > RULES.steer ? RULES.steer : (dx < -RULES.steer ? -RULES.steer : dx);
      c.y -= RULES.returnSpeed;
      if (c.y <= hy) { c.y = hy; c.x = hx; c.mode = IN_FORMATION; }
    }
    // shots fly up and meet the lowest cleaner in their path (kept in place: no allocation per tick)
    let kept = 0;
    for (let k = 0; k < play.shots.length; k++) {
      const s = play.shots[k] as [number, number], y1 = s[1], y0 = s[1] - RULES.shotSpeed;
      let hit = -1, hitY = -Infinity;
      for (let i = 0; i < play.cleaners.length; i++) {
        const c = play.cleaners[i] as Cleaner;
        if (c.y > hitY && hitsBox(s[0], y0, y1, c.x, c.y, CLEANER_HW, CLEANER_HH)) { hit = i; hitY = c.y; }
      }
      if (hit >= 0) {
        const c = play.cleaners[hit] as Cleaner;
        play.score += (c.mode === IN_FORMATION ? RULES.formationPoints : RULES.divePoints) * streakMult(play.streak);
        play.streak++;
        play.downed++;
        play.cleaners.splice(hit, 1);
      } else if (y0 > 40) { s[1] = y0; play.shots[kept++] = s; }
    }
    play.shots.length = kept;
    // drips fall; one on the dragon stuns it
    kept = 0;
    for (let k = 0; k < play.drips.length; k++) {
      const d = play.drips[k] as [number, number], y0 = d[1], y1 = d[1] + RULES.dripSpeed;
      if (t >= play.stunUntil && hitsBox(d[0], y0, y1, play.x, SHIP_Y, SHIP_HW, SHIP_HH)) { play.stunUntil = t + RULES.stunTicks; continue; }
      if (y1 < WALL_Y) { d[1] = y1; play.drips[kept++] = d; }
    }
    play.drips.length = kept;
    if (play.bricks === 0) { state.gameOver = true; return; }
    // a wave downed: the bonus, one name repainted, a pause, the next wave
    if (play.waveAt < 0 && play.cleaners.length === 0) {
      play.score += RULES.waveBonus * bitCount(play.bricks) * Math.min(play.wave, RULES.waveCap);
      play.cleared++;
      for (let b = 0; b < RULES.bricks; b++) if (!(play.bricks & (1 << b))) { play.bricks |= 1 << b; break; }
      play.shots = []; play.drips = [];
      play.waveAt = t + RULES.wavePauseTicks;
    } else if (play.waveAt >= 0 && t >= play.waveAt) startWave(play, t);
    else if (play.waveAt < 0 && t >= play.nextDive) { launchDive(state); play.nextDive = t + diveTicks(play.wave); }
  }

  /* ----------------------- run lifecycle (coordinator contract) ----------------------- */
  function endTickOf(state: WwState): number {
    return state.startTick === null ? state.rules.maxTicks
      : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks, state.play.lastInput + RULES.idleTicks);
  }
  /** Mutating advance (the browser's prediction uses it directly): one pass of the world per server tick. */
  function advanceInPlace(state: WwState, serverTick: number): WwState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver) return state;
    const endTick = endTickOf(state);
    const target = Math.min(serverTick, endTick);
    if (!state.started) state.tick = target;
    while (state.tick < target && !state.gameOver) { state.tick++; tickOnce(state); }
    if (state.tick >= endTick) { state.tick = endTick; state.gameOver = true; }
    return state;
  }
  const clone = (state: WwState): WwState => structuredClone(state);

  function createRun(seed: unknown, config: unknown): WwState {
    const validSeed = parseSeed(seed);
    const rules = parseConfig(config);
    return { tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules, play: newPlay() };
  }
  function advance(state: WwState, serverTick: number): WwState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: WwState, input: unknown, serverTick: number): WwState {
    advanceInPlace(state, serverTick);
    if (state.gameOver) return state;
    const action = parseInput(input);
    if (!action) return state;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; state.play.lastInput = state.tick; startWave(state.play, state.tick); state.play.fireAt = state.tick + 10; }
      return state;
    }
    if (!state.started) return state;
    state.play.target = Math.max(SHIP_HW, Math.min(W - SHIP_HW, action.x));   // the dragon stays whole on screen
    state.play.lastInput = state.tick;                                         // a move to where it already goes keeps the run alive
    return state;
  }
  function applyInput(state: WwState, input: unknown, serverTick: number): WwState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: WwState): WwState => state;
  const isFinished = (state: WwState): boolean => state.gameOver;
  const score = (state: WwState): number => state.play.score;

  return { createRun, advance, applyInput, view, isFinished, score, advanceInPlace, applyInputInPlace, clone, endTickOf, tickOnce };
}
export type WhitewashEngine = ReturnType<typeof createEngine>;
