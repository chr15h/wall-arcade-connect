// UNBREAKABLE on Connect: the deterministic simulation, shared by the browser (prediction) and the server verifier.
//
// This is the v5.1 Ballz-style simulation (makeSim in wall-arcade/games/unbreakable/src.html) ported to a plain,
// JSON-serialisable state so that Studio's coordinator can own it: it advances on server ticks (50 ms), takes ordered
// inputs (one shot angle per turn) and only the verifier's `score` is official. Same arithmetic as the original,
// step for step (180 Hz fixed step = 9 steps per server tick), checked against the original by tests/unbreakable.test.ts.
import * as z from 'zod/mini';
import { fnv1a, mulberry32, sinCos100 } from '../../common/det.js';

/* ================================ RULES ====================================
   Unchanged from v5.1 except what the server clock replaces: no pause, no ">>" fast-forward (ball flight takes the
   same server time for everyone). Names come out of `elig`, a build-time snapshot of the wall's named panels. */
export const RULES = {
  cols: 7,
  brickP: 0.45, doubleP: 0.20,
  rampStartRow: 10, rampEndRow: 30, brickPMax: 0.65, doubleMax: 0.45, plusMin: 0.40,
  startBalls: 1,
  ballR: 5, ballSpeed: 980, stepHz: 180, fireGapSteps: 9, minAngleDeg: 8, brickInset: 3, plusR: 14,
  maxBallSec: 20,
  wallBias: 1.2, wallBottomRowHigh: true,
} as const;

export const TICK_MS = 50;
export const STEPS_PER_TICK = (RULES.stepHz * TICK_MS) / 1000;      // 9: a whole number, so ticks and steps stay aligned
/** CPU guard: one advance() call simulates at most this many flight ticks (the platform allows ~10 ms CPU / call). */
export const MAX_FLIGHT_TICKS_PER_CALL = 160;

/* ================================ GEOMETRY ================================== */
export const W = 420, COLS = RULES.cols, CELL = W / COLS;            // 60 px cells
export const HDR = 40, NOW_Y = 44, GT = 82;
export const ROWS_V = 9, END_ROW = 9;                                // rows 0..8 visible, row 9 = end line
export const FLOOR = GT + (ROWS_V + 1) * CELL;
export const R = RULES.ballR;
const DT = 1 / RULES.stepHz, SPEED = RULES.ballSpeed;
const MIN_VY = SPEED * sinCos100(RULES.minAngleDeg * 100)[0];
export const MIN_ANGLE = RULES.minAngleDeg * 100, MAX_ANGLE = 18000 - MIN_ANGLE;
const MAX_BALL_STEPS = RULES.maxBallSec * RULES.stepHz;

/* ================================ SCHEMAS =================================== */
const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const finite = z.number().check(z.refine((v) => Number.isFinite(v), 'must be finite'));

export const configSchema = z.object({
  game: z.literal('unbreakable'),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));
export type UbConfig = z.infer<typeof configSchema>;

const brickSchema = z.strictObject({ t: z.literal(1), hp: posInt.check(z.lte(1_000_000)), hp0: posInt.check(z.lte(1_000_000)), pos: nonNegInt.check(z.lte(550)) });
const plusSchema = z.strictObject({ t: z.literal(3) });
const cellSchema = z.nullable(z.discriminatedUnion('t', [brickSchema, plusSchema]));
const rowSchema = z.strictObject({ n: posInt.check(z.lte(1_000_000)), cells: z.array(cellSchema).check(z.length(COLS)) });
const ballSchema = z.strictObject({ x: finite, y: finite, vx: finite, vy: finite, land: z.boolean(), age: nonNegInt });
const simSchema = z.strictObject({
  rows: z.array(rowSchema).check(z.maxLength(END_ROW + 1)),
  turn: posInt, nBalls: posInt.check(z.lte(100_000)), originX: finite,
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  balls: z.array(ballSchema).check(z.maxLength(1_000)),
  toFire: nonNegInt, fireCd: nonNegInt, dx: finite, dy: finite, plusGot: nonNegInt,
  firstLandX: z.nullable(finite), turnSteps: nonNegInt,
  score: nonNegInt, broken: nonNegInt, recalls: nonNegInt, round: nonNegInt, seqPos: nonNegInt, shots: nonNegInt,
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  seed: z.uint32(), rules: configSchema, sim: simSchema,
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks, 'Invalid UNBREAKABLE timeline'));
export type UbState = z.infer<typeof stateSchema>;
export type Sim = UbState['sim'];
export type Cell = NonNullable<Sim['rows'][number]['cells'][number]>;

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('fire'), angle: z.int().check(z.gte(MIN_ANGLE), z.lte(MAX_ANGLE)) }),
]);
export type UbInput = z.infer<typeof inputSchema>;

/* The coordinator's snapshot envelope (same shape as the upstream examples; only `state` differs). */
const finalScoreSchema = z.union([nonNegInt, z.pipe(z.pipe(z.string().check(z.regex(/^\d+$/)), z.transform(Number)), nonNegInt)]);
const finalResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: finalScoreSchema, status: z.optional(z.string()) });
const expiredResultSchema = z.looseObject({ runId: z.optional(z.uuid()), score: z.optional(z.never()), status: z.literal('expired') });
export const snapshotSchema = z.union([
  z.object({
    runId: z.uuid(), configDigest: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
    serverTick: nonNegInt, inputSeq: nonNegInt, inputTick: z.int().check(z.gte(-1)),
    expiresAt: z.string().check(z.refine((v) => Number.isFinite(Date.parse(v)), 'Invalid expiry')),
    state: stateSchema,
    result: z.nullable(z.union([finalResultSchema, expiredResultSchema])),
    status: z.optional(z.string()),
  }),
  z.object({ error: z.string(), serverTick: z.optional(nonNegInt) }),
]);

/* ================================ ENGINE ==================================== */
export type SimEvent = 'brick' | 'break' | 'plus' | 'fire' | 'turn';
export type EventSink = (type: SimEvent, a?: number, b?: number, c?: number) => void;

export function createEngine(elig: readonly number[]) {
  // Order in which the names of the wall come out (one name per brick): bottom rows of the physical wall first.
  // Deterministic per run seed and round; arithmetic only, so exactly reproducible.
  let cacheKey = '', cacheSeq: number[] = [0];
  function seqFor(seed: number, round: number): number[] {
    const key = seed + ':' + round;
    if (key === cacheKey) return cacheSeq;
    let out: number[];
    if (!elig.length) out = [0];
    else {
      const rnd = mulberry32(fnv1a('r' + seed + ':names:' + round));
      const keyed = elig.map((pos) => {
        let rn = pos > 500 ? 0 : Math.floor((pos - 1) / 25) / 19;     // 0 = top of the wall, 1 = bottom (PFPs sit above the names)
        if (pos <= 500 && !RULES.wallBottomRowHigh) rn = 1 - rn;
        return { pos, key: (1 - rn) * RULES.wallBias + rnd() };
      });
      keyed.sort((a, b) => (a.key - b.key) || (a.pos - b.pos));
      out = keyed.map((k) => k.pos);
    }
    cacheKey = key; cacheSeq = out;
    return out;
  }

  function nextPos(S: Sim, seed: number): number {
    let seq = seqFor(seed, S.round);
    if (S.seqPos >= seq.length) { S.round++; S.seqPos = 0; seq = seqFor(seed, S.round); }
    return seq[S.seqPos++] as number;
  }

  function genRow(S: Sim, seed: number, n: number): Sim['rows'][number] {
    const rnd = mulberry32(fnv1a('r' + seed + ':' + n));
    // linear ramp (arithmetic only: exact everywhere); rows up to rampStartRow are the early game, draw for draw
    let t = (n - RULES.rampStartRow) / (RULES.rampEndRow - RULES.rampStartRow); t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const bp = RULES.brickP + t * (RULES.brickPMax - RULES.brickP);
    const dp = RULES.doubleP + t * (RULES.doubleMax - RULES.doubleP);
    const pp = 1 - t * (1 - RULES.plusMin);
    const cells: Sim['rows'][number]['cells'] = [], empties: number[] = [];
    for (let j = 0; j < COLS; j++) {
      if (rnd() < bp) {
        const hp = rnd() < dp ? 2 * n : n;
        cells.push({ t: 1, hp, hp0: hp, pos: nextPos(S, seed) });
      } else { cells.push(null); empties.push(j); }
    }
    if (empties.length && (pp >= 1 || rnd() < pp)) cells[empties[Math.floor(rnd() * empties.length)] as number] = { t: 3 };     // a +1 in an empty cell (rarer with depth)
    return { n, cells };
  }

  function newSim(seed: number): Sim {
    const S: Sim = {
      rows: [], turn: 1, nBalls: RULES.startBalls, originX: W / 2, phase: 0, balls: [], toFire: 0, fireCd: 0,
      dx: 0, dy: -1, plusGot: 0, firstLandX: null, turnSteps: 0, score: 0, broken: 0, recalls: 0, round: 0, seqPos: 0, shots: 0,
    };
    S.rows.push(genRow(S, seed, 1));
    return S;
  }

  const rectOf = (r: number, c: number): [number, number, number, number] => {
    const i = RULES.brickInset;
    return [c * CELL + i, GT + r * CELL + i, (c + 1) * CELL - i, GT + (r + 1) * CELL - i];
  };

  /** One fixed 1/180 s step (the original S.step(), minus the cosmetic step counter and flash). */
  function step(S: Sim, seed: number, ev?: EventSink): void {
    if (S.phase !== 1) return;
    S.turnSteps++;
    if (S.toFire > 0) {
      if (S.fireCd <= 0) {
        S.balls.push({ x: S.originX, y: FLOOR - R, vx: S.dx * SPEED, vy: S.dy * SPEED, land: false, age: 0 });
        S.toFire--; S.fireCd = RULES.fireGapSteps; if (ev) ev('fire');
      } else S.fireCd--;
    }
    let flying = 0;
    for (const b of S.balls) { if (b.land) continue; moveBall(S, b, ev); if (!b.land) flying++; }
    if (S.toFire === 0 && flying === 0) endTurn(S, seed, ev);
  }

  function land(S: Sim, b: Sim['balls'][number]): void {
    b.y = FLOOR - R; b.vx = 0; b.vy = 0; b.land = true;
    if (S.firstLandX === null) S.firstLandX = b.x < R ? R : (b.x > W - R ? W - R : b.x);
  }
  function fixVelocity(b: Sim['balls'][number]): void {            // constant speed, minimum angle
    let s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (s === 0) { b.vx = 0; b.vy = -SPEED; s = SPEED; }
    const k = SPEED / s; b.vx *= k; b.vy *= k;
    if (b.vy > -MIN_VY && b.vy < MIN_VY) {
      b.vy = b.vy < 0 || b.vy === 0 ? -MIN_VY : MIN_VY;
      const ax = Math.sqrt(SPEED * SPEED - MIN_VY * MIN_VY); b.vx = b.vx < 0 ? -ax : ax;
    }
  }
  function moveBall(S: Sim, b: Sim['balls'][number], ev?: EventSink): void {
    if (++b.age > MAX_BALL_STEPS) { S.recalls++; land(S, b); return; }
    b.x += b.vx * DT; b.y += b.vy * DT;
    let bounced = false;
    if (b.x < R) { b.x = R; b.vx = b.vx < 0 ? -b.vx : b.vx; bounced = true; }
    else if (b.x > W - R) { b.x = W - R; b.vx = b.vx > 0 ? -b.vx : b.vx; bounced = true; }
    if (b.y < GT + R) { b.y = GT + R; b.vy = b.vy < 0 ? -b.vy : b.vy; bounced = true; }
    if (b.vy > 0 && b.y >= FLOOR - R) { land(S, b); return; }
    const c0 = Math.max(0, Math.floor((b.x - R) / CELL)), c1 = Math.min(COLS - 1, Math.floor((b.x + R) / CELL));
    const r0 = Math.max(0, Math.floor((b.y - R - GT) / CELL)), r1 = Math.min(S.rows.length - 1, Math.floor((b.y + R - GT) / CELL));
    let best: Cell | null = null, bd = 1e18, bnx = 0, bny = 0, bpush = 0, br = 0, bc = 0;
    for (let r = r0; r <= r1; r++) {
      const row = S.rows[r] as Sim['rows'][number];
      for (let c = c0; c <= c1; c++) {
        const cell = row.cells[c]; if (!cell) continue;
        if (cell.t === 3) {
          const dx = b.x - (c + 0.5) * CELL, dy = b.y - (GT + (r + 0.5) * CELL), rr = RULES.plusR + R;
          if (dx * dx + dy * dy < rr * rr) { row.cells[c] = null; S.plusGot++; if (ev) ev('plus', r, c); }
          continue;
        }
        const q = rectOf(r, c);
        const cx = b.x < q[0] ? q[0] : (b.x > q[2] ? q[2] : b.x), cy = b.y < q[1] ? q[1] : (b.y > q[3] ? q[3] : b.y);
        const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
        if (d2 < R * R && d2 < bd) {
          bd = d2; best = cell; br = r; bc = c;
          if (d2 > 0) { const d = Math.sqrt(d2); bnx = dx / d; bny = dy / d; bpush = d; }
          else {                                                   // centre inside: nearest face
            const l = b.x - q[0], rt = q[2] - b.x, t = b.y - q[1], bt = q[3] - b.y;
            let m = l; bnx = -1; bny = 0;
            if (rt < m) { m = rt; bnx = 1; bny = 0; } if (t < m) { m = t; bnx = 0; bny = -1; } if (bt < m) { m = bt; bnx = 0; bny = 1; }
            bpush = -m;
          }
        }
      }
    }
    if (best && best.t === 1) {
      const dot = b.vx * bnx + b.vy * bny;
      if (dot < 0) { b.vx -= 2 * dot * bnx; b.vy -= 2 * dot * bny; }
      const push = R - bpush + 0.02; b.x += bnx * push; b.y += bny * push;
      bounced = true; best.hp--; S.score++;
      if (ev) ev('brick', br, bc, best.pos);
      if (best.hp <= 0) { (S.rows[br] as Sim['rows'][number]).cells[bc] = null; S.broken++; if (ev) ev('break', br, bc, best.pos); }
    }
    if (bounced) fixVelocity(b);
  }
  function descend(S: Sim, seed: number): void {
    S.rows.unshift(genRow(S, seed, S.turn));
    if (S.rows.length > END_ROW + 1) S.rows.pop();
    const endRow = S.rows[END_ROW];
    if (endRow) for (const cell of endRow.cells) if (cell && cell.t === 1) { S.phase = 2; return; }
  }
  function endTurn(S: Sim, seed: number, ev?: EventSink): void {
    S.originX = S.firstLandX === null ? S.originX : S.firstLandX;
    S.nBalls += S.plusGot; S.plusGot = 0; S.balls = []; S.firstLandX = null; S.turnSteps = 0;
    S.turn++; S.phase = 0; descend(S, seed);
    if (ev) ev('turn', S.turn);
  }

  /** a100: shot angle in hundredths of a degree, 0 = right, 9000 = straight up. False when a shot is not allowed. */
  function fire(S: Sim, a100: number, ev?: EventSink): boolean {
    if (S.phase !== 0) return false;
    a100 = a100 < MIN_ANGLE ? MIN_ANGLE : (a100 > MAX_ANGLE ? MAX_ANGLE : a100);
    const sc = sinCos100(a100); S.dx = sc[1]; S.dy = -sc[0];
    S.toFire = S.nBalls; S.fireCd = 0; S.phase = 1; S.turnSteps = 0; S.shots++;
    void ev;
    return true;
  }

  /** Where a shot from the origin first bounces (aim line, client only). */
  function probe(S: Sim, a100: number): [number, number] {
    a100 = a100 < MIN_ANGLE ? MIN_ANGLE : (a100 > MAX_ANGLE ? MAX_ANGLE : a100);
    const sc = sinCos100(a100), dx = sc[1], dy = -sc[0];
    let x = S.originX, y = FLOOR - R;
    for (let i = 0; i < 1200; i++) {
      x += dx * 3; y += dy * 3;
      if (x < R || x > W - R || y < GT + R) return [x, y];
      const c0 = Math.max(0, Math.floor((x - R) / CELL)), c1 = Math.min(COLS - 1, Math.floor((x + R) / CELL));
      const r0 = Math.max(0, Math.floor((y - R - GT) / CELL)), r1 = Math.min(S.rows.length - 1, Math.floor((y + R - GT) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const cell = (S.rows[r] as Sim['rows'][number]).cells[c]; if (!cell || cell.t === 3) continue;
        const q = rectOf(r, c), cx = x < q[0] ? q[0] : (x > q[2] ? q[2] : x), cy = y < q[1] ? q[1] : (y > q[3] ? q[3] : y);
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) < R * R) return [x, y];
      }
    }
    return [x, y];
  }

  /* ----------------------- run lifecycle (coordinator contract) ----------------------- */
  function endTickOf(state: UbState): number {
    return state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);
  }

  /** One server tick of simulation: STEPS_PER_TICK fixed steps; steps after the turn ends are no-ops. */
  function runTick(S: Sim, seed: number, ev?: EventSink): void {
    for (let i = 0; i < STEPS_PER_TICK && S.phase === 1; i++) step(S, seed, ev);
  }

  /** Mutating advance (browser prediction uses it directly). Returns the tick actually reached. */
  function advanceInPlace(state: UbState, serverTick: number, ev?: EventSink): UbState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    const endTick = endTickOf(state);
    const target = Math.min(serverTick, endTick);
    const S = state.sim;
    let flightTicks = 0;
    while (state.tick < target) {
      if (state.started && S.phase === 1) {
        // the platform's CPU budget is per call: leave the rest for the next call unless this call must reach the deadline
        if (flightTicks >= MAX_FLIGHT_TICKS_PER_CALL && target < endTick) return state;
        state.tick++; flightTicks++;
        runTick(S, state.seed, ev);
        if ((S.phase as number) === 2) { state.gameOver = true; return state; }
      } else { state.tick = target; }
    }
    if (state.tick >= endTick) state.gameOver = true;
    return state;
  }

  function clone(state: UbState): UbState { return structuredClone(state); }

  function createRun(seed: unknown, config: unknown): UbState {
    const validSeed = z.uint32().parse(seed);
    const rules = configSchema.parse(config);
    return { tick: 0, gameOver: false, started: false, startTick: null, seed: validSeed, rules, sim: newSim(validSeed) };
  }
  function advance(state: UbState, serverTick: number): UbState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    return advanceInPlace(clone(state), serverTick);
  }
  function applyInputInPlace(state: UbState, input: unknown, serverTick: number, ev?: EventSink): UbState {
    advanceInPlace(state, serverTick, ev);
    if (state.gameOver) return state;
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return state;
    const action = parsed.data;
    if (action.action === 'start') {
      if (!state.started) { state.started = true; state.startTick = state.tick; }
      return state;
    }
    if (!state.started) return state;
    fire(state.sim, action.angle, ev);
    return state;
  }
  function applyInput(state: UbState, input: unknown, serverTick: number): UbState {
    return applyInputInPlace(clone(state), input, serverTick);
  }
  const view = (state: UbState): UbState => state;
  const isFinished = (state: UbState): boolean => state.gameOver;
  const score = (state: UbState): number => state.sim.score;

  return {
    createRun, advance, applyInput, view, isFinished, score,
    advanceInPlace, applyInputInPlace, newSim, step, fire, probe, runTick, clone, endTickOf, seqFor,
  };
}
export type UnbreakableEngine = ReturnType<typeof createEngine>;
