import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ELIG } from '../src/generated/wall.js';
import {
  createEngine, stateSchema, snapshotSchema, nextRoundMs, ticksForMs, MIN_REACTION_TICKS, PAUSE_TICKS,
  ROUND_START_MS, ROUND_MIN_MS, type TapState, type TapQuestion,
} from '../src/games/tap-the-name/engine.js';

const engine = createEngine(ELIG);
const CONFIG = { game: 'tap-the-name', maxTicks: 1900, roundTicks: 1800 } as const;
const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const started = (seed: number): TapState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
const answer = (state: TapState, tick: number, q: TapQuestion = state.question as TapQuestion, pos = q.target): TapState =>
  engine.applyInput(state, { action: 'choose', questionId: q.id, pos }, tick);

test('the timer recurrence is the v1 game: 3200 ms shrinking x0.92 down to a 1100 ms floor', () => {
  let ms = ROUND_START_MS, original = ROUND_START_MS;
  for (let i = 0; i < 40; i++) {
    original = Math.max(1100, Math.round(original * 0.92));          // the v1 line, verbatim
    ms = nextRoundMs(ms);
    assert.equal(ms, original);
  }
  assert.equal(ms, ROUND_MIN_MS);
  assert.equal(ticksForMs(3200), 64); assert.equal(ticksForMs(1100), 22);
});

test('createRun is deterministic, validated and not started', () => {
  const run = engine.createRun(7, CONFIG);
  assert.deepEqual(run, engine.createRun(7, CONFIG));
  assert.equal(run.started, false); assert.equal(run.question, null); assert.equal(run.score, 0);
  assert.throws(() => engine.createRun(-3, CONFIG)); assert.throws(() => engine.createRun(1.2, CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'unbreakable' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  assert.equal(engine.createRun(0, CONFIG).rngState !== 0, true, 'seed 0 (platform conformance) must not freeze the generator');
  stateSchema.parse(run);
});

test('a question: four distinct real panels, the target among them, never the same target twice in a row', () => {
  let state = started(123);
  let tick = 0, previous = -1;
  for (let i = 0; i < 60; i++) {
    const q = state.question as TapQuestion;
    assert.equal(q.options.length, 4); assert.equal(new Set(q.options).size, 4);
    assert.ok(q.options.includes(q.target)); assert.ok(q.options.every((p) => ELIG.includes(p)));
    assert.notEqual(q.target, previous); previous = q.target;
    tick += MIN_REACTION_TICKS + 1;
    state = answer(state, Math.max(state.tick, q.startTick + MIN_REACTION_TICKS + 1));
    assert.equal(state.score, i + 1);
    state = engine.advance(state, state.nextRoundAt as number);
  }
  assert.equal(state.gameOver, false);
});

test('correct answer scores once, opens the next question after the pause, with a shorter timer', () => {
  let state = started(5);
  const first = state.question as TapQuestion;
  assert.equal(first.deadlineTick - first.startTick, 64);
  state = answer(state, 5);
  assert.equal(state.score, 1); assert.equal(state.question, null); assert.equal(state.nextRoundAt, 5 + PAUSE_TICKS);
  const replay = answer(state, 6, first);
  assert.equal(replay.score, 1, 'the old question cannot score twice'); assert.equal(replay.question, null); assert.equal(replay.nextRoundAt, state.nextRoundAt);
  const next = engine.advance(state, 5 + PAUSE_TICKS);
  assert.equal(next.question?.startTick, 5 + PAUSE_TICKS);
  assert.equal(next.question!.deadlineTick - next.question!.startTick, ticksForMs(nextRoundMs(3200)));
  assert.equal(next.question!.id, first.id + 1);
});

test('a wrong tap ends the run with the score so far; so does a timeout', () => {
  let state = answer(started(9), 4);
  state = engine.advance(state, state.nextRoundAt as number);
  const q = state.question as TapQuestion;
  const decoy = q.options.find((p) => p !== q.target) as number;
  const wrong = answer(state, state.tick + 5, q, decoy);
  assert.equal(wrong.gameOver, true); assert.equal(wrong.last, 'wrong'); assert.equal(engine.score(wrong), 1);
  assert.deepEqual(answer(wrong, wrong.tick + 6, q), wrong, 'terminal state is immutable');
  const late = engine.advance(state, q.deadlineTick);
  assert.equal(late.gameOver, true); assert.equal(late.last, 'timeout'); assert.equal(late.tick, q.deadlineTick); assert.equal(engine.score(late), 1);
  assert.equal(engine.advance(late, 9999), late);
});

test('illegal, forged and out-of-order inputs never score', () => {
  const state = started(21);
  const q = state.question as TapQuestion;
  const wrongPanel = ELIG.find((p) => !q.options.includes(p)) as number;
  const bad: unknown[] = [
    { action: 'choose', questionId: q.id, pos: q.target, score: 9999 }, { action: 'choose', questionId: q.id + 1, pos: q.target },
    { action: 'choose', questionId: q.id, pos: wrongPanel }, { action: 'choose', questionId: q.id, pos: 0 }, { action: 'choose', questionId: q.id, pos: '1' },
    { action: 'choose', questionId: q.id }, { action: 'setScore', score: 9 }, { action: 'hit', targetId: 1 }, null, 'choose', 3, [],
  ];
  for (const input of bad) {
    const after = engine.applyInput(state, input, 6);
    assert.equal(after.score, 0, JSON.stringify(input)); assert.equal(after.gameOver, false, `not even a wrong-tap penalty: ${JSON.stringify(input)}`);
  }
  assert.equal(engine.applyInput(engine.createRun(21, CONFIG), { action: 'choose', questionId: 1, pos: q.target }, 5).score, 0, 'nothing scores before start');
  assert.equal(answer(state, q.startTick + MIN_REACTION_TICKS - 1).score, 0, 'an instant answer is not a human answer');
  assert.equal(answer(state, q.startTick + MIN_REACTION_TICKS).score, 1);
  assert.equal(engine.applyInput(state, { action: 'start' }, 30).startTick, 0, 'a second start does not restart anything');
  assert.throws(() => engine.advance(answer(state, 10), 3), /backwards/);
});

test('time belongs to the server: the horizon ends the run and never moves', () => {
  const run = engine.createRun(3, { game: 'tap-the-name', maxTicks: 100, roundTicks: 80 });
  const idle = engine.advance(run, 100);
  assert.equal(idle.gameOver, true); assert.equal(idle.last, 'horizon'); assert.equal(engine.score(idle), 0);
  let live = engine.applyInput(run, { action: 'start' }, 10);
  let tick = 10;
  while (!live.gameOver) {                                   // a perfect bot, one answer per question, as early as allowed
    const q = live.question as TapQuestion | null;
    if (q) { tick = Math.max(tick, q.startTick + MIN_REACTION_TICKS); live = answer(live, tick, q); }
    else { tick = live.nextRoundAt as number; live = engine.advance(live, tick); }
  }
  assert.ok(live.tick <= 10 + 80, 'start + roundTicks is the latest end'); assert.equal(live.last, 'horizon');
  assert.ok(engine.score(live) >= 5, 'valid automated answers are accepted by these rules (documented limitation)');
});

test('state is fully serialised: tick-by-tick JSON round trips equal one big jump, and the snapshot schema accepts it', () => {
  const state = answer(started(88), 4);
  const jumped = engine.advance(state, 300);
  let stepped = state;
  for (let t = state.tick + 1; t <= 300; t++) stepped = roundtrip(engine.advance(roundtrip(stepped), t));
  assert.deepEqual(stepped, jumped);
  const snapshot = { runId: '3f1c2d9e-0b41-4f7a-9d2e-5a6b7c8d9e0f', configDigest: 'b'.repeat(64), serverTick: 300, inputSeq: 1, inputTick: 4,
    expiresAt: new Date().toISOString(), state: jumped, result: { runId: '3f1c2d9e-0b41-4f7a-9d2e-5a6b7c8d9e0f', score: String(jumped.score), status: 'completed' } };
  snapshotSchema.parse(roundtrip(snapshot));
  assert.throws(() => snapshotSchema.parse({ ...snapshot, state: { ...jumped, score: -1 } }));
  assert.throws(() => snapshotSchema.parse({ ...snapshot, state: { ...jumped, extra: 1 } }));
  assert.ok(JSON.stringify(jumped).length < 1500);
});
