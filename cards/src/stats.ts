// THE WALL ARCADE's numbers (GET /stats and /stats.json, cards/src/stats-page.ts), pure: everything is read beforehand
// (cards/src/stats-sources.ts) and summed here, for three windows: today (Lisbon day), this week (Friday 15:00 Lisbon to
// Friday 15:00) and since the launch (Tuesday 27 October 2026, 14:00 Lisbon).
// Plays started and completed are SuperRare's own report (credit-group usage) when it can be read; free versus paid is
// ours: a holder's first 3 paid starts of a week are free (the 3 credits granted each week), the rest are paid, and a
// non-holder's are all paid (no grant). It needs plays per wallet, so it comes from our tags (cards/src/events.ts).
import type { ArcadeEvent } from './events.js';
import { lisbonWeek } from './week.js';

export const LAUNCH = Date.parse('2026-10-27T14:00:00Z');          // 14:00 Lisbon (winter time since 25 October)
export const FREE_PER_WEEK = 3;
export const GRANTED_WALLETS = 190;                                // the grant of 3 credits a week: 190 wallets × 3
export const PACK_PLAYS = 50;
export const GAME_KEYS = ['full-row', 'unbreakable'] as const;
export type Game = typeof GAME_KEYS[number];
export const TITLES: Record<Game, string> = { 'full-row': 'FULL ROW', unbreakable: 'UNBREAKABLE' };

export type Usage = { games: Partial<Record<Game, { started: number; completed: number; credits: number }>>; total: { started: number; completed: number; credits: number } };
export type Pack = { t: number; wallet: string; name: string | null; eth: number; packs: number };
export type LeaderRow = { name: string; score: number; at: number | null };
export type WindowKey = 'today' | 'week' | 'launch';
export type StatsInputs = {
  now: number;
  events: ArcadeEvent[];                                           // since the earlier of the launch and this week's start
  usage: Partial<Record<WindowKey, Usage | null>> & { days?: Record<string, Usage | null> };
  holders: Set<string>;
  packs: Pack[];
  leaderboards: Partial<Record<Game, Partial<Record<WindowKey, LeaderRow[]>>>>;
  pot: string | null;
  people: { names: number; withSprite: number; unmatched: number; lastSpriteAt: string | null; mirrored: Record<string, string> } | null;
  sources: Record<string, string>;
};

/* ------------------------------- Lisbon time ------------------------------- */
const ZONE = 'Europe/Lisbon';
function lisbon(t: number): { day: string; hour: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const get = (type: string): string => p.find((x) => x.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
export const lisbonDay = (t: number): string => lisbon(t).day;
/** The instant a Lisbon day starts (its 00:00). */
export function lisbonDayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  let guess = Date.UTC(y, m - 1, d);
  for (let pass = 0; pass < 2; pass++) {
    const p = lisbon(guess), [py, pm, pd] = p.day.split('-').map(Number) as [number, number, number];
    guess -= Date.UTC(py, pm - 1, pd, p.hour) - Date.UTC(y, m - 1, d);
  }
  return guess;
}
const nextDay = (day: string): string => lisbonDay(lisbonDayStart(day) + 30 * 3_600_000);

export type Window = { key: WindowKey; label: string; from: number; to: number };
export function windows(now: number): Window[] {
  const today = lisbonDay(now), week = lisbonWeek(now);
  return [
    { key: 'today', label: 'Today', from: lisbonDayStart(today), to: lisbonDayStart(nextDay(today)) },
    { key: 'week', label: 'This week', from: Date.parse(week.from), to: Date.parse(week.to) },
    { key: 'launch', label: 'Since launch', from: LAUNCH, to: now + 1 },
  ];
}

/* ----------------------------- free versus paid ---------------------------- */
/** The paid starts, each once (a page reloaded during a run tags it again: same run id), oldest first. */
export function paidStarts(events: ArcadeEvent[]): ArcadeEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => e.e === 'paid_start').sort((a, b) => a.t - b.t).filter((e) => {
    const run = typeof e.x?.run === 'string' ? e.x.run : null;
    if (!run) return true;
    if (seen.has(run)) return false;
    seen.add(run); return true;
  });
}
/** Each paid start, free or paid: a holder's first FREE_PER_WEEK of a week (Friday 15:00 Lisbon) are free. A start with
 *  no wallet is left unclassified. */
export function classify(starts: ArcadeEvent[], holders: Set<string>): { event: ArcadeEvent; kind: 'free' | 'paid' | 'unknown' }[] {
  const used = new Map<string, number>();
  return [...starts].sort((a, b) => a.t - b.t).map((event) => {
    if (!event.w) return { event, kind: 'unknown' as const };
    if (!holders.has(event.w)) return { event, kind: 'paid' as const };
    const key = `${event.w}|${lisbonWeek(event.t).from}`, n = used.get(key) ?? 0;
    used.set(key, n + 1);
    return { event, kind: n < FREE_PER_WEEK ? 'free' as const : 'paid' as const };
  });
}

/* --------------------------------- summing --------------------------------- */
const inWin = (t: number, w: Window): boolean => t >= w.from && t < w.to;
const count = (events: ArcadeEvent[], name: string, w: Window, f: (e: ArcadeEvent) => boolean = () => true): number =>
  events.filter((e) => e.e === name && inWin(e.t, w) && f(e)).length;
const distinct = <T>(xs: T[]): number => new Set(xs).size;
const pct = (n: number, of: number): number | null => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

export type PlayRow = {
  started: number; completed: number; abandoned: number; credits: number | null; official: boolean;
  free: number; paid: number; unattributed: number; practice: number; practiceDone: number;
  tagged: { started: number; completed: number; abandoned: number }; diff: number | null;
};
function playRow(game: Game | null, w: Window, events: ArcadeEvent[], kinds: ReturnType<typeof classify>, usage: Usage | null | undefined): PlayRow {
  const mine = (e: ArcadeEvent): boolean => game === null || e.g === game;
  const starts = kinds.filter((k) => inWin(k.event.t, w) && mine(k.event));
  const tagged = { started: starts.length, completed: count(events, 'paid_end', w, mine), abandoned: count(events, 'paid_abandon', w, mine) };
  const off = usage ? (game ? usage.games[game] : usage.total) ?? { started: 0, completed: 0, credits: 0 } : null;
  const started = off ? off.started : tagged.started, completed = off ? off.completed : tagged.completed;
  const free = starts.filter((k) => k.kind === 'free').length, paid = starts.filter((k) => k.kind === 'paid').length;
  return {
    started, completed, abandoned: Math.max(0, started - completed), credits: off ? off.credits : null, official: Boolean(off),
    free, paid, unattributed: Math.max(0, started - free - paid),
    practice: count(events, 'practice_start', w, mine), practiceDone: count(events, 'practice_end', w, mine),
    tagged, diff: off ? tagged.started - off.started : null,
  };
}

const ACTIVE = new Set(['paid_start', 'paid_end', 'practice_start', 'practice_end', 'game_open', 'buy_done']);
export function buildStats(input: StatsInputs) {
  const { now, events, holders } = input;
  const wins = windows(now);
  const starts = paidStarts(events);
  const kinds = classify(starts, holders);
  const firstSeen = new Map<string, number>(), daysSeen = new Map<string, Set<string>>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (!e.w || !ACTIVE.has(e.e) || e.t < LAUNCH) continue;
    if (!firstSeen.has(e.w)) firstSeen.set(e.w, e.t);
    (daysSeen.get(e.w) ?? daysSeen.set(e.w, new Set()).get(e.w) as Set<string>).add(lisbonDay(e.t));
  }
  const today = wins[0] as Window;

  const perWindow = Object.fromEntries(wins.map((w) => {
    const usage = input.usage[w.key];
    const games = Object.fromEntries(GAME_KEYS.map((g) => [g, playRow(g, w, events, kinds, usage)])) as Record<Game, PlayRow>;
    const total = playRow(null, w, events, kinds, usage);
    const active = events.filter((e) => e.w && ACTIVE.has(e.e) && inWin(e.t, w));
    const wallets = [...new Set(active.map((e) => e.w as string))];
    const perPlayer = [...wallets].map((x) => starts.filter((s) => s.w === x && inWin(s.t, w)).length).filter((n) => n > 0);
    const payers = new Set(kinds.filter((k) => k.kind === 'paid' && inWin(k.event.t, w)).map((k) => k.event.w as string));
    const packs = input.packs.filter((p) => inWin(p.t, w));
    const buyers = new Set(packs.map((p) => p.wallet));
    const fromX = (e: ArcadeEvent): boolean => e.x?.fromX === true;
    const mirrored = Object.values(input.people?.mirrored ?? {}).map(Date.parse).filter((t) => inWin(t, w)).length;
    const board = Object.fromEntries(GAME_KEYS.map((g) => {
      const rows = input.leaderboards[g]?.[w.key] ?? null;
      return [g, rows ? { players: rows.length, top3: rows.slice(0, 3).map((r) => ({ name: r.name, score: r.score })) } : null];
    }));
    return [w.key, {
      label: w.label, from: new Date(w.from).toISOString(), to: new Date(Math.min(w.to, now)).toISOString(),
      plays: { games, total },
      players: {
        wallets: wallets.length,
        holders: wallets.filter((x) => holders.has(x)).length,
        nonHolders: wallets.filter((x) => !holders.has(x)).length,
        newToday: [...firstSeen.values()].filter((t) => inWin(t, today) && inWin(t, w)).length,
        returning: wallets.filter((x) => (daysSeen.get(x)?.size ?? 0) >= 2).length,
        playsPerPlayer: perPlayer.length ? { avg: Math.round((perPlayer.reduce((a, b) => a + b, 0) / perPlayer.length) * 10) / 10, max: Math.max(...perPlayer) } : null,
        leaderboards: board,
      },
      money: {
        packs: packs.reduce((a, p) => a + p.packs, 0),
        eth: Math.round(packs.reduce((a, p) => a + p.eth, 0) * 1e6) / 1e6,
        buyers: packs.map((p) => ({ name: p.name ?? `${p.wallet.slice(0, 6)}…${p.wallet.slice(-4)}`, at: new Date(p.t).toISOString(), eth: p.eth })),
        conversion: payers.size ? pct([...buyers].filter((b) => payers.has(b)).length, payers.size) : null,
        buyClicks: count(events, 'buy_click', w),
      },
      share: {
        cards: count(events, 'card_create', w),
        postOnX: count(events, 'post_on_x', w),
        cardViews: count(events, 'card_view', w),
        fromX: count(events, 'card_view', w, fromX),
        clicksPerCard: count(events, 'card_create', w) ? Math.round((count(events, 'card_view', w, fromX) / count(events, 'card_create', w)) * 10) / 10 : null,
      },
      artists: {
        buildersViews: count(events, 'builders_view', w), makeMyGame: count(events, 'click_make_my_game', w), copyKit: count(events, 'copy_kit', w),
        assetsViews: count(events, 'assets_view', w), kitDownloads: count(events, 'kit_download', w),
      },
      hub: { views: count(events, 'hub_view', w), clickPlay: count(events, 'click_play', w), peopleSignIn: count(events, 'people_sign_in', w), addYourself: count(events, 'add_yourself', w) },
      sprites: mirrored,
    }];
  }));

  // one line per Lisbon day since the launch
  const days: { day: string; plays: number; official: boolean; players: number; packs: number; cards: number; sprites: number }[] = [];
  for (let day = lisbonDay(LAUNCH); lisbonDayStart(day) <= now; day = nextDay(day)) {
    const w: Window = { key: 'today', label: day, from: Math.max(LAUNCH, lisbonDayStart(day)), to: lisbonDayStart(nextDay(day)) };
    const usage = input.usage.days?.[day];
    days.push({
      day, plays: usage ? usage.total.started : starts.filter((s) => inWin(s.t, w)).length, official: Boolean(usage),
      players: distinct(events.filter((e) => e.w && ACTIVE.has(e.e) && inWin(e.t, w)).map((e) => e.w)),
      packs: input.packs.filter((p) => inWin(p.t, w)).reduce((a, p) => a + p.packs, 0),
      cards: count(events, 'card_create', w),
      sprites: Object.values(input.people?.mirrored ?? {}).map(Date.parse).filter((t) => inWin(t, w)).length,
    });
  }
  // today, hour by hour (Lisbon): paid starts and practice runs, to see what a tweet does
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, paid: 0, practice: 0 }));
  for (const s of starts) if (inWin(s.t, today)) (hours[lisbon(s.t).hour] as { paid: number }).paid++;
  for (const e of events) if (e.e === 'practice_start' && inWin(e.t, today)) (hours[lisbon(e.t).hour] as { practice: number }).practice++;

  const launch = wins[2] as Window, L = perWindow.launch as { plays: { total: PlayRow } };
  const steps: [string, number][] = [
    ['Hub viewed', count(events, 'hub_view', launch)],
    ['Game opened', count(events, 'game_open', launch)],
    ['Practice started', count(events, 'practice_start', launch)],
    ['Paid run started', L.plays.total.started],
    ['Paid run completed', L.plays.total.completed],
    ['POST ON X', count(events, 'post_on_x', launch)],
    ['Card opened from X', count(events, 'card_view', launch, (e) => e.x?.fromX === true)],
  ];
  const funnel = steps.map(([step, n], i) => ({ step, count: n, pct: i ? pct(n, (steps[i - 1] as [string, number])[1]) : null }));

  const consumed = input.usage.launch?.total.credits ?? null;
  const bought = input.packs.filter((p) => p.t >= LAUNCH).reduce((a, p) => a + p.packs, 0) * PACK_PLAYS;
  const T = perWindow.today as { plays: { total: PlayRow }; players: { wallets: number } };
  return {
    generatedAt: new Date(now).toISOString(),
    launch: new Date(LAUNCH).toISOString(),
    now: { pot: input.pot, weekEndsAt: lisbonWeek(now).to, playersToday: T.players.wallets, playsToday: T.plays.total.started },
    windows: perWindow,
    days, hours,
    credits: { granted: GRANTED_WALLETS * FREE_PER_WEEK, bought, consumed, inCirculation: consumed === null ? null : GRANTED_WALLETS * FREE_PER_WEEK + bought - consumed },
    people: input.people ? { names: input.people.names, withSprite: input.people.withSprite, unmatched: input.people.unmatched, lastSpriteAt: input.people.lastSpriteAt } : null,
    funnel,
    sources: input.sources,
  };
}
export type Stats = ReturnType<typeof buildStats>;
