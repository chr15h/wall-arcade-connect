// FULL ROW for the page: the rules (core.ts, the very module the verifier runs) plus the zod schemas the shared shell
// uses to parse the coordinator's snapshots and the saved paid round. tests/full-row.test.ts checks that these schemas
// accept and refuse exactly what core.ts's hand-written checks do.
import * as z from 'zod/mini';
import { FULL, N, PIECE_COUNT, RULES } from './core.js';

export * from './core.js';

/* ================================ SCHEMAS =================================== */
const nonNegInt = z.int().check(z.gte(0));
const posInt = z.int().check(z.gte(1));
const coord = z.int().check(z.gte(0), z.lte(N - 1));

export const configSchema = z.object({
  game: z.literal('full-row'),
  maxTicks: posInt.check(z.lte(100_000)),
  roundTicks: posInt.check(z.lte(100_000)),
}).check(z.refine((rules) => rules.maxTicks >= rules.roundTicks, 'maxTicks must be at least roundTicks'));

const playSchema = z.strictObject({
  /** The 64-bit grid as 8 row bytes: bit x of rows[y] is the cell (x, y). */
  rows: z.array(z.int().check(z.gte(0), z.lte(FULL))).check(z.length(N)),
  /** The tray: a piece id per slot, -1 once placed. */
  hand: z.array(z.int().check(z.gte(-1), z.lte(PIECE_COUNT - 1))).check(z.length(3)),
  /** Pieces drawn so far (the tray of slot s holds draw `drawn - 3 + s`): the client hangs the names on this index. */
  drawn: nonNegInt.check(z.lte(1_000_000)),
  score: nonNegInt,
  combo: nonNegInt.check(z.lte(RULES.comboCap)),
  placed: nonNegInt.check(z.lte(1_000_000)),
  lines: nonNegInt.check(z.lte(1_000_000)),
  /** The last accepted placement [slot, x, y] (display only: lets the client attribute the cells to a piece). */
  last: z.nullable(z.tuple([z.int().check(z.gte(0), z.lte(2)), coord, coord])),
  /** Server tick at which no piece in hand fit any more; the run ends `endDelayTicks` later. */
  stuckTick: z.nullable(nonNegInt),
});
export const stateSchema = z.strictObject({
  tick: nonNegInt, gameOver: z.boolean(), started: z.boolean(), startTick: z.nullable(nonNegInt),
  seed: z.uint32(), rules: configSchema, play: playSchema,
}).check(z.refine((s) => s.started === (s.startTick !== null)
  && (s.startTick === null || s.startTick <= s.tick) && s.tick <= s.rules.maxTicks
  && s.play.drawn >= 3 && s.play.drawn % 3 === 0, 'Invalid FULL ROW timeline'));

export const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start') }),
  z.strictObject({ action: z.literal('place'), slot: z.int().check(z.gte(0), z.lte(2)), x: coord, y: coord }),
]);

/* The coordinator's snapshot envelope (same shape as UNBREAKABLE's; only `state` differs). */
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

