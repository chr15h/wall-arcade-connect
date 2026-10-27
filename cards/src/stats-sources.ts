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
import { buildStats, GAME_KEYS, LAUNCH, lisbonDay, lisbonDayStart, windows, type Game, type LeaderRow, type Pack, type Stats, type StatsInputs, type Usage, type WindowKey } from './stats.js';

export const GROUP_ID = '60faaf46-ba4b-460c-a82a-adb852371a94';
const PACK_WEI = 5_000_000_000_000_000n;

export type StatsDeps = {
  fetch: typeof fetch; now(): number; token: string | undefined;
  events: EventStore; people: PeopleStore; pot: PotDeps;
  store: { getText(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
};

async function usageOf(token: string, fetchImpl: typeof fetch, from: number, to: number): Promise<Usage> {
  const client = createProfileClient({ baseUrl: 'https://studio.superrare.com', token, fetchImpl });
  const r = await client.creditGroups.usage({ groupId: GROUP_ID, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const n = (s: string): number => Number(s) || 0;
  const games: Usage['games'] = {};
  for (const g of r.games) {
    const key = GAME_KEYS.find((k) => GAMES[k].appId === g.appId);
    if (key) games[key] = { started: n(g.capturedPlays), completed: n(g.completedPlays), credits: n(g.creditsConsumed) };
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

async function leaderboard(fetchImpl: typeof fetch, game: Game, from: number, to: number): Promise<LeaderRow[]> {
  const g = GAMES[game];
  const q = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const r = await fetchImpl(`${g.url.replace(/\/$/, '')}/api/v1/games/${g.appId}/scoring/leaderboard?${q}`, { signal: AbortSignal.timeout(5000) });
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
  if (!deps.token) sources.usage = 'no RARE_PROFILE_TOKEN';
  else {
    const token = deps.token;
    await settle(sources, 'usage', async () => {
      for (const w of wins) usage[w.key as WindowKey] = await usageOf(token, deps.fetch, w.from, Math.min(w.to, now + 1));
      const cache = JSON.parse((await deps.store.getText('usage-days.json')) ?? '{}') as Record<string, Usage>;
      const today = lisbonDay(now);
      for (let day = lisbonDay(LAUNCH); lisbonDayStart(day) <= now; day = lisbonDay(lisbonDayStart(day) + 30 * 3_600_000)) {
        const next = lisbonDayStart(lisbonDay(lisbonDayStart(day) + 30 * 3_600_000));
        const from = Math.max(LAUNCH, lisbonDayStart(day));
        if (day !== today && cache[day] && now - next > 3_600_000) { (usage.days as Record<string, Usage>)[day] = cache[day] as Usage; continue; }
        const u = await usageOf(token, deps.fetch, from, Math.min(next, now + 1));
        (usage.days as Record<string, Usage>)[day] = u;
        if (day !== today) cache[day] = u;
      }
      await deps.store.set('usage-days.json', JSON.stringify(cache));
    });
  }

  const [events, packs, pot, people] = await Promise.all([
    settle(sources, 'events', () => eventsBetween(deps.events, fromAll, now + 1)),
    settle(sources, 'packs', () => packsSince(deps.fetch, Date.parse('2026-09-01T00:00:00Z'))),
    settle(sources, 'pot', async () => (await currentPot(deps.pot)).pot),
    settle(sources, 'people', async () => {
      const list = JSON.parse((await deps.people.getText('people.json')) ?? '[]') as Person[];
      const stats = JSON.parse((await deps.people.getText('stats.json')) ?? 'null') as { names: number; withSprite: number; lastSpriteAt: string | null } | null;
      const unmatched = JSON.parse((await deps.people.getText('unmatched.json')) ?? '[]') as unknown[];
      const mirrored = JSON.parse((await deps.people.getText('mirrored.json')) ?? '{}') as Record<string, string>;
      return { list, people: { names: stats?.names ?? list.length, withSprite: stats?.withSprite ?? 0, unmatched: unmatched.length, lastSpriteAt: stats?.lastSpriteAt ?? null, mirrored } };
    }),
  ]);
  const leaderboards: StatsInputs['leaderboards'] = {};
  await settle(sources, 'leaderboards', async () => {
    await Promise.all(GAME_KEYS.flatMap((g) => wins.map(async (w) => {
      (leaderboards[g] ??= {})[w.key] = await leaderboard(deps.fetch, g, w.from, Math.min(w.to, now + 1));
    })));
  });

  const stats = buildStats({
    now, events: events ?? [], usage, packs: (packs ?? []).filter((p) => p.t >= LAUNCH), leaderboards, pot,
    holders: new Set((people?.list ?? []).map((p) => p.wallet).filter((w): w is string => typeof w === 'string').map((w) => w.toLowerCase())),
    people: people?.people ?? null, sources,
  });
  await deps.store.set('stats.json', JSON.stringify(stats));
  return stats;
}
