// Netlify entry of the card service (cards/src/service.ts): cards stored in Netlify Blobs, the wall's names from the
// build-time snapshot plus the live public /positions of the NFC backend (read-only, cached a few minutes); a row card's
// sprites from PEOPLE's store on the same site.
import { lisbonWeek } from '../../src/week.js';
import { getStore } from '@netlify/blobs';
import snapshot from '../../../src/generated/wall.json' with { type: 'json' };
import { handle, type CardStore, type LeaderEntry } from '../../src/service.js';
import { GAMES, type GameKey } from '../../src/validate.js';
import { peopleSprites } from '../../src/people-service.js';
import { peopleStore } from '../../src/people-store.js';

const SNAPSHOT_NAMES: string[] = snapshot.positions.map((p: { n: string }) => p.n);
let live: { at: number; names: string[] } | null = null;
async function wallNames(): Promise<string[]> {
  if (live && Date.now() - live.at < 300_000) return live.names;
  try {
    const response = await fetch('https://otw-arcade.netlify.app/positions', { signal: AbortSignal.timeout(2500) });
    const items = await response.json() as { minted?: boolean; name?: string }[];
    const names = items.filter((i) => i.minted && typeof i.name === 'string' && i.name).map((i) => i.name as string);
    live = { at: Date.now(), names: [...new Set([...SNAPSHOT_NAMES, ...names])] };
    return live.names;
  } catch {
    return live?.names ?? SNAPSHOT_NAMES;
  }
}

// @netlify/blobs takes the read type as an option object: adapt it to the service's CardStore
function cardStore(): CardStore {
  const store = getStore({ name: 'cards', consistency: 'strong' });
  return {
    get: ((key: string, type: 'json' | 'arrayBuffer') => store.get(key, { type: type as 'json' })) as CardStore['get'],
    set: (key, value) => (typeof value === 'string' ? store.set(key, value) : store.set(key, value as ArrayBuffer)),
  };
}

// a board card's rows: the platform's public, read-only leaderboard of that game (what the hub already shows)
async function leaderboard(game: GameKey): Promise<LeaderEntry[]> {
  const g = GAMES[game];
  const week = lisbonWeek();                                            // THIS WEEK, as on the games and the hub
  const response = await fetch(`${g.url.replace(/\/$/, '')}/api/v1/games/${g.appId}/scoring/leaderboard?${new URLSearchParams(week)}`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`leaderboard HTTP ${response.status}`);
  return ((await response.json()) as { entries?: LeaderEntry[] }).entries ?? [];
}

// a row card's sprites: people.json and the mirrored sheets of this very site (store "people", cards/src/people-service.ts)
let people: ReturnType<typeof peopleSprites> | null = null;
export default async (request: Request): Promise<Response> => handle(request, { store: cardStore(), wallNames, leaderboard, people: people ??= peopleSprites(peopleStore()) });

export const config = { path: ['/api/cards', '/r/*'] };
