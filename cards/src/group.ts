// The arcade's games and pages, as the card service lets them in: every app of the credit group, read where /stats reads
// it (stats-sources.ts stores the group as group.json in the store "stats" on each refresh, every 15 minutes: each app's
// id, origin and name), plus our own always (the hub is not an app of the group; and while the group was never read, or
// cannot be, ours are the only ones). Nothing here is hard-coded per artist.
//   origins   who may POST /api/cards and /api/events (CORS; /api/events refuses the rest); local development too
//   games     what a tag's `game` and a board card's `game` may name: our keys, or the app id of any app of the group
import { GAMES } from './validate.js';

export type GroupApp = { id: string; origin: string; title: string };
export type Group = { origins: Set<string>; apps: GroupApp[] };
export type GroupSource = () => Promise<Group>;

export const OUR_ORIGINS = ['https://yfq52eu3.srstudio.dev', 'https://7x2phv5j.srstudio.dev', 'https://6972mvu4.srstudio.dev'];
const OUR_APPS: GroupApp[] = Object.values(GAMES).map((g) => ({ id: g.appId, origin: g.url.replace(/\/$/, ''), title: g.title }));
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const AN_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;      // a bare https origin: no path, no port, nothing else
const AN_APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const ours = (): Group => ({ origins: new Set(OUR_ORIGINS), apps: OUR_APPS });

/** The group as stored by the stats refresh, { at, apps: [{ id, origin, title }] }; an unreadable file or entry: none. */
export function parseGroup(text: string | null): GroupApp[] {
  try {
    const list = (JSON.parse(text ?? 'null') as { apps?: unknown } | null)?.apps;
    if (!Array.isArray(list)) return [];
    return list.flatMap((a: Partial<GroupApp>) => (a && typeof a.id === 'string' && AN_APP_ID.test(a.id) && typeof a.origin === 'string' && AN_ORIGIN.test(a.origin)
      ? [{ id: a.id, origin: a.origin, title: typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, 60) : `App ${a.id.slice(0, 8)}` }] : []));
  } catch { return []; }
}

/** Ours plus the group's, read from the stats store at most once a minute per instance; the last one read if it fails. */
export function groupOf(store: { getText(key: string): Promise<string | null> }, now: () => number = Date.now): GroupSource {
  let cached: { at: number; group: Group } | null = null;
  return async () => {
    if (cached && now() - cached.at < 60_000) return cached.group;
    let apps: GroupApp[];
    try { apps = parseGroup(await store.getText('group.json')); } catch { return cached?.group ?? ours(); }
    const all = [...OUR_APPS, ...apps.filter((a) => !OUR_APPS.some((o) => o.id === a.id))];
    cached = { at: now(), group: { origins: new Set([...OUR_ORIGINS, ...all.map((a) => a.origin)]), apps: all } };
    return cached.group;
  };
}

export const isAllowed = (origin: string | null, group: Group = ours()): boolean => origin !== null && (group.origins.has(origin) || LOCAL.test(origin));

/** A game as a page names it: our key ('full-row', 'unbreakable', which our own games send), or an app id of the group
 *  (ours turned into their key, so /stats counts them with their own tags). Null if it is no game of the arcade. */
export function gameKey(raw: unknown, group: Group = ours()): string | null {
  if (typeof raw !== 'string') return null;
  if (raw in GAMES) return raw;
  const app = group.apps.find((a) => a.id === raw);
  if (!app) return null;
  return (Object.entries(GAMES) as [string, { appId: string }][]).find(([, g]) => g.appId === app.id)?.[0] ?? app.id;
}
/** The artist's app a page belongs to, by its origin (not ours). */
export const artistOf = (origin: string | null, group: Group): GroupApp | null =>
  group.apps.find((a) => a.origin === origin && !Object.values(GAMES).some((g) => g.appId === a.id)) ?? null;
/** An artist's game of the group by its app id (not ours: those have their key). */
export const artistApp = (key: string, group: Group): GroupApp | null => (key in GAMES ? null : group.apps.find((a) => a.id === key) ?? null);
