import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/common/det.js';
import {
  ALL_BRICKS, DIVING, IN_FORMATION, RETURNING, RULES, SHIP_Y, W, WALL_Y, brickCenter, checkState, createEngine, inputSchema, parseInput,
  slotX, slotY, snapshotSchema, stateSchema, streakMult, sway, waveRows, type Cleaner, type WwState,
} from '../src/games/whitewash/engine.js';
import { scoringConfiguration } from '../src/shell/config.js';

const engine = createEngine();
const CONFIG = scoringConfiguration('whitewash');
const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const started = (seed: number, tick = 0): WwState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, tick);
/** A started run with a hand-made sky (no dive, no fire unless asked). */
function sky(cleaners: Partial<Cleaner>[], over: Partial<WwState['play']> = {}): WwState {
  const s = started(1);
  s.play.cleaners = cleaners.map((c, i) => ({ id: 100 + i, slot: i, mode: IN_FORMATION, x: slotX(i, 0), y: slotY(i), to: -1, dropAt: -1, ...c }));
  s.play.nextDive = 1_000_000; s.play.fireAt = 1_000_000;
  Object.assign(s.play, over);
  return s;
}
const ticks = (s: WwState, n: number): WwState => engine.advance(s, s.tick + n);
/** A bot that follows the lowest diver, else the nearest cleaner: ordered moves, one per tick at most. */
function botRun(seed: number): { inputs: { input: unknown; tick: number }[]; state: WwState } {
  const rnd = mulberry32(seed ^ 0x77);
  let state = engine.createRun(seed, CONFIG);
  const inputs: { input: unknown; tick: number }[] = [{ input: { action: 'start' }, tick: 1 }];
  state = engine.applyInput(state, { action: 'start' }, 1);
  let tick = 1;
  while (!state.gameOver) {
    tick += 1;
    const p = state.play, diver = p.cleaners.filter((c) => c.mode === DIVING).sort((a, b) => b.y - a.y)[0];
    const aim = diver ?? p.cleaners[Math.floor(rnd() * Math.max(1, p.cleaners.length))];
    if (aim && tick % 3 === 0 && aim.x !== p.target) {
      const input = { action: 'move', x: Math.max(0, Math.min(W, aim.x)) };
      inputs.push({ input, tick }); state = engine.applyInput(state, input, tick);
    } else state = engine.advance(state, tick);
  }
  return { inputs, state };
}

test('geometry: the sway is a whole-pixel triangle of ±30, the formation fits the screen, waves grow', () => {
  for (let t = 0; t < 400; t++) { const s = sway(t); assert.ok(Number.isInteger(s) && s >= -30 && s <= 30); }
  assert.equal(sway(0), -30); assert.equal(sway(100), 30); assert.equal(sway(200), -30);
  for (let slot = 0; slot < 30; slot++) for (const t of [0, 100]) assert.ok(slotX(slot, t) >= 20 && slotX(slot, t) <= W - 20);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(waveRows), [3, 3, 4, 4, 5, 5, 5]);
  assert.equal(started(3).play.cleaners.length, 18, 'wave 1: three rows of six');
});

test('nothing moves before the start, and a run never started ends at maxTicks with 0', () => {
  const idle = engine.advance(engine.createRun(3, CONFIG), 2000);
  assert.equal(idle.play.cleaners.length, 0); assert.equal(idle.play.shots.length, 0); assert.equal(idle.gameOver, false);
  const expired = engine.advance(idle, CONFIG.maxTicks + 9);
  assert.equal(expired.gameOver, true); assert.equal(expired.tick, CONFIG.maxTicks); assert.equal(engine.score(expired), 0);
});

test('moving: the dragon walks to its target at RULES.speed px a tick, stays whole on screen, not while stunned', () => {
  let s = sky([{}]);
  s = engine.applyInput(s, { action: 'move', x: 100 }, s.tick + 1);
  s = ticks(s, 1); assert.equal(s.play.x, 210 - RULES.speed);
  s = ticks(s, 10); assert.equal(s.play.x, 100);
  const edge = engine.applyInput(s, { action: 'move', x: 0 }, s.tick + 1);
  assert.equal(edge.play.target, 22, 'never past the edge');
  s.play.stunUntil = s.tick + 5;
  s = engine.applyInput(s, { action: 'move', x: 300 }, s.tick + 1);
  s = ticks(s, 3); assert.equal(s.play.x, 100, 'stunned: no walking');
  s = ticks(s, 5); assert.ok(s.play.x > 100);
});

test('spraying: by itself, every 7 ticks, two shots in the air at most, none when the sky is empty', () => {
  let s = sky([{ x: 400, y: 120 }], { fireAt: 0 });
  s.tick = 0; s.play.waveStart = 0;
  s = ticks(s, 1); assert.equal(s.play.shots.length, 1);
  s = ticks(s, 7); assert.equal(s.play.shots.length, 2);
  s = ticks(s, 7); assert.equal(s.play.shots.length, 2, 'never more than two');
  const empty = sky([], { fireAt: 0, waveAt: 1_000_000 });
  assert.equal(ticks(empty, 5).play.shots.length, 0);
});

test('downing: 50 in formation, 150 mid-dive; the lowest cleaner in the line takes the shot', () => {
  let s = sky([{ slot: 0, x: 210, y: 300 }, { slot: 6, x: 210, y: 346 }, { slot: 1, x: 400, y: 120 }]);
  s.play.cleaners.forEach((c) => { c.mode = IN_FORMATION; });
  s.play.shots = [[210, 400]];
  // keep them where they are: formation cleaners snap to their slot each tick, so test with divers frozen in place
  s.play.cleaners[0]!.mode = DIVING; s.play.cleaners[0]!.to = 4; s.play.cleaners[1]!.mode = DIVING; s.play.cleaners[1]!.to = 4;
  s = ticks(s, 2);
  assert.equal(s.play.downed, 1); assert.equal(s.play.score, RULES.divePoints);
  assert.ok(!s.play.cleaners.some((c) => c.id === 101), 'the lower one went first');
  let f = sky([{ slot: 0 }, { slot: 1 }]);
  f.play.shots = [[slotX(0, f.tick + 1 - f.play.waveStart), slotY(0) + 30]];
  f = ticks(f, 1);
  assert.equal(f.play.downed, 1); assert.equal(f.play.score, RULES.formationPoints);
});

test('the streak: ×1 for the first 8 downed, ×2 from the 9th … ×4 at most; a whitewashed name resets it', () => {
  assert.deepEqual([0, 7, 8, 16, 24, 1000].map(streakMult), [1, 1, 2, 3, 4, 4]);
  let s = sky([{ slot: 0 }, { slot: 1 }], { streak: 8 });
  s.play.shots = [[slotX(0, s.tick + 1 - s.play.waveStart), slotY(0) + 30]];
  s = ticks(s, 1);
  assert.equal(s.play.score, RULES.formationPoints * 2); assert.equal(s.play.streak, 9);
  let w = sky([{ slot: 3, mode: DIVING, to: 5, x: brickCenter(5), y: WALL_Y - 4 }, { slot: 0 }], { streak: 20 });
  w = ticks(w, 1);
  assert.equal(w.play.streak, 0, 'a name lost: the streak starts again');
});

test('a diver that reaches the wall whitewashes its name, then flies back to its place', () => {
  let s = sky([{ slot: 3, mode: DIVING, to: 5, x: brickCenter(5), y: WALL_Y - 4 }, { slot: 0 }]);
  s = ticks(s, 1);
  assert.equal(s.play.bricks, ALL_BRICKS & ~(1 << 5)); assert.equal(s.play.washed, 1);
  assert.equal(s.play.cleaners[0]!.mode, RETURNING);
  s = ticks(s, 80);
  assert.equal(s.play.cleaners[0]!.mode, IN_FORMATION); assert.equal(s.play.cleaners[0]!.y, slotY(3));
  // a name already whitewashed is not counted twice
  let again = sky([{ slot: 3, mode: DIVING, to: 5, x: brickCenter(5), y: WALL_Y - 4 }, { slot: 0 }], { bricks: ALL_BRICKS & ~(1 << 5) });
  again = ticks(again, 1);
  assert.equal(again.play.washed, 0);
});

test('dives: from the seed, at a standing name, never more divers than the wave allows', () => {
  let a = started(42), b = started(42);
  a = engine.advance(a, 400); b = engine.advance(b, 400);
  assert.deepEqual(a, b);
  const s = sky(Array.from({ length: 12 }, (_, i) => ({ slot: i })), { nextDive: 0, bricks: 1 << 6 });
  const after = ticks(s, 1);
  const divers = after.play.cleaners.filter((c) => c.mode === DIVING);
  assert.equal(divers.length, 1); assert.equal(divers[0]!.to, 6, 'only one name stands: it is the target');
});

test('a drip on the dragon stuns it for 1.5 s', () => {
  let s = sky([{}], { drips: [[210, SHIP_Y - 30]] });
  s = ticks(s, 1);
  assert.equal(s.play.drips.length, 0); assert.equal(s.play.stunUntil, s.tick + RULES.stunTicks);
  const miss = ticks(sky([{}], { drips: [[20, SHIP_Y - 40]] }), 1);
  assert.equal(miss.play.stunUntil, 0); assert.equal(miss.play.drips.length, 1);
});

test('a wave downed: 100 × standing names × wave, one name repainted, the next wave larger', () => {
  let s = sky([{ slot: 0 }], { bricks: ALL_BRICKS & ~0b101, wave: 3 });
  s.play.shots = [[slotX(0, s.tick + 1 - s.play.waveStart), slotY(0) + 30]];
  s = ticks(s, 1);
  assert.equal(s.play.cleared, 1);
  assert.equal(s.play.score, RULES.formationPoints + RULES.waveBonus * 6 * 3);
  assert.equal(s.play.bricks, ALL_BRICKS & ~0b100, 'the first whitewashed name is repainted');
  s = ticks(s, RULES.wavePauseTicks);
  assert.equal(s.play.wave, 4); assert.equal(s.play.cleaners.length, waveRows(4) * RULES.formationCols); assert.equal(s.play.waveAt, -1);
});

test('the run ends when no name stands, or at the 3-minute cap', () => {
  let s = sky([{ slot: 3, mode: DIVING, to: 0, x: brickCenter(0), y: WALL_Y - 4 }, { slot: 0 }], { bricks: 1 });
  s = ticks(s, 1);
  assert.equal(s.gameOver, true); assert.equal(engine.isFinished(s), true);
  assert.deepEqual(engine.applyInput(s, { action: 'move', x: 0 }, s.tick + 5), s, 'no input after the end');
  const idle = engine.advance(started(9), CONFIG.maxTicks);
  assert.equal(idle.gameOver, true);
  assert.ok(idle.tick <= CONFIG.roundTicks);
});

test('an abandoned run ends 30 s after the last input, its score kept; any move (even to where it goes) keeps it alive', () => {
  // the reviewer's case: one move, then nothing (seed 307, x 189): it used to run to the 3-minute cap in one call
  let s = engine.applyInput(engine.createRun(307, CONFIG), { action: 'start' }, 0);
  s = engine.applyInput(s, { action: 'move', x: 189 }, 2);
  const idle = engine.advance(s, CONFIG.maxTicks);
  assert.equal(idle.gameOver, true); assert.ok(idle.tick <= 2 + RULES.idleTicks, `ended at ${idle.tick}`);
  // keep-alives every 5 s: the run reaches the round's end (or loses its names) instead
  let k = engine.applyInput(engine.createRun(307, CONFIG), { action: 'start' }, 0);
  for (let t = 100; t < 3000 && !k.gameOver; t += 100) k = engine.applyInput(k, { action: 'move', x: k.play.target }, t);
  assert.ok(k.gameOver || k.tick >= 2900, 'kept alive');
  assert.ok(k.play.lastInput > RULES.idleTicks || k.gameOver);
  // a state past its end but not over is refused (the engine never hands one back)
  const mid = engine.advance(engine.applyInput(engine.createRun(9, CONFIG), { action: 'start' }, 0), 300);
  assert.throws(() => checkState({ ...mid, tick: mid.play.lastInput + RULES.idleTicks }));
  assert.equal(stateSchema.safeParse({ ...mid, tick: mid.play.lastInput + RULES.idleTicks }).success, false);
});

test('forged and illegal inputs are no-ops, never a score', () => {
  const s = started(4);
  for (const bad of [
    { action: 'move', x: -1 }, { action: 'move', x: W + 1 }, { action: 'move', x: 10.5 }, { action: 'move', x: '10' }, { action: 'move' },
    { action: 'move', x: 10, y: 5 }, { action: 'fire' }, { action: 'down', id: 100 }, { action: 'score', value: 99 }, { action: 'start', at: 0 },
    null, 'move', [1], {},
  ]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
    assert.equal(inputSchema.safeParse(bad).success, false, `zod agrees: ${JSON.stringify(bad)}`);
    assert.deepEqual(engine.applyInput(s, bad, 3).play, engine.advance(s, 3).play, JSON.stringify(bad));
  }
  const early = engine.applyInput(engine.createRun(4, CONFIG), { action: 'move', x: 0 }, 2);
  assert.equal(early.play.target, W / 2, 'a move before the start does nothing');
});

test('time belongs to the server: ticks never go backwards, one long call equals many short ones', () => {
  const s = engine.advance(started(5), 300);
  assert.throws(() => engine.advance(s, 299)); assert.throws(() => engine.applyInput(s, { action: 'move', x: 1 }, 10));
  assert.throws(() => engine.advance(s, 300.5));
  let small = started(5);
  for (let t = 1; t <= 1500; t++) small = engine.advance(small, t);
  assert.deepEqual(small, engine.advance(started(5), 1500));
});

test('replay: the same seed and the same ordered inputs give the same state and score, also through JSON', () => {
  for (const seed of [0, 1, 7, 4242, 0xdeadbeef]) {
    const { inputs, state } = botRun(seed);
    let replay = engine.createRun(seed, CONFIG), viaJson = roundtrip(replay);
    for (const { input, tick } of inputs) {
      replay = engine.applyInput(replay, input, tick);
      viaJson = roundtrip(engine.applyInput(checkState(viaJson), input, tick));
    }
    replay = engine.advance(replay, state.tick); viaJson = engine.advance(checkState(viaJson), state.tick);
    assert.deepEqual(replay, state); assert.deepEqual(viaJson, state);
    assert.ok(state.play.score > 0 && JSON.stringify(state).length < 8192);
  }
});

test('the hand-written checks and the zod schemas accept and refuse the same states', () => {
  const good = botRun(21).state, mid = engine.advance(started(21), 500);
  for (const s of [good, mid, engine.createRun(21, CONFIG)]) {
    assert.deepEqual(checkState(roundtrip(s)), s); assert.equal(stateSchema.safeParse(roundtrip(s)).success, true);
  }
  const c0 = mid.play.cleaners[0] as Cleaner;
  const broken: unknown[] = [
    { ...mid, extra: 1 },
    { ...mid, play: { ...mid.play, score: -1 } },
    { ...mid, play: { ...mid.play, bricks: 0 } },                                              // no name left but not over
    { ...mid, play: { ...mid.play, bricks: 256 } },
    { ...mid, play: { ...mid.play, x: W + 1 } },
    { ...mid, play: { ...mid.play, shots: [[1, 1], [2, 2], [3, 3]] } },                        // three shots
    { ...mid, play: { ...mid.play, cleaners: [c0, { ...c0, id: 9999 }] } },                    // two cleaners in one slot
    { ...mid, play: { ...mid.play, cleaners: [{ ...c0, mode: DIVING, to: -1 }] } },            // a diver without a target
    { ...mid, play: { ...mid.play, cleaners: [{ ...c0, mode: 3 }] } },
    { ...mid, play: { ...mid.play, cleaners: [{ ...c0, hp: 2 }] } },
    { ...mid, startTick: null },
    { ...mid, rules: { ...mid.rules, game: 'signage' } },
  ];
  for (const b of broken) {
    assert.throws(() => checkState(b), JSON.stringify(b).slice(0, 120));
    assert.equal(stateSchema.safeParse(b).success, false, JSON.stringify(b).slice(0, 120));
  }
});

test('the snapshot envelope parses a coordinator packet', () => {
  const state = engine.advance(started(8), 120);
  const packet = { runId: '6f7b1c1e-7c0a-4b8e-9b1a-0c7c9a3d2e11', configDigest: 'a'.repeat(64), serverTick: 120, inputSeq: 1, inputTick: 0,
    expiresAt: new Date().toISOString(), state, result: null };
  assert.equal(snapshotSchema.safeParse(packet).success, true);
  assert.equal(snapshotSchema.safeParse({ ...packet, state: { ...state, play: { ...state.play, score: 'lots' } } }).success, false);
});
