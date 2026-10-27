// Reads everything /stats sums (cards/src/stats.ts) and stores the result as stats.json (store "stats"); the scheduled
// function (netlify/functions/stats-refresh.mts) runs it every 15 minutes, /stats?refresh=1 at most once a minute.
// Sources, all read-only: SuperRare's usage report of the credit group (needs RARE_PROFILE_TOKEN, a Netlify variable,
// never in the repository), the treasury's incoming transfers on Blockscout (the packs), the two public leaderboards,
// the jackpot, PEOPLE's documents and our own tags. A source that fails is marked in `sources`, the rest still counts.
import { createProfileClient } from '@rareprotocol/rare-profile';
import { eventsBetween, type EventStore } from './events.js';
import type { PeopleStore } from './people-service.js';
import type { Person } from './people.js';
import { currentPot, TREASURY, type PotDeps } from './pot.js';
import { GAMES } from './validate.js';
import { buildStats, LAUNCH, lisbonDay, lisbonDayStart, windows, type GameInfo, type LeaderRow, type Pack, type Stats, type StatsInputs, type Usage, type WindowKey } from './stats.js';

export const GROUP_ID = '60faaf46-ba4b-460c-a82a-adb852371a94';
const PACK_WEI = 5_000_000_000_000_000n;

export type StatsDeps = {
  fetch: typeof fetch; now(): number; token: string | undefined;
  events: EventStore; people: PeopleStore; pot: PotDeps;
  store: { getText(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
};

/** The arcade's own games: the key our pages tag them with. Every other app of the group is listed from the group. */
const OURS: GameInfo[] = (Object.entries(GAMES) as [string, { title: string; url: string; appId: string }][])
  .map(([tag, g]) => ({ id: g.appId, title: g.title, origin: g.url.replace(/\/$/, ''), tag }));
/** Our own buried game, still in the group: named, and hidden while it is offline with no play. */
const BURIED: Record<string, string> = { '62a44855-272e-4b15-bc3b-f5fc803129ad': 'TAP THE NAME' };
const titlesSeen = new Map<string, string>();                   // app id → its name in the usage report

type Client = ReturnType<typeof createProfileClient>;
/** One client per refresh: it trades the token for a session once, then reuses it. */
const clientOf = (deps: StatsDeps): Client | null => (deps.token ? createProfileClient({ baseUrl: 'https://studio.superrare.com', token: deps.token, fetchImpl: deps.fetch }) : null);

async function usageOf(client: Client, from: number, to: number): Promise<Usage> {
  const r = await client.creditGroups.usage({ groupId: GROUP_ID, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const n = (s: string): number => Number(s) || 0;
  const games: Usage['games'] = {};
  for (const g of r.games) {
    games[g.appId] = { started: n(g.capturedPlays), completed: n(g.completedPlays), credits: n(g.creditsConsumed) };
    if (g.title) titlesSeen.set(g.appId, g.title);
  }
  return { games, total: { started: n(r.totals.capturedPlays), completed: n(r.totals.completedPlays), credits: n(r.totals.creditsConsumed) } };
}

/** The treasury's successful incoming transfers since `since`, one pack per 0.005 ETH: Blockscout's v2 list (with ENS
 *  names; its ?filter=to answers 500 at times, so the outgoing ones are dropped here), else its Etherscan-style list. */
export async function packsSince(fetchImpl: typeof fetch, since: number): Promise<Pack[]> {
  const add = (packs: Pack[], t: number, from: string, name: string | null, wei: bigint): void => {
    if (t >= since && wei >= PACK_WEI) packs.push({ t, wallet: from.toLowerCase(), name, eth: Number(wei) / 1e18, packs: Number(wei / PACK_WEI) });
  };
  try {
    const packs: Pack[] = [];
    let params = '';
    for (let page = 0; page < 10; page++) {
      const r = await fetchImpl(`https://eth.blockscout.com/api/v2/addresses/${TREASURY}/transactions${params}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`blockscout HTTP ${r.status}`);
      const body = await r.json() as { items?: { timestamp?: string; value?: string; result?: string; from?: { hash?: string; ens_domain_name?: string | null }; to?: { hash?: string } | null }[]; next_page_params?: Record<string, string | number> | null };
      let older = false;
      for (const tx of body.items ?? []) {
        const t = Date.parse(tx.timestamp ?? '');
        if (!(t >= since)) { older = true; continue; }
        if (tx.result !== 'success' || tx.to?.hash?.toLowerCase() !== TREASURY || !tx.from?.hash) continue;
        add(packs, t, tx.from.hash, tx.from.ens_domain_name ?? null, BigInt(tx.value ?? '0'));
      }
      if (older || !body.next_page_params) break;
      params = `?${new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)]))}`;
    }
    return packs.sort((a, b) => a.t - b.t);
  } catch {
    const r = await fetchImpl(`https://eth.blockscout.com/api?module=account&action=txlist&address=${TREASURY}&sort=asc`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`blockscout HTTP ${r.status}`);
    const body = await r.json() as { result?: { timeStamp: string; from: string; to: string; value: string; isError: string }[] };
    if (!Array.isArray(body.result)) throw new Error('blockscout: no list');
    const packs: Pack[] = [];
    for (const tx of body.result) if (tx.isError === '0' && tx.to.toLowerCase() === TREASURY) add(packs, Number(tx.timeStamp) * 1000, tx.from, null, BigInt(tx.value));
    return packs;
  }
}

/** Every app of the credit group, by name: ours first, then the artists' in the group's order. A name comes from the
 *  usage report, else from the app's page title ("Dirty Signals Radio · Bully Meow · The Wall Arcade" → its first
 *  part), kept in the stats store once found. Without a token: our two games. */
async function gamesOf(deps: StatsDeps, client: Client | null): Promise<GameInfo[]> {
  if (!client) return OURS;
  const { group } = await client.creditGroups.get({ groupId: GROUP_ID });
  const known = JSON.parse((await deps.store.getText('games.json')) ?? '{}') as Record<string, string>;
  const apps = [...group.apps.map((a) => ({ id: a.productId, origin: a.origin })),
    ...[...titlesSeen.keys()].filter((id) => !group.apps.some((a) => a.productId === id)).map((id) => ({ id, origin: '' }))];
  const games = await Promise.all(apps.map(async ({ id, origin }): Promise<GameInfo> => {
    const ours = OURS.find((g) => g.id === id);
    if (ours) return ours;
    // its page, each time: whether it is online (Studio answers "App not found" for an app taken down), and its name
    let title = titlesSeen.get(id) ?? known[id] ?? BURIED[id], online: boolean | undefined;
    if (origin) {
      try {
        const response = await deps.fetch(`${origin}/`, { signal: AbortSignal.timeout(4000) });
        const t = /<title>([^<]*)<\/title>/i.exec(await response.text())?.[1]?.split(' · ')[0]?.trim();
        online = response.ok && Boolean(t) && !/not found/i.test(t as string);
        if (online && !title) title = (t as string).slice(0, 60);
      } catch { /* unknown: kept */ }
    }
    if (title && !BURIED[id]) known[id] = title;
    return { id, title: title ?? `App ${id.slice(0, 8)}`, origin, ...(online === false ? { online } : {}) };
  }));
  await deps.store.set('games.json', JSON.stringify(known));
  return games.sort((a, b) => Number(!OURS.some((g) => g.id === a.id)) - Number(!OURS.some((g) => g.id === b.id)));
}

async function leaderboard(fetchImpl: typeof fetch, game: GameInfo, from: number, to: number): Promise<LeaderRow[]> {
  const q = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const r = await fetchImpl(`${game.origin}/api/v1/games/${game.id}/scoring/leaderboard?${q}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`leaderboard HTTP ${r.status}`);
  const entries = ((await r.json()) as { entries?: { score?: string | number; achievedAt?: string; player?: { ensName?: string | null; displayName?: string } }[] }).entries ?? [];
  const short = (n: string): string => (/^0x[0-9a-fA-F]{40}$/.test(n) ? `${n.slice(0, 6)}…${n.slice(-4)}`.toLowerCase() : n);
  return entries.map((e) => ({ name: short(e.player?.ensName || e.player?.displayName || '?'), score: Number(e.score) || 0, at: Date.parse(e.achievedAt ?? '') || null }));
}

const settle = async <T>(sources: Record<string, string>, name: string, work: () => Promise<T>): Promise<T | null> => {
  try { const v = await work(); sources[name] ??= 'ok'; return v; } catch (error) { sources[name] = `error: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`; return null; }
};

/** Reads every source, sums, stores stats.json, and answers it. */
export async function refreshStats(deps: StatsDeps): Promise<Stats> {
  const now = deps.now(), wins = windows(now), sources: Record<string, string> = {};
  const fromAll = Math.min(LAUNCH, ...wins.map((w) => w.from));

  // the official report: three windows, and every Lisbon day since the launch (a past day is kept once read)
  const usage: StatsInputs['usage'] = { days: {} };
  const client = clientOf(deps);
  if (!client) sources.usage = 'no RARE_PROFILE_TOKEN';
  else {
    await settle(sources, 'usage', async () => {
      for (const w of wins) usage[w.key as WindowKey] = await usageOf(client, w.from, Math.min(w.to, now + 1));
      const cache = JSON.parse((await deps.store.getText('usage-days.json')) ?? '{}') as Record<string, Usage>;
      const today = lisbonDay(now);
      for (let day = lisbonDay(LAUNCH); lisbonDayStart(day) <= now; day = lisbonDay(lisbonDayStart(day) + 30 * 3_600_000)) {
        const next = lisbonDayStart(lisbonDay(lisbonDayStart(day) + 30 * 3_600_000));
        const from = Math.max(LAUNCH, lisbonDayStart(day));
        if (day !== today && cache[day] && now - next > 3_600_000) { (usage.days as Record<string, Usage>)[day] = cache[day] as Usage; continue; }
        const u = await usageOf(client, from, Math.min(next, now + 1));
        (usage.days as Record<string, Usage>)[day] = u;
        if (day !== today) cache[day] = u;
      }
      await deps.store.set('usage-days.json', JSON.stringify(cache));
    });
  }

  const [events, packs, pot, people] = await Promise.all([
    settle(sources, 'events', () => eventsBetween(deps.events, fromAll, now + 1)),
    // the packs: the last list read is kept, and served again (said in `sources`) when Blockscout fails
    settle(sources, 'packs', async () => {
      try {
        const list = await packsSince(deps.fetch, Date.parse('2026-09-01T00:00:00Z'));
        await deps.store.set('packs.json', JSON.stringify({ at: now, list }));
        return list;
      } catch (error) {
        const last = JSON.parse((await deps.store.getText('packs.json')) ?? 'null') as { at: number; list: Pack[] } | null;
        if (!last) throw error;
        sources.packs = `${error instanceof Error ? error.message : 'error'}: last list read ${new Date(last.at).toISOString()} shown`;
        return last.list;
      }
    }),
    settle(sources, 'pot', async () => (await currentPot(deps.pot)).pot),
    settle(sources, 'people', async () => {
      const list = JSON.parse((await deps.people.getText('people.json')) ?? '[]') as Person[];
      const stats = JSON.parse((await deps.people.getText('stats.json')) ?? 'null') as { names: number; withSprite: number; lastSpriteAt: string | null } | null;
      const unmatched = JSON.parse((await deps.people.getText('unmatched.json')) ?? '[]') as unknown[];
      const mirrored = JSON.parse((await deps.people.getText('mirrored.json')) ?? '{}') as Record<string, string>;
      return { list, people: { names: stats?.names ?? list.length, withSprite: stats?.withSprite ?? 0, unmatched: unmatched.length, lastSpriteAt: stats?.lastSpriteAt ?? null, mirrored } };
    }),
  ]);
  // an app taken down (TAP THE NAME) is left out while it has no play since the launch
  const games = ((await settle(sources, 'games', () => gamesOf(deps, client))) ?? OURS)
    .filter((g) => g.online !== false || (usage.launch?.games[g.id]?.started ?? 0) > 0);
  // one leaderboard per game and window; a game without scoring (or not online) simply has none
  const leaderboards: StatsInputs['leaderboards'] = {};
  const missing: string[] = [];
  await Promise.all(games.filter((g) => g.origin).flatMap((g) => wins.map(async (w) => {
    try { (leaderboards[g.id] ??= {})[w.key] = await leaderboard(deps.fetch, g, w.from, Math.min(w.to, now + 1)); } catch { if (!missing.includes(g.title)) missing.push(g.title); }
  })));
  sources.leaderboards = missing.length ? `none for ${missing.join(', ')}` : 'ok';

  const stats = buildStats({
    now, games, events: events ?? [], usage, packs: (packs ?? []).filter((p) => p.t >= LAUNCH), leaderboards, pot,
    holders: new Set((people?.list ?? []).map((p) => p.wallet).filter((w): w is string => typeof w === 'string').map((w) => w.toLowerCase())),
    people: people?.people ?? null, sources,
  });
  await deps.store.set('stats.json', JSON.stringify(stats));
  return stats;
}
