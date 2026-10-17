// TAP THE NAME on Connect: the deterministic game rules, shared by the browser (prediction) and the server verifier.
//
// A real name of the wall is shown with three decoys; tap the right one before the round timer runs out. Every correct
// answer shortens the next timer (3.2 s -> 1.1 s, x0.92), a wrong tap or a timeout ends the run. Same rules as the
// v1 game (wall-arcade/games/tap-the-name); what changes is who owns the clock and the questions: the platform's
// server ticks (50 ms), and this module's seeded generator -- never the browser.
import * as z from 'zod/mini';
import { xorshift32 } from '../../common/det.js';

export const TICK_MS = 50;
export const OPTIONS_COUNT = 4;
export const ROUND_START_MS = 3200, ROUND_MIN_MS = 1100, ROUND_DECAY = 0.92;
/** Pause between a correct answer and the next question (the v1 game waited 260 ms). */
export const PAUSE_TICKS = 5;
/** An answer earlier than this after the question opened is not a human answer: ignored, never scored. */
export const MIN_REACTION_TICKS = 2;

const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const panel = z.int().check(z.gte(1), z.lte(550));

export const configSchema = z.object({
  game: z.literal('tap-the-name'),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));
export type TapConfig = z.infer<typeof configSchema>;

const questionSchema = z.strictObject({
  id: posInt, startTick: nonNegInt, deadlineTick: posInt,
  target: panel, options: z.array(panel).check(z.length(OPTIONS_COUNT)),
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  rngState: z.uint32(), rules: configSchema,
  score: nonNegInt, roundMs: z.int().check(z.gte(ROUND_MIN_MS), z.lte(ROUND_START_MS)),
  lastTarget: z.nullable(panel), nextRoundAt: z.nullable(nonNegInt), nextId: posInt,
  question: z.nullable(questionSchema),
  last: z.enum(['none', 'correct', 'wrong', 'timeout', 'horizon']),
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks
  && new Set(s.question?.options ?? []).size === (s.question?.options.length ?? 0)
  && (s.question === null || s.question.options.includes(s.question.target)), 'Invalid TAP THE NAME state'));
export type TapState = z.infer<typeof stateSchema>;
export type TapQuestion = NonNullable<TapState['question']>;

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('choose'), questionId: posInt, pos: panel }),
]);
export type TapInput = z.infer<typeof inputSchema>;

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

/** The timer of the next question after a correct answer (the v1 recurrence, integer milliseconds). */
export function nextRoundMs(ms: number): number { return Math.max(ROUND_MIN_MS, Math.round(ms * ROUND_DECAY)); }
export function ticksForMs(ms: number): number { return Math.ceil(ms / TICK_MS); }

export type TapEvent = 'correct' | 'wrong' | 'timeout' | 'question';
export type EventSink = (type: TapEvent, pos?: number) => void;

export function createEngine(pool: readonly number[]) {
  if (pool.length < OPTIONS_COUNT * 2) throw new Error('TAP THE NAME needs a pool of at least 8 named panels');

  function openQuestion(state: TapState, startTick: number): void {
    let rng = state.rngState;
    const draw = (n: number): number => { rng = xorshift32(rng); return rng % n; };
    const candidates = pool.filter((p) => p !== state.lastTarget);
    const target = candidates[draw(candidates.length)] as number;
    const others = pool.filter((p) => p !== target);
    const options: number[] = [target];
    for (let i = 0; i < OPTIONS_COUNT - 1; i++) {              // partial Fisher-Yates: three distinct decoys
      const j = i + draw(others.length - i);
      const swap = others[j] as number; others[j] = others[i] as number; others[i] = swap;
      options.push(swap);
    }
    for (let i = options.length - 1; i > 0; i--) {              // shuffle the four options
      const j = draw(i + 1);
      const swap = options[j] as number; options[j] = options[i] as number; options[i] = swap;
    }
    state.rngState = rng;
    state.question = { id: state.nextId, startTick, deadlineTick: startTick + ticksForMs(state.roundMs), target, options };
    state.nextId++;
  }

  const endTickOf = (state: TapState): number =>
    state.startTick === null ? state.rules.maxTicks : Math.min(state.rules.maxTicks, state.startTick + state.rules.roundTicks);

  function advanceInPlace(state: TapState, serverTick: number, ev?: EventSink): TapState {
    if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) {
      throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
    }
    if (state.gameOver || serverTick === state.tick) return state;
    const endTick = endTickOf(state);
    const target = Math.min(serverTick, endTick);
    while (state.tick < target) {
      const q = state.question;
      const eventTick = q ? q.deadlineTick : state.nextRoundAt;
      if (eventTick === null || eventTick > target) { state.tick = target; break; }
      state.tick = Math.max(state.tick, eventTick);
      if (q) {                                                 // the question timer ran out
        state.gameOver = true; state.last = 'timeout'; if (ev) ev('timeout', q.target);
        return state;
      }
      state.nextRoundAt = null; openQuestion(state, state.tick); if (ev) ev('question');
    }
    if (state.tick >= endTick && !state.gameOver) { state.gameOver = true; if (state.last === 'none' || state.last === 'correct') state.last = 'horizon'; }
    return state;
  }

  function createRun(seed: unknown, config: unknown): TapState {
    const validSeed = z.uint32().parse(seed);
    const rules = configSchema.parse(config);
    return {
      tick: 0, gameOver: false, started: false, startTick: null, rngState: validSeed || 0x9e3779b9, rules,
      score: 0, roundMs: ROUND_START_MS, lastTarget: null, nextRoundAt: null, nextId: 1, question: null, last: 'none',
    };
  }
  function applyInputInPlace(state: TapState, input: unknown, serverTick: number, ev?: EventSink): TapState {
    advanceInPlace(state, serverTick, ev);
    if (state.gameOver) return state;
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return state;
    const action = parsed.data;
    if (action.action === 'start') {
      if (state.started) return state;
      state.started = true; state.startTick = state.tick; openQuestion(state, state.tick); if (ev) ev('question');
      return state;
    }
    const q = state.question;
    if (!state.started || !q || action.questionId !== q.id || !q.options.includes(action.pos)) return state;
    if (state.tick < q.startTick + MIN_REACTION_TICKS || state.tick >= q.deadlineTick) return state;
    if (action.pos === q.target) {
      state.score++; state.lastTarget = q.target; state.roundMs = nextRoundMs(state.roundMs);
      state.question = null; state.nextRoundAt = state.tick + PAUSE_TICKS; state.last = 'correct';
      if (ev) ev('correct', q.target);
    } else {
      state.gameOver = true; state.last = 'wrong'; if (ev) ev('wrong', action.pos);
    }
    return state;
  }
  const clone = (state: TapState): TapState => structuredClone(state);
  return {
    createRun,
    advance: (state: TapState, serverTick: number): TapState => {
      if (!Number.isSafeInteger(serverTick) || serverTick < state.tick) throw new Error('serverTick must be a nonnegative safe integer and must not move backwards');
      return state.gameOver || serverTick === state.tick ? state : advanceInPlace(clone(state), serverTick);
    },
    applyInput: (state: TapState, input: unknown, serverTick: number): TapState => applyInputInPlace(clone(state), input, serverTick),
    view: (state: TapState): TapState => state,
    isFinished: (state: TapState): boolean => state.gameOver,
    score: (state: TapState): number => state.score,
    advanceInPlace, applyInputInPlace, clone, endTickOf,
  };
}
export type TapEngine = ReturnType<typeof createEngine>;
