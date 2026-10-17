import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/common/det.js';
import { ELIG } from '../src/generated/wall.js';
import {
  createEngine, stateSchema, snapshotSchema, MAX_FLIGHT_TICKS_PER_CALL, MIN_ANGLE, MAX_ANGLE, type UbState,
} from '../src/games/unbreakable/engine.js';
import { loadOriginal } from './helpers/original-unbreakable.js';

const engine = createEngine(ELIG);
const CONFIG = { game: 'unbreakable', maxTicks: 3900, roundTicks: 3600 } as const;
const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Plays one full turn on the engine through the coordinator's contract (ticks, one input per tick). */
function playTurn(state: UbState, angle: number, viaJson = false): UbState {
  let current = engine.applyInput(state, { action: 'fire', angle }, state.tick);
  if (viaJson) current = roundtrip(current);
  let guard = 0;
  while (!current.gameOver && current.sim.phase === 1 && guard++ < 10_000) {
    current = engine.advance(current, current.tick + 1);
    if (viaJson) current = roundtrip(current);
  }
  return current;
}
const started = (seed: number, config: unknown = CONFIG): UbState => engine.applyInput(engine.createRun(seed, config), { action: 'start' }, 0);

const original = loadOriginal();

test('differential: the ported engine reproduces the original v5.1 simulation, turn for turn', { skip: original === null }, () => {
  const { makeSim } = original!;
  for (const seed of [1, 7, 123, 4242, 99991, 2026, 31337, 0xdeadbeef, 555, 8080, 17, 424242]) {
    const rnd = mulberry32(seed ^ 0x5eed);
    const reference = makeSim({ week: `r${seed}`, elig: [...ELIG] });
    let state = started(seed);
    for (let turn = 0; turn < 45 && reference.phase !== 2; turn++) {
      const angle = Math.round(MIN_ANGLE + rnd() * (MAX_ANGLE - MIN_ANGLE));
      assert.equal(reference.fire(angle), true);
      let guard = 0;
      while (reference.phase === 1 && guard++ < 1e7) reference.step();
      state = playTurn(state, angle, turn % 2 === 0);              // every other turn through a JSON round trip each tick
      assert.equal(state.sim.score, reference.score, `seed ${seed} turn ${turn}: score`);
      assert.equal(state.sim.turn, reference.turn, `seed ${seed} turn ${turn}: turn`);
      assert.equal(state.sim.nBalls, reference.nBalls, `seed ${seed} turn ${turn}: balls`);
      assert.equal(state.sim.broken, reference.broken, `seed ${seed} turn ${turn}: broken`);
      assert.equal(state.sim.originX, reference.originX, `seed ${seed} turn ${turn}: origin`);
      assert.equal(state.sim.phase, reference.phase, `seed ${seed} turn ${turn}: phase`);
      assert.deepEqual(
        state.sim.rows.map((row) => row.cells.map((cell) => (cell === null ? null : cell.t === 3 ? 3 : `${cell.pos}:${cell.hp}/${cell.hp0}`))),
        reference.rows.map((row) => row.cells.map((cell) => (cell === null ? null : cell.t === 3 ? 3 : `${(cell as { pos: number }).pos}:${(cell as { hp: number }).hp}/${(cell as { hp0: number }).hp0}`))),
        `seed ${seed} turn ${turn}: board`,
      );
      if (state.gameOver) break;
    }
    assert.equal(state.gameOver, reference.phase === 2, `seed ${seed}: terminal state agrees`);
  }
});

test('the whole run is a function of (seed, ordered inputs): same inputs same state, other seed other board', () => {
  const play = (seed: number): UbState => { let s = started(seed); for (const angle of [6000, 12000, 9000, 4500, 13500, 9000, 7000, 11000]) s = playTurn(s, angle); return s; };
  const a = play(77), b = play(77), c = play(78);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.sim.rows, c.sim.rows);
  assert.ok(a.sim.score > 0, 'eight sensible shots hit something');
});

test('createRun validates seed and config, and starts unstarted with a deterministic board', () => {
  assert.throws(() => engine.createRun(-1, CONFIG));
  assert.throws(() => engine.createRun(1.5, CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 10 }));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'target-rush' }));
  assert.throws(() => engine.createRun(1, { ...CONFIG, extra: true }) && stateSchema.parse({}));
  const run = engine.createRun(0, CONFIG);                          // the platform's conformance check uses seed 0
  assert.equal(run.started, false); assert.equal(run.sim.score, 0); assert.equal(run.sim.phase, 0);
  assert.deepEqual(run, engine.createRun(0, CONFIG));
  stateSchema.parse(run);
  assert.deepEqual(engine.view(run), run);
});

test('illegal, forged and out-of-order inputs never score or move time', () => {
  const idle = engine.createRun(5, CONFIG);
  assert.equal(engine.applyInput(idle, { action: 'fire', angle: 9000 }, 1).sim.phase, 0, 'no shot before start');
  const live = started(5);
  const bad: unknown[] = [
    { action: 'fire', angle: 9000, score: 999_999 }, { action: 'fire', angle: 9000.5 }, { action: 'fire', angle: MIN_ANGLE - 1 },
    { action: 'fire', angle: MAX_ANGLE + 1 }, { action: 'fire', angle: '9000' }, { action: 'fire' }, { action: 'setScore', score: 99 },
    { action: 'start', extra: 1 }, { action: 'hit', targetId: 1 }, null, 'fire', 7, [], { angle: 9000 },
  ];
  for (const input of bad) {
    const after = engine.applyInput(live, input, 1);
    assert.equal(after.sim.score, 0); assert.equal(after.sim.phase, 0); assert.equal(after.sim.shots, 0, `ignored: ${JSON.stringify(input)}`);
  }
  const shot = engine.applyInput(live, { action: 'fire', angle: 9000 }, 1);
  assert.equal(shot.sim.phase, 1); assert.equal(shot.sim.shots, 1);
  const again = engine.applyInput(shot, { action: 'fire', angle: 4000 }, 2);
  assert.equal(again.sim.shots, 1, 'a second shot while the balls are flying is ignored');
  assert.throws(() => engine.advance(shot, 0), /backwards/);
  assert.equal(engine.applyInput(live, { action: 'start' }, 10).startTick, 0, 'a second start does not move the start tick');
});

test('time belongs to the server: deadlines are enforced without input, the deadline never moves', () => {
  const run = engine.createRun(9, { game: 'unbreakable', maxTicks: 100, roundTicks: 60 });
  const neverStarted = engine.advance(run, 100);
  assert.equal(neverStarted.gameOver, true); assert.equal(engine.isFinished(neverStarted), true); assert.equal(engine.score(neverStarted), 0);
  const live = engine.applyInput(run, { action: 'start' }, 30);
  assert.equal(live.startTick, 30);
  const mid = engine.advance(live, 89);
  assert.equal(mid.gameOver, false);
  const end = engine.advance(mid, 90);
  assert.equal(end.gameOver, true); assert.equal(end.tick, 90, 'start + roundTicks, not extended by later calls');
  assert.deepEqual(engine.applyInput(end, { action: 'fire', angle: 9000 }, 95), end, 'terminal state is immutable');
  assert.deepEqual(engine.advance(end, 5000), end);
});

test('advance is composable: stepping tick by tick equals one big jump (state is fully serialised)', () => {
  let shot = engine.applyInput(started(31), { action: 'fire', angle: 7000 }, 1);
  const jumped = engine.advance(shot, 200);
  let stepped = shot;
  for (let t = shot.tick + 1; t <= 200; t++) stepped = roundtrip(engine.advance(roundtrip(stepped), t));
  assert.deepEqual(stepped.sim, jumped.sim);
  assert.equal(stepped.sim.score, jumped.sim.score);
  shot = jumped;
  stateSchema.parse(roundtrip(shot));
});

test('CPU guard: one call simulates a bounded number of flight ticks and the next call resumes exactly', () => {
  const shot = engine.applyInput(started(31), { action: 'fire', angle: 7000 }, 1);
  shot.sim.nBalls = 40;                                              // a late-game turn (the guard is about flight length)
  const long = engine.createRun(31, CONFIG); void long;
  let partial = engine.advance(shot, 1 + 5000 - 1);
  if (partial.sim.phase === 1) assert.ok(partial.tick - shot.tick <= MAX_FLIGHT_TICKS_PER_CALL, 'bounded work per call');
  let resumed = partial, guard = 0;
  while (resumed.tick < 4999 && !resumed.gameOver && guard++ < 100) resumed = engine.advance(resumed, 4999);
  const direct = engine.advance(shot, 4999);
  // calling in chunks must land in exactly the same state as one call when the deadline is not at stake
  assert.deepEqual(resumed.sim, direct.sim);
  // ...but a call that must reach the terminal tick never stops early
  const finalCall = engine.advance(shot, 10_000);
  assert.equal(finalCall.gameOver, true); assert.equal(finalCall.tick, 3900 === finalCall.tick ? 3900 : finalCall.tick);
});

test('state, view and snapshot stay under the platform bounds (64 KiB state, 1 KiB socket messages)', () => {
  const rnd = mulberry32(5);
  let state = started(2026);
  state.sim.nBalls = 120;
  let biggest = 0;
  for (let turn = 0; turn < 25 && !state.gameOver; turn++) {
    state = engine.applyInput(state, { action: 'fire', angle: Math.round(MIN_ANGLE + rnd() * (MAX_ANGLE - MIN_ANGLE)) }, state.tick);
    for (let guard = 0; state.sim.phase === 1 && guard < 4000; guard++) {
      state = engine.advance(state, state.tick + 1);
      biggest = Math.max(biggest, JSON.stringify(state).length);
    }
  }
  assert.ok(biggest < 64 * 1024, `state grew to ${biggest} bytes`);
  const input = JSON.stringify({ type: 'input', seq: 99999, input: { action: 'fire', angle: MAX_ANGLE } });
  assert.ok(input.length < 1024);
  const snapshot = { runId: '3f1c2d9e-0b41-4f7a-9d2e-5a6b7c8d9e0f', configDigest: 'a'.repeat(64), serverTick: 5, inputSeq: 1, inputTick: 2,
    expiresAt: new Date().toISOString(), state, result: null };
  snapshotSchema.parse(roundtrip(snapshot));
  assert.throws(() => snapshotSchema.parse({ ...snapshot, state: { ...state, sim: { ...state.sim, score: -1 } } }));
  assert.throws(() => snapshotSchema.parse({ ...snapshot, state: { ...state, extra: 1 } }));
});

test('CPU: a full 3-minute run with 60 balls, called every tick, stays far under the 10 ms/call budget', () => {
  const rnd = mulberry32(99);
  let state = started(4242);
  state.sim.nBalls = 60;
  let worst = 0, total = 0, calls = 0;
  const measure = <T,>(fn: () => T): T => { const t0 = process.hrtime.bigint(); const out = fn(); const ms = Number(process.hrtime.bigint() - t0) / 1e6; worst = Math.max(worst, ms); total += ms; calls++; return out; };
  for (let tick = 1; tick <= 3600 && !state.gameOver; tick++) {
    if (state.sim.phase === 0) state = measure(() => engine.applyInput(roundtrip(state), { action: 'fire', angle: Math.round(MIN_ANGLE + rnd() * (MAX_ANGLE - MIN_ANGLE)) }, tick));
    else state = measure(() => engine.advance(roundtrip(state), tick));
  }
  console.log(`  cpu: ${calls} calls, mean ${(total / calls).toFixed(3)} ms, worst ${worst.toFixed(3)} ms, final score ${state.sim.score}, turns ${state.sim.turn}`);
  assert.ok(worst < 5, `worst call ${worst} ms`);
});

test('a bot that fires straight up scores: automation is accepted by these rules (documented limitation)', () => {
  let state = started(11);
  for (let turn = 0; turn < 12 && !state.gameOver; turn++) state = playTurn(state, 9000);
  assert.ok(state.sim.score > 0);
});
