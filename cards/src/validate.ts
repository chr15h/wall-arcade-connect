// What a card may say, and nothing else. Every field is checked: the names must be names of the wall, numbers are
// integers in range, the player is an ENS name or a shortened address. Unknown fields are refused.
export const GAMES = {
  'full-row': { title: 'FULL ROW', url: 'https://yfq52eu3.srstudio.dev/', appId: '5932be45-7ccb-483a-916d-0dcebff40ca2' },
  unbreakable: { title: 'UNBREAKABLE', url: 'https://7x2phv5j.srstudio.dev/', appId: 'c5285ae3-512e-464a-aceb-17571e1fe3e9' },
} as const;
export type GameKey = keyof typeof GAMES;

/** `grid`: the final 8 × 8 grid as 8 row bytes; `rank`: the player's rank this week, as the page read it from the
 *  platform's leaderboard. `points` (the best row's points) is accepted from older pages and no longer drawn. */
export type RowCard = { kind: 'row'; names: string[]; line?: string; score: number; grid?: number[]; rank?: number; player?: string; practice: boolean };
export type BounceCard = { kind: 'bounce'; names: string[]; people: number; score: number; rank?: number; player?: string; practice: boolean };
/** A leaderboard card as asked for: which game, and optionally which player to highlight. The rows themselves are read
 *  by the service from the platform's public leaderboard, never taken from the request. */
export type BoardRequest = { kind: 'board'; game: GameKey; me?: string };
export type BoardCard = { kind: 'board'; game: GameKey; rows: { rank: number; name: string; score: number; me?: boolean }[] };
export type Card = RowCard | BounceCard | BoardCard;

export class CardError extends Error {}
const fail = (why: string): never => { throw new CardError(why); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, min: number, max: number, what: string): number => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fail(`${what} must be an integer in [${min}, ${max}]`));
function keys(v: Record<string, unknown>, required: string[], optional: string[] = []): void {
  for (const k of required) if (!(k in v)) fail(`missing ${k}`);
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) fail(`unexpected field ${k}`);
}

const ENS = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?)*\.eth$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SHORT = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/;
/** An ENS name (lowercase, ≤ 40 characters) or a shortened address 0x1234…abcd (a full address is shortened here). */
export function player(v: unknown): string {
  if (typeof v !== 'string') return fail('player must be a string');
  const s = v.trim();
  if (ADDRESS.test(s)) return `${s.slice(0, 6)}…${s.slice(-4)}`.toLowerCase();
  if (SHORT.test(s)) return s.toLowerCase();
  if (s.length <= 40 && ENS.test(s.toLowerCase())) return s.toLowerCase();
  return fail('player must be an ENS name or a shortened address');
}

/** The optional rank (never on a practice card) and player of a row or bounce card. */
function extras(body: Record<string, unknown>): { rank?: number; player?: string } {
  return {
    ...(body.rank !== undefined && body.practice !== true ? { rank: int(body.rank, 1, 100_000, 'rank') } : {}),
    ...(body.player !== undefined ? { player: player(body.player) } : {}),
  };
}

/** Checks a request body against the wall's names (uppercase). Returns the canonical card. */
export function validate(body: unknown, wallNames: ReadonlySet<string>): RowCard | BounceCard | BoardRequest {
  if (!isObject(body)) return fail('a card is a JSON object');
  const names = (v: unknown, max: number): string[] => {
    if (!Array.isArray(v) || v.length > max) return fail(`names: 0 to ${max}`);
    return v.map((n) => {
      if (typeof n !== 'string') return fail('a name is a string');
      const up = n.trim().toUpperCase();
      return wallNames.has(up) ? up : fail(`not a name of the wall: ${n.slice(0, 40)}`);
    });
  };
  switch (body.kind) {
    case 'row': {
      // no full row this time: no names and no line, the card shows the final grid and the score
      keys(body, ['kind', 'names', 'score'], ['line', 'points', 'grid', 'rank', 'player', 'practice']);
      const list = names(body.names, 8);
      const line = body.line === undefined ? undefined
        : typeof body.line === 'string' && /^(ROW|COL) [1-8]$/.test(body.line) ? body.line : fail('line: ROW n or COL n');
      if ((list.length > 0) !== Boolean(line)) fail('a line goes with its names: both or neither');
      if (body.points !== undefined) int(body.points, 0, 100_000, 'points');
      const grid = body.grid === undefined ? undefined
        : Array.isArray(body.grid) && body.grid.length === 8 ? body.grid.map((row) => int(row, 0, 255, 'a grid row')) : fail('grid: 8 row bytes');
      return {
        kind: 'row', names: list, ...(line ? { line } : {}), score: int(body.score, 0, 1_000_000_000, 'score'),
        ...(grid ? { grid } : {}), ...extras(body), practice: body.practice === true,
      };
    }
    case 'bounce': {
      keys(body, ['kind', 'names', 'people', 'score'], ['rank', 'player', 'practice']);
      const list = names(body.names, 60);
      const people = int(body.people, 0, 10_000, 'people');
      if (people < new Set(list).size) fail('people is fewer than the names');
      return { kind: 'bounce', names: list, people, score: int(body.score, 0, 1_000_000_000, 'score'), ...extras(body), practice: body.practice === true };
    }
    case 'board': {
      keys(body, ['kind', 'game'], ['me']);
      const game = body.game === 'full-row' || body.game === 'unbreakable' ? body.game : fail('game: full-row or unbreakable');
      return { kind: 'board', game, ...(body.me !== undefined ? { me: player(body.me) } : {}) };
    }
    default: return fail('kind: row, bounce or board');
  }
}

export const gameOf = (card: Card | BoardRequest): GameKey => (card.kind === 'row' ? 'full-row' : card.kind === 'bounce' ? 'unbreakable' : card.game);
