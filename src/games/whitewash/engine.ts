// NFT INVADERS for the page: the rules (core.ts, the very module the verifier runs) plus the zod schemas the shared
// shell uses to parse the coordinator's snapshots and the saved paid round. tests/whitewash.test.ts checks that these
// schemas accept and refuse exactly what core.ts's hand-written checks do.
import * as z from 'zod/mini';
import { ALL_BRICKS, DIVING, H, RULES, W, WW_GAMES } from './core.js';

export * from './core.js';

/* ================================ SCHEMAS =================================== */
const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const MAX_CLEANERS = RULES.formationCols * RULES.maxRows;
const point = z.tuple([z.int().check(z.gte(-100), z.lte(W + 100)), z.int().check(z.gte(-200), z.lte(H + 200))]);

export const configSchema = z.object({
  game: z.enum(WW_GAMES),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));

const cleanerSchema = z.strictObject({
  id: nonNegInt.check(z.lte(10_000_000)),
  slot: nonNegInt.check(z.lte(MAX_CLEANERS - 1)),
  mode: z.int().check(z.gte(0), z.lte(2)),
  x: z.int().check(z.gte(-100), z.lte(W + 100)),
  y: z.int().check(z.gte(-200), z.lte(H + 200)),
  to: z.int().check(z.gte(-1), z.lte(RULES.bricks - 1)),
  dropAt: z.int().check(z.gte(-1)),
}).check(z.refine((c) => (c.mode === DIVING) === (c.to >= 0), 'a diver, and only a diver, has a target'));
const playSchema = z.strictObject({
  x: z.int().check(z.gte(0), z.lte(W)), target: z.int().check(z.gte(0), z.lte(W)),
  stunUntil: nonNegInt, fireAt: nonNegInt,
  shots: z.array(point).check(z.maxLength(RULES.maxShots)),
  drips: z.array(point).check(z.maxLength(MAX_CLEANERS)),
  cleaners: z.array(cleanerSchema).check(z.maxLength(MAX_CLEANERS),
    z.refine((cs) => new Set(cs.map((c) => c.slot)).size === cs.length, 'one cleaner per slot')),
  wave: nonNegInt.check(z.lte(1_000_000)), waveStart: nonNegInt, waveAt: z.int().check(z.gte(-1)),
  dives: nonNegInt.check(z.lte(10_000_000)), nextDive: nonNegInt,
  /** Standing names: bit b = brick b. */
  bricks: z.int().check(z.gte(0), z.lte(ALL_BRICKS)),
  score: nonNegInt, downed: nonNegInt.check(z.lte(10_000_000)), cleared: nonNegInt.check(z.lte(1_000_000)), washed: nonNegInt.check(z.lte(10_000_000)),
  /** Cleaners downed since a name was last whitewashed. */
  streak: nonNegInt.check(z.lte(10_000_000)),
  /** Server tick of the last input (the start counts): the run ends `idleTicks` after it. */
  lastInput: nonNegInt,
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  seed: z.uint32(), rules: configSchema, play: playSchema,
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks
  && (s.play.bricks !== 0 || s.gameOver)
  && (s.startTick === null || (s.play.lastInput >= s.startTick && s.play.lastInput <= s.tick))
  && (s.gameOver || s.tick < (s.startTick === null ? s.rules.maxTicks
    : Math.min(s.rules.maxTicks, s.startTick + s.rules.roundTicks, s.play.lastInput + RULES.idleTicks))), 'Invalid NFT INVADERS timeline'));

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('move'), x: z.int().check(z.gte(0), z.lte(W)) }),
]);

/* The coordinator's snapshot envelope (same shape as the other games'; only `state` differs). */
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
