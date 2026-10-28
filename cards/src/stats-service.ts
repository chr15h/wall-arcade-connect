// The stats' routes, independent of Netlify (netlify/functions/events.mts and stats.mts plug in Netlify Blobs):
//   POST /api/events   a tag from the hub or a game (cards/src/events.ts) -> 204; only from the arcade's pages (cards/src/origins.ts)
//   GET  /stats        the page (cards/src/stats-page.ts)       GET /stats.json   the same numbers
// Both read stats.json, written every 15 minutes (netlify/functions/stats-refresh.mts); ?refresh=1 sums again now,
// at most once a minute.
import { EventError, parseEvent, recordEvent, type EventStore } from './events.js';
import { isAllowed, ours, type Origins } from './origins.js';
import { statsPage } from './stats-page.js';
import { refreshStats, type StatsDeps } from './stats-sources.js';
import type { Stats } from './stats.js';

export async function handleEvents(request: Request, deps: { events: EventStore; now(): number; origins?: Origins }): Promise<Response> {
  const origin = request.headers.get('origin'), allowed = await (deps.origins?.() ?? Promise.resolve(ours()));
  const headers: Record<string, string> = isAllowed(origin, allowed) ? { 'Access-Control-Allow-Origin': origin as string, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response('POST an event', { status: 405, headers });
  if (!isAllowed(origin, allowed)) return new Response('Not from the arcade', { status: 403, headers });
  const raw = await request.text();
  if (raw.length > 2048) return new Response('Too large', { status: 413, headers });
  try {
    await recordEvent(deps.events, parseEvent(JSON.parse(raw) as unknown, deps.now()));
  } catch (error) {
    return new Response(error instanceof EventError ? error.message : 'invalid JSON', { status: 400, headers });
  }
  return new Response(null, { status: 204, headers });
}

export async function handleStats(request: Request, deps: StatsDeps): Promise<Response> {
  const url = new URL(request.url);
  let stats = JSON.parse((await deps.store.getText('stats.json')) ?? 'null') as Stats | null;
  const age = stats ? deps.now() - Date.parse(stats.generatedAt) : Infinity;
  if (!stats || (url.searchParams.get('refresh') === '1' && age > 60_000)) stats = await refreshStats(deps);
  if (url.pathname === '/stats.json') {
    return new Response(JSON.stringify(stats, null, 1), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex' } });
  }
  return new Response(statsPage(stats), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
