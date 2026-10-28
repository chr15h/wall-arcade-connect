// THE WALL ARCADE's own tags (the funnel, practice, plays per wallet), independent of Netlify (netlify/functions/events.mts
// plugs in Netlify Blobs, store "events"):
//   POST /api/events   { event, game?, wallet?, practice?, score?, cardId?, extra? } -> 204, stamped here
// Fire and forget: the pages send it with navigator.sendBeacon (text/plain, so no preflight) and never wait for it.
// No cookie, no device id: a wallet (public, already in people.json) when there is one, else the event is just counted.
// Each event is its own blob (raw/<UTC day>/<time>-<random>), so two at once never overwrite each other; reading a day
// folds the new ones into <UTC day>.ndjson (one line per event, its blob key in `k`, so folding twice changes nothing).
export const EVENTS = [
  // the hub
  'hub_view', 'click_play', 'click_make_my_game', 'builders_view', 'copy_kit', 'assets_view', 'kit_download', 'people_sign_in', 'add_yourself',
  // the games
  'game_open', 'practice_start', 'practice_end', 'paid_start', 'paid_end', 'paid_abandon', 'buy_click', 'buy_done', 'post_on_x', 'play_again',
  // the card service itself (never accepted from a page)
  'card_create', 'card_view',
] as const;
export type EventName = typeof EVENTS[number];
import { gameKey } from './group.js';
const FROM_PAGES = new Set<string>(EVENTS.filter((e) => e !== 'card_create' && e !== 'card_view'));

/** One stored event: t (ms), e, g game, w wallet (lowercase), p practice, s score, c card id, x extra, k its blob key. */
export type ArcadeEvent = { t: number; e: EventName; g?: string; w?: string; p?: boolean; s?: number; c?: string; x?: Record<string, string | number | boolean>; k?: string };

export class EventError extends Error {}
const fail = (why: string): never => { throw new EventError(why); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A page's event, checked field by field (unknown fields refused), stamped with `now`. `game`: our key or an app id of
 *  the credit group (cards/src/group.ts: the hub's PLAY sends the app id); ours alone when no group is given. */
export function parseEvent(raw: unknown, now: number, games: (raw: unknown) => string | null = gameKey): ArcadeEvent {
  if (!isObject(raw)) return fail('an object');
  for (const k of Object.keys(raw)) if (!['event', 'game', 'wallet', 'practice', 'score', 'cardId', 'extra'].includes(k)) fail(`unexpected field ${k}`);
  const { event, game, wallet, practice, score, cardId, extra } = raw;
  if (typeof event !== 'string' || !FROM_PAGES.has(event)) return fail('unknown event');
  const out: ArcadeEvent = { t: now, e: event as EventName };
  if (game !== undefined) { const g = games(game); if (g === null) fail('unknown game'); out.g = g as string; }
  if (wallet !== undefined && wallet !== null) { if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) fail('wallet'); out.w = (wallet as string).toLowerCase(); }
  if (practice !== undefined) { if (typeof practice !== 'boolean') fail('practice'); out.p = practice as boolean; }
  if (score !== undefined) { if (!Number.isSafeInteger(score) || (score as number) < 0 || (score as number) > 1e9) fail('score'); out.s = score as number; }
  if (cardId !== undefined) { if (typeof cardId !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(cardId)) fail('cardId'); out.c = cardId as string; }
  if (extra !== undefined) {
    if (!isObject(extra) || Object.keys(extra).length > 6) return fail('extra');
    const x: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(extra)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(k)) fail('extra key');
      if (typeof v === 'string' ? v.length > 80 : typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean') fail('extra value');
      x[k] = v as string | number | boolean;
    }
    out.x = x;
  }
  return out;
}

export interface EventStore {
  getText(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Stores one event in its own blob. */
export async function recordEvent(store: EventStore, event: ArcadeEvent): Promise<void> {
  const key = `raw/${utcDay(event.t)}/${event.t.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await store.set(key, JSON.stringify(event));
}

const lines = (text: string | null): ArcadeEvent[] =>
  (text ?? '').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as ArcadeEvent]; } catch { return []; } });

/** The events of one UTC day: the day's file, plus the raw blobs not folded in yet (which are then folded in). */
export async function eventsOfDay(store: EventStore, day: string): Promise<ArcadeEvent[]> {
  const file = `${day}.ndjson`;
  const known = lines(await store.getText(file));
  const have = new Set(known.map((e) => e.k));
  const fresh = (await store.list(`raw/${day}/`)).filter((k) => !have.has(k));
  if (!fresh.length) return known;
  const added: ArcadeEvent[] = [];
  for (let i = 0; i < fresh.length; i += 25) {
    const batch = await Promise.all(fresh.slice(i, i + 25).map(async (k) => {
      const text = await store.getText(k);
      try { return text ? { ...(JSON.parse(text) as ArcadeEvent), k } : null; } catch { return null; }
    }));
    for (const e of batch) if (e) added.push(e);
  }
  const all = [...known, ...added].sort((a, b) => a.t - b.t);
  await store.set(file, all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return all;
}

/** Every event in [from, to). */
export async function eventsBetween(store: EventStore, from: number, to: number): Promise<ArcadeEvent[]> {
  const days: string[] = [];
  for (let d = Date.parse(utcDay(from)); d < to; d += 86_400_000) days.push(utcDay(d));
  const all = (await Promise.all(days.map((d) => eventsOfDay(store, d)))).flat();
  return all.filter((e) => e.t >= from && e.t < to && e.x?.test === undefined);   // `extra.test`: a check, not a person
}
