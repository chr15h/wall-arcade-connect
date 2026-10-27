// PEOPLE's HTTP side (src/people.ts holds the rules), independent of Netlify:
//   GET /people.json            one object per named panel of the wall, its sprite or null (CORS *, cached 60 s)
//   GET /people/stats.json      { names, withSprite, lastSpriteAt }, for the hub's counter
//   GET /people/unmatched.json  sprites whose "Player name" matches no panel (for John: add an alias)
//   GET /people/sprites/<id>.png  a mirrored sprite sheet (CORS *, immutable): games draw it on a canvas
//   GET /people/sprites.zip     every sprite sheet and people.json, rebuilt when they change
//   GET /people/refresh         reads the sources now (also every 5 minutes, netlify/functions/people-refresh.mts)
//   GET /people/capture?wallet=0x…  for a wallet that holds a name of the wall: { url, names } (the Sprite Party capture
//                               link and its names, the first one without a character first); 404 for anyone else. The
//                               pages never carry the link: they ask here once a holder is signed in.
import { zipSync, strToU8 } from 'fflate';
import { CAPTURE_URL, MANIFEST_URL, POSITIONS_URL, SPRITE_PARTY, buildPeople, isSpritePng, keyOf, validSprites, type Mirrored, type Person, type Position } from './people.js';

export interface PeopleStore {
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  set(key: string, value: string | Uint8Array): Promise<void>;
}
export type PeopleDeps = { store: PeopleStore; fetch: typeof fetch; aliases: Record<string, string>; now(): number };

const cors = { 'Access-Control-Allow-Origin': '*' };
const json = (body: string, cache = 'public, max-age=60', status = 200): Response =>
  new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache } });

async function getJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${text.slice(0, 120)}`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`${url}: not JSON (${text.slice(0, 120)})`); }
}

/** Reads the wall and the manifest, mirrors the new sprite sheets, writes people.json, stats, unmatched and the zip. */
export async function refresh(deps: PeopleDeps): Promise<{ sprites: number; mirroredNow: number; withSprite: number; unmatched: number }> {
  const [raw, manifest] = await Promise.all([getJson<Position[] | { positions: Position[] }>(deps.fetch, POSITIONS_URL), getJson<unknown>(deps.fetch, MANIFEST_URL)]);
  const positions = Array.isArray(raw) ? raw : raw?.positions;      // the wall answers a list, or { positions } (both seen)
  if (!Array.isArray(positions) || positions.length < 500) throw new Error(`positions: not the wall (${JSON.stringify(positions).slice(0, 160)})`);
  const sprites = validSprites(manifest);
  const mirrored = JSON.parse((await deps.store.getText('mirrored.json')) ?? '{}') as Mirrored;
  let mirroredNow = 0;
  for (const s of sprites) {
    if (mirrored[s.id]) continue;
    try {
      const response = await deps.fetch(`${SPRITE_PARTY}${s.src}`, { signal: AbortSignal.timeout(10_000) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || !isSpritePng(bytes)) continue;               // not a 192 × 192 PNG: skipped, tried again later
      await deps.store.set(`sprites/${s.id}.png`, bytes);
      mirrored[s.id] = new Date(deps.now()).toISOString(); mirroredNow++;
    } catch { /* Sprite Party slow or down: the next refresh tries again */ }
  }
  const { people, unmatched, stats } = buildPeople(positions, sprites, deps.aliases, mirrored);
  const peopleJson = JSON.stringify(people);
  const changed = mirroredNow > 0 || (await deps.store.getText('people.json')) !== peopleJson || !(await deps.store.getBytes('sprites.zip'));
  await deps.store.set('mirrored.json', JSON.stringify(mirrored));
  await deps.store.set('people.json', peopleJson);
  await deps.store.set('unmatched.json', JSON.stringify(unmatched));
  await deps.store.set('stats.json', JSON.stringify(stats));
  if (changed) {
    const files: Record<string, Uint8Array> = { 'people.json': strToU8(JSON.stringify(people, null, 1)) };
    for (const id of Object.keys(mirrored)) { const png = await deps.store.getBytes(`sprites/${id}.png`); if (png) files[`sprites/${id}.png`] = png; }
    await deps.store.set('sprites.zip', zipSync(files, { level: 6 }));
  }
  return { sprites: sprites.length, mirroredNow, withSprite: stats.withSprite, unmatched: unmatched.length };
}

export async function handlePeople(request: Request, deps: PeopleDeps): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json('{"error":"GET only"}', 'no-store', 405);
  if (path === '/people/refresh') {
    try { return json(JSON.stringify(await refresh(deps)), 'no-store'); }
    catch (error) { return json(JSON.stringify({ error: error instanceof Error ? error.message : 'refresh failed' }), 'no-store', 502); }
  }
  const doc = ({ '/people.json': 'people.json', '/people/stats.json': 'stats.json', '/people/unmatched.json': 'unmatched.json' } as Record<string, string>)[path];
  if (doc) {
    let body = await deps.store.getText(doc);
    if (body === null) { try { await refresh(deps); body = await deps.store.getText(doc); } catch { /* answered below */ } }
    return body === null ? json('{"error":"not ready"}', 'no-store', 503) : json(body);
  }
  if (path === '/people/capture') {
    const wallet = (new URL(request.url).searchParams.get('wallet') ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) return json('{"error":"wallet: 0x and 40 hex digits"}', 'no-store', 400);
    const people = JSON.parse((await deps.store.getText('people.json')) ?? '[]') as Person[];
    const mine = people.filter((p) => p.wallet === wallet).sort((a, b) => Number(Boolean(a.sprite)) - Number(Boolean(b.sprite)));
    if (!mine.length) return json('{"error":"this wallet holds no name of the wall"}', 'no-store', 404);
    return json(JSON.stringify({ url: CAPTURE_URL, names: mine.map((p) => ({ name: p.name, panel: p.panel, character: Boolean(p.sprite) })) }), 'private, max-age=60');
  }
  const sprite = /^\/people\/sprites\/([0-9a-f-]{36})\.png$/.exec(path);
  if (sprite) {
    const png = await deps.store.getBytes(`sprites/${sprite[1]}.png`);
    return png ? new Response(png, { headers: { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
      : new Response('not found', { status: 404, headers: cors });
  }
  if (path === '/people/sprites.zip') {
    const zip = await deps.store.getBytes('sprites.zip');
    return zip ? new Response(zip, { headers: { ...cors, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="people-of-the-wall-sprites.zip"', 'Cache-Control': 'public, max-age=300' } })
      : new Response('not ready', { status: 503, headers: cors });
  }
  return new Response('not found', { status: 404, headers: cors });
}

/** For the cards (src/service.ts): the sprite id of each name (people.json, read at most once a minute) and a mirrored
 *  sheet's bytes, straight from this store. */
export function peopleSprites(store: PeopleStore, now: () => number = Date.now): { idsOf(names: string[]): Promise<(string | null)[]>; sheet(id: string): Promise<Uint8Array | null> } {
  let cache: { at: number; ids: Map<string, string> } | null = null;
  return {
    async idsOf(names) {
      if (!cache || now() - cache.at > 60_000) {
        const people = JSON.parse((await store.getText('people.json')) ?? '[]') as Person[];
        cache = { at: now(), ids: new Map(people.filter((p) => p.sprite).map((p) => [keyOf(p.name), (p.sprite as NonNullable<Person['sprite']>).id])) };
      }
      const ids = cache.ids;
      return names.map((n) => ids.get(keyOf(n)) ?? null);
    },
    sheet: (id) => (/^[0-9a-f-]{36}$/.test(id) ? store.getBytes(`sprites/${id}.png`) : Promise.resolve(null)),
  };
}
