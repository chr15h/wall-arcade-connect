// Who may call POST /api/cards and POST /api/events (CORS; /api/events refuses the rest): every app of the credit group,
// read where /stats reads it (stats-sources.ts stores the group's origins as origins.json in the store "stats" on each
// refresh, every 15 minutes), plus our three pages always (the hub is not an app of the group; and while the list was
// never read, or cannot be, they are the only ones). Local development too. Nothing here is hard-coded per artist.
export const OUR_ORIGINS = ['https://yfq52eu3.srstudio.dev', 'https://7x2phv5j.srstudio.dev', 'https://6972mvu4.srstudio.dev'];
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const AN_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/;      // a bare https origin: no path, no port, nothing else

export type Origins = () => Promise<Set<string>>;
export const ours = (): Set<string> => new Set(OUR_ORIGINS);

/** The group's origins as stored by the stats refresh: { at, origins } (an unreadable or odd file: none). */
export const parseOrigins = (text: string | null): string[] => {
  try {
    const list = (JSON.parse(text ?? 'null') as { origins?: unknown } | null)?.origins;
    return Array.isArray(list) ? list.filter((o): o is string => typeof o === 'string' && AN_ORIGIN.test(o)) : [];
  } catch { return []; }
};

/** Our three plus the group's, read from the stats store at most once a minute per instance. */
export function groupOrigins(store: { getText(key: string): Promise<string | null> }, now: () => number = Date.now): Origins {
  let cached: { at: number; set: Set<string> } | null = null;
  return async () => {
    if (cached && now() - cached.at < 60_000) return cached.set;
    let group: string[];
    try { group = parseOrigins(await store.getText('origins.json')); } catch { return cached?.set ?? ours(); }
    cached = { at: now(), set: new Set([...OUR_ORIGINS, ...group]) };
    return cached.set;
  };
}

export const isAllowed = (origin: string | null, allowed: Set<string> = ours()): boolean => origin !== null && (allowed.has(origin) || LOCAL.test(origin));
