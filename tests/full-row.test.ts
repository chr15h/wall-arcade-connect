import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/common/det.js';
import {
  N, PIECES, RULES, checkState, createEngine, fits, fitsAnywhere, inputSchema, parseInput, snapshotSchema, stateSchema, trio, type FrState, type Piece,
} from '../src/games/full-row/engine.js';
import { fmtClock, lastMinute, ticksLeft } from '../src/games/full-row/clock.js';
import { COUPLES, NAME_PANELS, holderDrawOf, isoWeekKey, panelForDraw, wallNeighbors, weekOffset } from '../src/games/full-row/names.js';
import { scoringConfiguration } from '../src/shell/config.js';

const engine = createEngine();
const CONFIG = scoringConfiguration('full-row');
const roundtrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const started = (seed: number): FrState => engine.applyInput(engine.createRun(seed, CONFIG), { action: 'start' }, 0);
const id = (key: string): number => (PIECES.find((piece) => piece.key === key) as Piece).id;
/** A started run with a hand-made board (the rules only ever see rows, hand, combo). */
function board(rows: number[], hand: number[], combo = 0): FrState {
  const state = started(1);
  state.play.rows = rows.slice(); state.play.hand = hand.slice(); state.play.combo = combo;
  return state;
}
const place = (state: FrState, slot: number, x: number, y: number, tick = state.tick + 1): FrState =>
  engine.applyInput(state, { action: 'place', slot, x, y }, tick);
const empty = (): number[] => Array.from({ length: N }, () => 0);
const legalMoves = (state: FrState): { slot: number; x: number; y: number }[] => {
  const out: { slot: number; x: number; y: number }[] = [];
  state.play.hand.forEach((pid, slot) => {
    if (pid < 0) return;
    const piece = PIECES[pid] as Piece;
    for (let y = 0; y + piece.h <= N; y++) for (let x = 0; x + piece.w <= N; x++) if (fits(state.play.rows, piece, x, y)) out.push({ slot, x, y });
  });
  return out;
};
/** A random bot's whole run: the ordered inputs it sent and the final state. */
function randomRun(seed: number): { inputs: { input: unknown; tick: number }[]; state: FrState } {
  const rnd = mulberry32(seed ^ 0x51);
  let state = engine.createRun(seed, CONFIG);
  const inputs = [{ input: { action: 'start' }, tick: 1 }];
  state = engine.applyInput(state, inputs[0]!.input, 1);
  let tick = 1;
  while (!state.gameOver) {
    tick += 3;
    if (state.play.stuckTick !== null) { state = engine.advance(state, tick); continue; }
    const moves = legalMoves(state);
    const move = moves[Math.floor(rnd() * moves.length)]!;
    const input = { action: 'place', ...move };
    inputs.push({ input, tick });
    state = engine.applyInput(state, input, tick);
  }
  return { inputs, state };
}

test('the piece set is the 1010! / Block Blast family: 25 shapes, no duplicate, the listed sizes', () => {
  assert.equal(PIECES.length, 25);
  const shapes = new Set(PIECES.map((piece) => JSON.stringify([...piece.cells].map((c) => [...c]).sort())));
  assert.equal(shapes.size, 25, 'every shape once');
  const count = (family: string): number => PIECES.filter((piece) => piece.family === family).length;
  assert.deepEqual(['dot', 'i2', 'i3', 'i4', 'i5', 'o2', 'o3', 'r23', 'l3', 'l5', 't4'].map(count), [1, 2, 2, 2, 2, 1, 1, 2, 4, 4, 4]);
  for (const piece of PIECES) {
    const expected = { dot: 1, i2: 2, i3: 3, i4: 4, i5: 5, o2: 4, o3: 9, r23: 6, l3: 3, l5: 5, t4: 4 }[piece.family];
    assert.equal(piece.size, expected, piece.key);
    assert.ok(piece.w <= 5 && piece.h <= 5);
  }
});

test('replay: the same seed and the same ordered inputs give the same state and score, also through JSON', () => {
  for (const seed of [0, 1, 7, 4242, 0xdeadbeef, 2026]) {
    const { inputs, state } = randomRun(seed);
    let replay = engine.createRun(seed, CONFIG), viaJson = roundtrip(replay);
    for (const { input, tick } of inputs) {
      replay = engine.applyInput(replay, input, tick);
      viaJson = roundtrip(engine.applyInput(viaJson, input, tick));
    }
    replay = engine.advance(replay, state.tick); viaJson = engine.advance(viaJson, state.tick);
    assert.deepEqual(replay, state, `seed ${seed}`);
    assert.deepEqual(viaJson, state, `seed ${seed} via JSON`);
    assert.equal(engine.score(replay), state.play.score);
    assert.deepEqual(stateSchema.parse(roundtrip(state)), state, 'the state round-trips through its own schema');
  }
  assert.notDeepEqual(randomRun(1).state.play.rows.concat(randomRun(1).state.play.score), randomRun(2).state.play.rows.concat(randomRun(2).state.play.score));
});

test('a legal placement paints its cells and scores +1 a cell; an illegal one changes nothing', () => {
  const state = board(empty(), [id('O3'), id('I2-'), id('1')]);
  const after = place(state, 0, 2, 3);
  assert.deepEqual(after.play.rows, [0, 0, 0, 0b11100, 0b11100, 0b11100, 0, 0]);
  assert.equal(after.play.score, 9); assert.equal(after.play.placed, 1); assert.deepEqual(after.play.last, [0, 2, 3]);
  assert.deepEqual(after.play.hand, [-1, id('I2-'), id('1')]);
  const same = (s: FrState): void => { assert.deepEqual(s.play, after.play); };
  same(place(after, 0, 0, 0));                                    // the slot is empty now
  same(place(after, 2, 3, 4));                                    // overlap
  same(place(after, 1, 7, 0));                                    // out of the grid (a 2-wide piece at x = 7)
  same(engine.applyInput(after, { action: 'place', slot: 1, x: 0, y: 0, score: 999 }, after.tick + 1));   // extra field
  same(engine.applyInput(after, { action: 'place', slot: 3, x: 0, y: 0 }, after.tick + 1));
  same(engine.applyInput(after, { action: 'rotate', slot: 1 }, after.tick + 1));                         // no rotation exists
  const unstarted = engine.createRun(1, CONFIG);
  assert.deepEqual(engine.applyInput(unstarted, { action: 'place', slot: 0, x: 0, y: 0 }, 1).play, unstarted.play, 'nothing before start');
  assert.equal(inputSchema.safeParse({ action: 'place', slot: 0, x: 8, y: 0 }).success, false);
});

test('full row, full column, both at once, and an emptied grid', () => {
  // a row: 1 + 80
  let s = place(board([0b0111_1111, 0, 0, 0, 0, 1, 0, 0], [id('1'), id('1'), id('1')]), 0, 7, 0);
  assert.deepEqual(s.play.rows, [0, 0, 0, 0, 0, 1, 0, 0]); assert.equal(s.play.score, 81); assert.equal(s.play.lines, 1); assert.equal(s.play.combo, 1);
  // a column: 1 + 80
  s = place(board([0, 1, 1, 0b11, 1, 1, 1, 1], [id('1'), id('1'), id('1')]), 0, 0, 0);
  assert.deepEqual(s.play.rows, [0, 0, 0, 0b10, 0, 0, 0, 0]); assert.equal(s.play.score, 81);
  // a row and a column through the same cell: 2 lines (×1.5) = 1 + 2 × 80 × 1.5
  s = place(board([0b1111_1110, 1, 1, 1, 1, 1, 0b11, 1], [id('1'), id('1'), id('1')]), 0, 0, 0);
  assert.deepEqual(s.play.rows, [0, 0, 0, 0, 0, 0, 0b10, 0]); assert.equal(s.play.score, 241); assert.equal(s.play.lines, 2);
  // the same, leaving nothing: + the grid bonus
  s = place(board([0b1111_1110, 1, 1, 1, 1, 1, 1, 1], [id('1'), id('1'), id('1')]), 0, 0, 0);
  assert.deepEqual(s.play.rows, empty()); assert.equal(s.play.score, 241 + RULES.allClear);
});

test('simultaneity bonus: 3 lines ×2, 4 lines ×3', () => {
  const almost = 0b0111_1111;
  let s = place(board([almost, almost, almost, 0, 0, 0, 1, 0], [id('I3|'), id('1'), id('1')]), 0, 7, 0);
  assert.equal(s.play.score, 3 + 3 * 80 * 2); assert.equal(s.play.lines, 3);
  s = place(board([almost, almost, almost, almost, 0, 0, 1, 0], [id('I4|'), id('1'), id('1')]), 0, 7, 0);
  assert.equal(s.play.score, 4 + 4 * 80 * 3); assert.equal(s.play.lines, 4);
});

test('combo: consecutive clearing placements multiply the line points by 1 + 0.5 × combo, a miss resets it, capped', () => {
  const almost = 0b0111_1111;
  let s = board([almost, almost, almost, 0, 0, 0, 1, 0], [id('1'), id('1'), id('1')]);
  s = place(s, 0, 7, 0); assert.equal(s.play.score, 81); assert.equal(s.play.combo, 1);
  s = place(s, 1, 7, 1); assert.equal(s.play.score, 81 + 1 + 120); assert.equal(s.play.combo, 2);     // 80 × 1.5
  s = place(s, 2, 0, 7); assert.equal(s.play.combo, 0, 'a placement that clears nothing resets the combo');
  const before = s.play.score;
  s.play.hand = [id('1'), id('1'), id('1')];
  s = place(s, 0, 7, 2); assert.equal(s.play.score, before + 81, 'back to ×1');
  const capped = place(board([almost, 0, 0, 0, 0, 0, 1, 0], [id('1'), id('1'), id('1')], RULES.comboCap), 0, 7, 0);
  assert.equal(capped.play.score, 1 + 80 * (1 + 0.5 * RULES.comboCap)); assert.equal(capped.play.combo, RULES.comboCap);
});

test('three pieces placed: three new ones arrive, drawn from the seed only (no hidden rescue)', () => {
  const a = started(99), b = started(99);
  assert.deepEqual(a.play.hand, trio(99, 0)); assert.equal(a.play.drawn, 3);
  // two different ways to place the first trio: the next trio is the same
  const playAll = (s: FrState, reverse: boolean): FrState => {
    for (const slot of reverse ? [2, 1, 0] : [0, 1, 2]) { const move = legalMoves(s).find((m) => m.slot === slot)!; s = place(s, move.slot, move.x, move.y); }
    return s;
  };
  const after = playAll(a, false), afterOther = playAll(b, true);
  assert.equal(after.play.drawn, 6); assert.deepEqual(after.play.hand, trio(99, 1)); assert.deepEqual(afterOther.play.hand, trio(99, 1));
});

test('generator: deterministic, at least one small piece in every trio, draw frequencies follow the weights', () => {
  assert.deepEqual(trio(5, 12), trio(5, 12));
  assert.notDeepEqual([0, 1, 2, 3].map((t) => trio(5, t)), [0, 1, 2, 3].map((t) => trio(6, t)));
  const counts = new Map<string, number>();
  let trios = 0;
  for (let seed = 0; seed < 400; seed++) for (let t = 0; t < 100; t++) {
    const hand = trio(seed, t); trios++;
    assert.ok(hand.filter((pid) => (PIECES[pid] as Piece).size <= RULES.smallMax).length >= RULES.minSmall, `seed ${seed} trio ${t}`);
    const first = PIECES[hand[0]] as Piece;                        // slot 0 is never replaced by the guarantee
    counts.set(first.family, (counts.get(first.family) ?? 0) + 1);
  }
  const total = PIECES.reduce((sum, piece) => sum + (RULES.weights[piece.family] ?? 0), 0);
  for (const family of new Set(PIECES.map((piece) => piece.family))) {
    const expected = PIECES.filter((piece) => piece.family === family).reduce((sum, piece) => sum + (RULES.weights[piece.family] ?? 0), 0) / total;
    const seen = (counts.get(family) ?? 0) / trios;
    assert.ok(Math.abs(seen - expected) < 0.01 + expected * 0.08, `${family}: ${seen.toFixed(4)} vs ${expected.toFixed(4)}`);
  }
});

test('the end: nothing fits -> the run ends half a second of server time later; inputs are over', () => {
  // a checkerboard: only single cells are free, placing the dot completes no line, and a 2×2 fits nowhere
  const rows = [0b1010_1010, 0b0101_0101, 0b1010_1010, 0b0101_0101, 0b1010_1010, 0b0101_0101, 0b1010_1010, 0b0101_0101];
  let s = board(rows, [id('1'), id('O2'), id('O2')]);
  assert.equal(fitsAnywhere(rows, PIECES[id('O2')] as Piece), false);
  s = place(s, 0, 0, 0, 100);
  assert.equal(s.play.stuckTick, 100); assert.equal(s.gameOver, false);
  const frozen = s.play.score;
  assert.equal(place(s, 0, 2, 0, 101).play.placed, s.play.placed, 'no placement after the end');
  assert.equal(engine.advance(s, 100 + RULES.endDelayTicks - 1).gameOver, false);
  const over = engine.advance(s, 100 + RULES.endDelayTicks + 50);
  assert.equal(over.gameOver, true); assert.equal(over.tick, 100 + RULES.endDelayTicks); assert.equal(engine.score(over), frozen);
  assert.equal(engine.isFinished(over), true); assert.equal(engine.advance(over, over.tick + 500), over, 'terminal stays terminal');
});

test('the 8-minute server cap ends a run and keeps its score; the horizon ends an unstarted one', () => {
  let s = started(3);
  const move = legalMoves(s)[0]!;
  s = place(s, move.slot, move.x, move.y, 10);
  const score = s.play.score;
  assert.equal(engine.advance(s, CONFIG.roundTicks - 1).gameOver, false);
  const cut = engine.advance(s, CONFIG.roundTicks + 1);
  assert.equal(cut.gameOver, true); assert.equal(cut.tick, CONFIG.roundTicks); assert.equal(engine.score(cut), score);
  assert.equal(place(cut, 0, 0, 0, CONFIG.roundTicks + 2).play.placed, cut.play.placed);
  const idle = engine.advance(engine.createRun(3, CONFIG), CONFIG.maxTicks + 10);
  assert.equal(idle.gameOver, true); assert.equal(idle.tick, CONFIG.maxTicks);
  assert.throws(() => engine.advance(s, 5), 'time never moves backwards');
});

test('createRun validates seed and config; seed 0 (the conformance probe) is a normal run; state and snapshot fit the bounds', () => {
  assert.throws(() => engine.createRun(-1, CONFIG)); assert.throws(() => engine.createRun(1.5, CONFIG));
  assert.throws(() => engine.createRun(1, { ...CONFIG, game: 'unbreakable' })); assert.throws(() => engine.createRun(1, { ...CONFIG, maxTicks: 5 }));
  const zero = engine.createRun(0, CONFIG);
  assert.equal(zero.started, false); assert.equal(engine.score(zero), 0); assert.equal(engine.isFinished(zero), false);
  assert.ok(zero.play.hand.every((pid) => pid >= 0 && pid < PIECES.length));
  const { state } = randomRun(77);
  assert.ok(JSON.stringify(state).length < 1024, 'a whole state is a few hundred bytes');
  const packet = { runId: '44444444-4444-4444-8444-444444444444', configDigest: 'c'.repeat(64), serverTick: state.tick, inputSeq: 9, inputTick: state.tick,
    expiresAt: new Date().toISOString(), state, result: { score: String(state.play.score), status: 'completed' } };
  assert.ok(snapshotSchema.safeParse(roundtrip(packet)).success);
  assert.equal(stateSchema.safeParse({ ...state, play: { ...state.play, rows: [256, 0, 0, 0, 0, 0, 0, 0] } }).success, false);
  assert.equal(stateSchema.safeParse({ ...state, play: { ...state.play, drawn: 4 } }).success, false);
});

test('names are a skin: a draw index gives the same panel to everyone the same week; YOUR NAME is a client override', () => {
  assert.equal(isoWeekKey(new Date('2026-10-19T08:00:00Z')), 202643);
  assert.equal(isoWeekKey(new Date('2021-01-03T12:00:00Z')), 202053);
  assert.equal(isoWeekKey(new Date('2026-01-01T00:00:00Z')), 202601);
  const off = weekOffset(202643);
  assert.ok(off >= 0 && off < NAME_PANELS.length); assert.notEqual(weekOffset(202644), off);
  assert.equal(panelForDraw(5, off, null), panelForDraw(5, off, null));
  assert.equal(panelForDraw(0, 0, null), NAME_PANELS[0]); assert.equal(panelForDraw(NAME_PANELS.length, 0, null), NAME_PANELS[0], 'wraps around');
  for (let seed = 0; seed < 50; seed++) { const d = holderDrawOf(seed); assert.ok(d >= 2 && d <= 9, 'in the first ten draws'); }
  assert.equal(panelForDraw(4, off, { draw: 4, pos: 10 }), 10); assert.equal(panelForDraw(5, off, { draw: 4, pos: 10 }), panelForDraw(5, off, null));
  assert.ok(NAME_PANELS.every((p) => p >= 1 && p <= 500));
  assert.equal(wallNeighbors(291, 292), true); assert.equal(wallNeighbors(292, 291), false); assert.equal(wallNeighbors(25, 26), false, 'not across a wall row');
  assert.ok(COUPLES.some(([a, b]) => a === 'LUDO' && b === 'MARIE-LOU'));
});

test('the cap is 8 minutes of server time; LAST MINUTE shows only in its last 60 s', () => {
  assert.equal(CONFIG.roundTicks * 50, 8 * 60 * 1000); assert.equal(CONFIG.maxTicks - CONFIG.roundTicks, 300);
  const s = started(4);                                                    // started at tick 0
  assert.equal(lastMinute(ticksLeft(s, 0)), false);
  assert.equal(lastMinute(ticksLeft(s, CONFIG.roundTicks - 1201)), false, '1:00.05 left: not yet');
  assert.equal(lastMinute(ticksLeft(s, CONFIG.roundTicks - 1200)), true, 'exactly one minute left');
  assert.equal(lastMinute(ticksLeft(s, CONFIG.roundTicks - 1)), true);
  assert.equal(fmtClock(ticksLeft(s, CONFIG.roundTicks - 1200)), '1:00'); assert.equal(fmtClock(ticksLeft(s, CONFIG.roundTicks - 840)), '0:42');
  const late = engine.applyInput(engine.createRun(4, CONFIG), { action: 'start' }, 250);
  assert.equal(ticksLeft(late, 250 + CONFIG.roundTicks - 1200), 1200, 'counted from the start, not from creation');
});

test('the verifier\'s hand-written checks accept and refuse exactly what the page\'s zod schemas do', () => {
  const states: unknown[] = [];
  for (const seed of [1, 2, 3, 0xffffffff]) {
    const { state } = randomRun(seed);
    states.push(state, engine.createRun(seed, CONFIG), started(seed));
  }
  const base = randomRun(9).state as unknown as Record<string, any>;
  const mutate = (f: (s: Record<string, any>) => void): unknown => { const s = roundtrip(base); f(s); return s; };
  states.push(
    mutate((s) => { s.extra = 1; }), mutate((s) => { s.play.extra = 1; }), mutate((s) => { delete s.play.last; }),
    mutate((s) => { s.rules.extra = 1; }), mutate((s) => { s.rules.game = 'unbreakable'; }), mutate((s) => { s.rules.maxTicks = 5; }),
    mutate((s) => { s.tick = -1; }), mutate((s) => { s.tick = 1.5; }), mutate((s) => { s.tick = s.rules.maxTicks + 1; }),
    mutate((s) => { s.seed = 2 ** 32; }), mutate((s) => { s.seed = '1'; }), mutate((s) => { s.gameOver = 0; }),
    mutate((s) => { s.started = false; }), mutate((s) => { s.startTick = s.tick + 1; }),
    mutate((s) => { s.play.rows = [0, 0, 0, 0, 0, 0, 0]; }), mutate((s) => { s.play.rows[3] = 256; }), mutate((s) => { s.play.rows[3] = -1; }),
    mutate((s) => { s.play.hand = [0, 0]; }), mutate((s) => { s.play.hand[1] = 25; }), mutate((s) => { s.play.hand[1] = -2; }),
    mutate((s) => { s.play.drawn = 4; }), mutate((s) => { s.play.drawn = 0; }), mutate((s) => { s.play.combo = RULES.comboCap + 1; }),
    mutate((s) => { s.play.score = -5; }), mutate((s) => { s.play.score = 2 ** 60; }), mutate((s) => { s.play.last = [0, 0]; }),
    mutate((s) => { s.play.last = [3, 0, 0]; }), mutate((s) => { s.play.last = [0, 8, 0]; }), mutate((s) => { s.play.last = null; }),
    mutate((s) => { s.play.stuckTick = -1; }), mutate((s) => { s.play.stuckTick = 7; }), null, [], 'state', {},
  );
  for (const value of states) {
    const viaZod = stateSchema.safeParse(value);
    let viaCheck: unknown = null;
    try { viaCheck = checkState(value); } catch { viaCheck = null; }
    assert.equal(viaCheck !== null, viaZod.success, `disagreement on ${JSON.stringify(value)?.slice(0, 120)}`);
    if (viaZod.success) assert.deepEqual(viaCheck, viaZod.data, 'same cleaned state');
  }
  for (const input of [{ action: 'start' }, { action: 'start', x: 1 }, { action: 'place', slot: 0, x: 0, y: 0 }, { action: 'place', slot: 3, x: 0, y: 0 },
    { action: 'place', slot: 0, x: 8, y: 0 }, { action: 'place', slot: 0, x: 0 }, { action: 'place', slot: 0, x: 0, y: 0, score: 1 }, { action: 'rotate' }, null, 'start']) {
    assert.equal(parseInput(input) !== null, inputSchema.safeParse(input).success, JSON.stringify(input));
  }
});
