// Public per-game configuration (config.json at the root of every game archive). Identity and routing only: no
// treasury, key, token or secret ever belongs here -- payment terms come from Studio's authoritative quote.
// Adapted from studio-games-example/src/config.ts (MIT, Copyright 2026 SuperRare).
import { z } from 'zod';

const originSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    && !url.hostname.endsWith('.invalid');
}, 'Use an exact HTTPS origin, not a placeholder, path, or credential-bearing URL');

const publicHttpsUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hostname.endsWith('.invalid');
}, 'Must be a public HTTPS URL');

export const GAME_IDS = ['unbreakable', 'tap-the-name', 'full-row'] as const;
export type GameId = (typeof GAME_IDS)[number];

export const configurationSchema = z.object({
  appId: z.string().uuid(),
  groupId: z.string().uuid(),
  studioUrl: originSchema,
  apiUrl: originSchema,
  connectUrl: originSchema,
  appOrigin: originSchema,
  /** How SuperRare Connect's hosted sign-in and checkout open: a window over the page (embed) or a browser popup. */
  display: z.enum(['popup', 'embed']),
  game: z.enum(GAME_IDS),
  /** The arcade hub (the NFC cabinet page) and the other cabinet that shares this credit group. */
  hubUrl: publicHttpsUrl.optional(),
  siblingUrl: publicHttpsUrl.optional(),
  siblingLabel: z.string().min(1).max(40).optional(),
  /** Diagnostic build: the page journals its game-socket traffic and offers COPY LOG on the end screen. */
  diagnostics: z.boolean().optional(),
}).strict();
export type Configuration = z.infer<typeof configurationSchema>;

/** Defined (true) only by scripts/dev-flow.ts: the fake-Connect page may then be opened from a phone on the LAN. */
declare const __DEV_ANY_ORIGIN__: boolean | undefined;

export function parseConfiguration(value: unknown, currentOrigin?: string): Configuration {
  const configuration = configurationSchema.parse(value);
  const devBuild = typeof __DEV_ANY_ORIGIN__ !== 'undefined' && __DEV_ANY_ORIGIN__ === true;
  const localDevelopment = currentOrigin !== undefined
    && (devBuild || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(currentOrigin));
  if (currentOrigin !== undefined && !localDevelopment && configuration.appOrigin !== currentOrigin) {
    throw new Error('This game is not running at its configured Studio-approved appOrigin.');
  }
  return configuration;
}

/**
 * The scoring configuration published with each deployment (scoring-config.json, pasted into the verifier version).
 * Ticks are the platform's 50 ms server ticks. A run lasts at most `roundTicks` after its explicit start and never
 * more than `maxTicks` after creation: UNBREAKABLE 3 minutes, TAP THE NAME 90 seconds, FULL ROW an 8-minute cap (a run
 * normally ends before, when no piece fits; a run cut by the cap keeps its score).
 */
export function scoringConfiguration(game: GameId): { game: GameId; maxTicks: number; roundTicks: number } {
  if (game === 'unbreakable') return { game, maxTicks: 3900, roundTicks: 3600 };
  if (game === 'full-row') return { game, maxTicks: 9900, roundTicks: 9600 };
  return { game, maxTicks: 1900, roundTicks: 1800 };
}
