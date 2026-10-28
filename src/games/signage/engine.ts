// SIGNAGE for the page: the rules (core.ts, the very module the verifier runs) plus the zod schemas the shared shell
// uses to parse the coordinator's snapshots and the saved paid round. tests/signage.test.ts checks that these schemas
// accept and refuse exactly what core.ts's hand-written checks do.
import * as z from 'zod/mini';
import { BOTTOM, COLS, ROWS, RULES } from './core.js';

export * from './core.js';

/* ================================ SCHEMAS =================================== */
const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const col = z.int().check(z.gte(0), z.lte(COLS - 1));
const plazaRow = z.int().check(z.gte(1), z.lte(BOTTOM));
const dir = z.int().check(z.gte(0), z.lte(3));

export const configSchema = z.object({
  game: z.literal('signage'),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));

const walkerSchema = z.strictObject({
  id: nonNegInt.check(z.lte(1_000_000)), x: col, y: plazaRow, dir, to: col, life: posInt.check(z.lte(RULES.patience)),
});
const playSchema = z.strictObject({
  /** Signs in the order they went up: [cell, dir], cell = y × COLS + x, never on the wall row. */
  signs: z.array(z.tuple([z.int().check(z.gte(COLS), z.lte(ROWS * COLS - 1)), dir])).check(z.maxLength(RULES.maxSigns),
    z.refine((signs) => new Set(signs.map((s) => s[0])).size === signs.length, 'one sign per cell')),
  walkers: z.array(walkerSchema).check(z.maxLength(RULES.maxWalkers)),
  spawned: nonNegInt.check(z.lte(1_000_000)),
  lastStep: nonNegInt, nextStep: nonNegInt, nextSpawn: nonNegInt,
  steps: nonNegInt.check(z.lte(1_000_000)),
  score: nonNegInt,
  delivered: nonNegInt.check(z.lte(1_000_000)),
  missed: nonNegInt.check(z.lte(RULES.strikes)),
  streak: nonNegInt.check(z.lte(1_000_000)),
  bestStreak: nonNegInt.check(z.lte(1_000_000)),
  /** The last outcomes, oldest first: walker id × 4 + code (0 delivered, 1 left, 2 gave up). */
  log: z.array(nonNegInt.check(z.lte(4_000_003))).check(z.maxLength(RULES.logSize)),
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  seed: z.uint32(), rules: configSchema, play: playSchema,
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks
  && s.play.walkers.length <= s.play.spawned && s.play.delivered + s.play.missed <= s.play.spawned
  && (s.play.missed < RULES.strikes || s.gameOver)
  && (!s.started || s.gameOver || (s.play.lastStep <= s.tick && s.play.nextStep > s.tick && s.play.nextSpawn > s.tick))
  && (s.gameOver || s.tick < (s.startTick === null ? s.rules.maxTicks : Math.min(s.rules.maxTicks, s.startTick + s.rules.roundTicks))), 'Invalid SIGNAGE timeline'));

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('sign'), x: col, y: plazaRow, dir }),
  z.strictObject({ action: z.literal('clear'), x: col, y: plazaRow }),
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
