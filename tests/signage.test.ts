import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/common/det.js';
import {
  BOTTOM, COLS, DELIVERED, GAVE_UP, LEFT, RULES, checkState, createEngine, deliveryPoints, inputSchema, parseInput, snapshotSchema,
  spawnOf, spawnTicks, stateSchema, stepTicks, type SgState, type Walker,
} from '../src/games/signage/engine.js';
import { STRETCHES, bricksFor } from '../src/games/signage/names.js';
import { WALL_PANELS } from '../src/generated/wall.js';
import { scoringConfiguration } from '../src/shell/config.js';

const engine = createEngine();
const CONFIG = scoringConfiguration('signage');
const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const started = (seed: number, tick = 0): SgState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, tick);
/** A started run with hand-placed walkers and no spawn before `quietUntil` (the rules only ever see the play). */
function plaza(walkers: Walker[], signs: [number, number][] = [], quietUntil = 100_000): SgState {
  const state = started(1);
  state.play.walkers = walkers.map((w) => ({ ...w }));
  state.play.spawned = walkers.length ? Math.max(...walkers.map((w) => w.id)) + 1 : 0;
  state.play.signs = signs.map((s) => [s[0], s[1]]);
  state.play.nextSpawn = quietUntil;
  return state;
}
const walker = (id: number, x: number, y: number, dir: number, to: number, life: number = RULES.patience): Walker => ({ id, x, y, dir, to, life });
/** Advances exactly `n` steps. */
function steps(state: SgState, n: number): SgState {
  let s = state;
  for (let i = 0; i < n && !s.gameOver; i++) s = engine.advance(s, s.play.nextStep);
  return s;
}
/** A bot that puts up a sign under every walker that needs one (a column turn on its spawn row, then up): ordered
 *  inputs at one tick each, the way the coordinator takes them. */
function botRun(seed: number, skill = 1): { inputs: { input: unknown; tick: number }[]; state: SgState } {
  const rnd = mulberry32(seed ^ 0x5161);
  let state = engine.createRun(seed, CONFIG);
  const inputs: { input: unknown; tick: number }[] = [{ input: { action: 'start' }, tick: 1 }];
  state = engine.applyInput(state, { action: 'start' }, 1);
  let tick = 1;
  while (!state.gameOver) {
    tick += 1;
    let input: Record<string, unknown> | null = null;
    for (const w of state.play.walkers) {
      if (rnd() > skill) continue;
      const want = w.x === w.to ? 0 : (w.to > w.x ? 1 : 3);
      if (w.y === BOTTOM && engine.signAt(state.play, w.y * COLS + w.x) !== want) { input = { action: 'sign', x: w.x, y: w.y, dir: want }; break; }
      if (w.x === w.to && w.dir !== 0 && engine.signAt(state.play, w.y * COLS + w.x) !== 0) { input = { action: 'sign', x: w.x, y: w.y, dir: 0 }; break; }
    }
    if (input) { inputs.push({ input, tick }); state = engine.applyInput(state, input, tick); } else state = engine.advance(state, tick);
  }
  return { inputs, state };
}

test('spawns: a pure function of (seed, k), never the brick straight ahead, every column and every brick used', () => {
  const cols = new Set<number>(), tos = new Set<number>();
  for (let k = 0; k < 400; k++) {
    const a = spawnOf(77, k), b = spawnOf(77, k);
    assert.deepEqual(a, b);
    assert.ok(a.x >= 0 && a.x < COLS && a.to >= 0 && a.to < COLS && a.to !== a.x);
    cols.add(a.x); tos.add(a.to);
  }
  assert.equal(cols.size, COLS); assert.equal(tos.size, COLS);
  assert.notDeepEqual([0, 1, 2, 3].map((k) => spawnOf(1, k)), [0, 1, 2, 3].map((k) => spawnOf(2, k)), 'another seed, another crowd');
});

test('timing: steps from 350 ms down to 150 ms, walkers from 3.5 s down to 0.7 s', () => {
  assert.equal(stepTicks(0), 7); assert.equal(stepTicks(899), 7); assert.equal(stepTicks(900), 6); assert.equal(stepTicks(100_000), 3);
  assert.equal(spawnTicks(0), 70); assert.equal(spawnTicks(60), 69); assert.equal(spawnTicks(100_000), 14);
  const s = started(9, 5);
  assert.equal(s.play.nextStep, 12); assert.equal(s.play.nextSpawn, 25); assert.equal(s.play.lastStep, 5);
  const first = engine.advance(s, 25);
  assert.equal(first.play.walkers.length, 1); assert.equal(first.play.walkers[0]!.y, BOTTOM);
  assert.equal(first.play.walkers[0]!.x, spawnOf(9, 0).x); assert.equal(first.play.nextSpawn, 25 + spawnTicks(20));
});

test('nothing moves before the start, and a run never started ends at maxTicks with 0', () => {
  const idle = engine.advance(engine.createRun(3, CONFIG), 2000);
  assert.equal(idle.play.walkers.length, 0); assert.equal(idle.play.steps, 0); assert.equal(idle.gameOver, false);
  const expired = engine.advance(idle, CONFIG.maxTicks + 50);
  assert.equal(expired.gameOver, true); assert.equal(expired.tick, CONFIG.maxTicks); assert.equal(engine.score(expired), 0);
});

test('walking: straight up by default, a sign turns whoever steps on it, a side turns them around', () => {
  let s = plaza([walker(0, 2, BOTTOM, 0, 5)]);
  s = steps(s, 3);
  assert.deepEqual([s.play.walkers[0]!.x, s.play.walkers[0]!.y], [2, BOTTOM - 3]);
  // a sign pointing right under it: the next step takes it right, and it keeps going right
  s = engine.applyInput(s, { action: 'sign', x: 2, y: BOTTOM - 3, dir: 1 }, s.tick + 1);
  s = steps(s, 2);
  assert.deepEqual([s.play.walkers[0]!.x, s.play.walkers[0]!.y, s.play.walkers[0]!.dir], [4, BOTTOM - 3, 1]);
  // at the right edge it turns around and waits a step
  let e = plaza([walker(0, COLS - 1, 5, 1, 0)]);
  e = steps(e, 1);
  assert.deepEqual([e.play.walkers[0]!.x, e.play.walkers[0]!.dir], [COLS - 1, 3]);
  e = steps(e, 1);
  assert.equal(e.play.walkers[0]!.x, COLS - 2);
});

test('delivery: its own brick pays (50 + 5 × patience) × streak factor; another brick turns it back down', () => {
  let s = plaza([walker(0, 4, 1, 0, 4, 30)]);
  s = steps(s, 1);
  assert.equal(s.play.walkers.length, 0); assert.equal(s.play.delivered, 1); assert.equal(s.play.streak, 1);
  assert.equal(s.play.score, 50 + 5 * 29); assert.deepEqual(s.play.log, [0 * 4 + DELIVERED]);
  let wrong = plaza([walker(0, 3, 1, 0, 4)]);
  wrong = steps(wrong, 1);
  assert.equal(wrong.play.delivered, 0); assert.equal(wrong.play.walkers[0]!.dir, 2); assert.equal(wrong.play.walkers[0]!.y, 1);
  // the streak factor: ×1 for the first five, ×2 from the sixth, capped at ×5
  assert.equal(deliveryPoints(10, 0), 100); assert.equal(deliveryPoints(10, 4), 100); assert.equal(deliveryPoints(10, 5), 200);
  assert.equal(deliveryPoints(10, 20), 500); assert.equal(deliveryPoints(10, 999), 500);
});

test('misses: off the bottom, or out of patience; a miss resets the streak; the fifth ends the run at once', () => {
  let s = plaza([walker(0, 1, BOTTOM, 2, 6), walker(1, 5, 4, 1, 6, 1)]);
  s.play.streak = 7;
  s = steps(s, 1);
  assert.equal(s.play.missed, 2); assert.equal(s.play.streak, 0); assert.equal(s.play.walkers.length, 0);
  assert.deepEqual(s.play.log, [0 * 4 + LEFT, 1 * 4 + GAVE_UP]);
  const five = plaza(Array.from({ length: 5 }, (_, i) => walker(i, i, BOTTOM, 2, 7)));
  const over = steps(five, 1);
  assert.equal(over.gameOver, true); assert.equal(over.play.missed, RULES.strikes);
  assert.equal(engine.isFinished(over), true);
  assert.deepEqual(engine.applyInput(over, { action: 'sign', x: 0, y: 1, dir: 0 }, over.tick + 5), over, 'no input after the end');
});

test('signs: eight at most, the oldest comes down; replacing one makes it the newest; clear takes one down', () => {
  let s = plaza([]);
  for (let i = 0; i < 9; i++) s = engine.applyInput(s, { action: 'sign', x: i % COLS, y: 1 + Math.floor(i / COLS), dir: 1 }, s.tick + 1);
  assert.equal(s.play.signs.length, RULES.maxSigns);
  assert.equal(engine.signAt(s.play, 1 * COLS + 0), -1, 'the first sign came down');
  s = engine.applyInput(s, { action: 'sign', x: 1, y: 1, dir: 3 }, s.tick + 1);
  assert.deepEqual(s.play.signs.at(-1), [1 * COLS + 1, 3]); assert.equal(s.play.signs.length, RULES.maxSigns);
  s = engine.applyInput(s, { action: 'clear', x: 1, y: 1 }, s.tick + 1);
  assert.equal(engine.signAt(s.play, 1 * COLS + 1), -1); assert.equal(s.play.signs.length, RULES.maxSigns - 1);
  const before = s;
  s = engine.applyInput(s, { action: 'clear', x: 7, y: 9 }, s.tick + 1);
  assert.deepEqual(s.play.signs, before.play.signs, 'clearing an empty cell changes nothing');
});

test('forged and illegal inputs are no-ops, never a score', () => {
  const s = started(4);
  for (const bad of [
    { action: 'sign', x: 0, y: 0, dir: 0 },              // the wall row
    { action: 'sign', x: COLS, y: 3, dir: 0 }, { action: 'sign', x: -1, y: 3, dir: 0 }, { action: 'sign', x: 1, y: BOTTOM + 1, dir: 0 },
    { action: 'sign', x: 1, y: 3, dir: 4 }, { action: 'sign', x: 1.5, y: 3, dir: 0 }, { action: 'sign', x: '1', y: 3, dir: 0 },
    { action: 'sign', x: 1, y: 3, dir: 0, score: 9999 }, { action: 'sign', x: 1, y: 3 },
    { action: 'clear', x: 1, y: 3, dir: 0 }, { action: 'deliver', walker: 0 }, { action: 'score', value: 10 }, { action: 'start', now: 1 },
    null, 'sign', [1, 3, 0], {},
  ]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
    assert.equal(inputSchema.safeParse(bad).success, false, `zod agrees: ${JSON.stringify(bad)}`);
    const after = engine.applyInput(s, bad, 3);
    assert.deepEqual(after.play, s.play, JSON.stringify(bad));
  }
  // a sign before the start does nothing either
  const early = engine.applyInput(engine.createRun(4, CONFIG), { action: 'sign', x: 1, y: 3, dir: 0 }, 2);
  assert.equal(early.play.signs.length, 0);
});

test('time belongs to the server: ticks never go backwards, a step happens on its tick whatever the call pattern', () => {
  const s = engine.advance(started(5), 300);
  assert.throws(() => engine.advance(s, 299)); assert.throws(() => engine.applyInput(s, { action: 'clear', x: 0, y: 1 }, 10));
  assert.throws(() => engine.advance(s, 300.5));
  // one long call or many short ones reach the same state
  let small = started(5);
  for (let t = 1; t <= 1500; t++) small = engine.advance(small, t);
  assert.deepEqual(small, engine.advance(started(5), 1500));
});

test('replay: the same seed and the same ordered inputs give the same state and score, also through JSON', () => {
  for (const seed of [0, 1, 7, 4242, 0xdeadbeef]) {
    const { inputs, state } = botRun(seed, 0.6);
    let replay = engine.createRun(seed, CONFIG), viaJson = roundtrip(replay);
    for (const { input, tick } of inputs) {
      replay = engine.applyInput(replay, input, tick);
      viaJson = roundtrip(engine.applyInput(checkState(viaJson), input, tick));
    }
    replay = engine.advance(replay, state.tick); viaJson = engine.advance(checkState(viaJson), state.tick);
    assert.deepEqual(replay, state); assert.deepEqual(viaJson, state);
    assert.equal(engine.score(replay), state.play.score);
  }
});

test('a run ends: by five misses or by the 4-minute cap, its score bounded, its state small', () => {
  for (const seed of [11, 12, 13]) {
    const idle = engine.advance(started(seed), CONFIG.maxTicks);
    assert.equal(idle.gameOver, true); assert.equal(idle.play.missed, RULES.strikes, 'nobody steers: five walkers lost');
    assert.equal(idle.play.score, 0); assert.ok(idle.tick < 2000);
    const { state } = botRun(seed, 1);
    assert.equal(state.gameOver, true);
    assert.ok(state.play.delivered > 20, `the simple bot delivers (${state.play.delivered})`);
    assert.ok(JSON.stringify(state).length < 4096);
    const maxPerWalker = deliveryPoints(RULES.patience, 1_000);
    assert.ok(state.play.score <= state.play.spawned * maxPerWalker);
  }
});

test('the hand-written checks and the zod schemas accept and refuse the same states', () => {
  const good = botRun(21, 0.7).state, mid = engine.advance(started(21), 400);
  for (const s of [good, mid, engine.createRun(21, CONFIG)]) {
    assert.deepEqual(checkState(roundtrip(s)), s); assert.equal(stateSchema.safeParse(roundtrip(s)).success, true);
  }
  const broken: unknown[] = [
    { ...mid, extra: 1 },
    { ...mid, play: { ...mid.play, score: -1 } },
    { ...mid, play: { ...mid.play, missed: RULES.strikes } },                                  // five misses but not over
    { ...mid, play: { ...mid.play, nextStep: mid.tick } },                                     // a step left behind
    { ...mid, play: { ...mid.play, signs: [[3, 0]] } },                                        // a sign on the wall
    { ...mid, play: { ...mid.play, signs: [[20, 0], [20, 1]] } },                              // two signs on one cell
    { ...mid, play: { ...mid.play, signs: Array.from({ length: 9 }, (_, i) => [8 + i, 0]) } }, // nine signs
    { ...mid, play: { ...mid.play, walkers: [{ ...walker(0, 1, 0, 0, 2) }] } },                // a walker in the wall
    { ...mid, play: { ...mid.play, walkers: [{ ...walker(0, 1, 3, 0, 2), life: 0 }] } },
    { ...mid, play: { ...mid.play, walkers: [{ ...walker(0, 1, 3, 0, 2), speed: 2 }] } },
    { ...mid, startTick: null },
    { ...mid, rules: { ...mid.rules, game: 'full-row' } },
  ];
  for (const b of broken) {
    assert.throws(() => checkState(b), JSON.stringify(b).slice(0, 120));
    assert.equal(stateSchema.safeParse(b).success, false, JSON.stringify(b).slice(0, 120));
  }
});

test('a state past its round but not over is refused by both checks (the engine never hands one back)', () => {
  const s = started(1);
  const past = { ...s, tick: CONFIG.roundTicks + 5, play: { ...s.play, lastStep: CONFIG.roundTicks + 4, nextStep: CONFIG.roundTicks + 9, nextSpawn: CONFIG.roundTicks + 9 } };
  assert.throws(() => checkState(roundtrip(past)));
  assert.equal(stateSchema.safeParse(roundtrip(past)).success, false);
});

test('the snapshot envelope parses a coordinator packet', () => {
  const state = engine.advance(started(8), 120);
  const packet = { runId: '6f7b1c1e-7c0a-4b8e-9b1a-0c7c9a3d2e11', configDigest: 'a'.repeat(64), serverTick: 120, inputSeq: 1, inputTick: 0,
    expiresAt: new Date().toISOString(), state, result: null };
  assert.equal(snapshotSchema.safeParse(packet).success, true);
  assert.equal(snapshotSchema.safeParse({ ...packet, state: { ...state, play: { ...state.play, score: 'lots' } } }).success, false);
});

test('the skin: 8 real neighbours from one row of the wall, from the seed', () => {
  assert.ok(STRETCHES.length > 0, 'the snapshot has stretches of 8 named neighbours');
  const named = new Set(WALL_PANELS.map((panel) => panel.p));
  for (const seed of [0, 1, 99, 0xffffffff]) {
    const bricks = bricksFor(seed);
    assert.equal(bricks.length, COLS);
    assert.deepEqual(bricks, bricksFor(seed));
    for (let k = 0; k < COLS; k++) {
      assert.ok(named.has(bricks[k]!));
      assert.equal(bricks[k], bricks[0]! + k);
    }
    assert.equal(Math.floor((bricks[0]! - 1) / 25), Math.floor((bricks[COLS - 1]! - 1) / 25), 'one row');
  }
});
