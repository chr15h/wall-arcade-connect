// PEOPLE (src/people.ts, src/people-service.ts): people.json from the wall + Sprite Party + aliases, the mirror, the routes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { MANIFEST_URL, POSITIONS_URL, keyOf, type Person } from '../src/people.js';
import { handlePeople, refresh, type PeopleDeps, type PeopleStore } from '../src/people-service.js';

const JOHN = 'ffb3674b-17cb-48d9-a89d-840c48ad39b6', GHOST = '0b5a6f1e-0000-4000-8000-000000000001', MONO = '0b5a6f1e-0000-4000-8000-000000000002';
/** The first bytes of a PNG of w × h (the service checks the signature and the IHDR). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
const named: Record<number, object> = {
  1: { name: 'MONOKAI', owner: '0xAaAa000000000000000000000000000000000001', updatedAt: '2026-09-10T17:31:07.013Z' },
  2: { name: 'ALPHALABS.XYZ', owner: '0xAaAa000000000000000000000000000000000002', xHandle: 'alphalabs_xyz' },
  342: { name: 'KARP', owner: '0xAaAa000000000000000000000000000000000342', updatedAt: '2026-09-13T14:57:33.198Z' },
};
// the wall: 500 name panels, three of them painted
const positions = Array.from({ length: 500 }, (_, i) => ({ position: i + 1, tier: 'name', minted: Boolean(named[i + 1]), ...named[i + 1] }));
let sprites = [
  { id: JOHN, name: 'John Karp', src: `/api/assets?key=sprites%2F${JOHN}.png`, cols: 4, rows: 4 },
  { id: GHOST, name: 'Nobody On The Wall', src: `/api/assets?key=sprites%2F${GHOST}.png`, cols: 4, rows: 4 },
  { id: 'not-a-uuid', name: 'KARP', src: '/api/assets?key=x', cols: 4, rows: 4 },
];
let fetches: string[] = [];
const fakeFetch = (async (url: string) => {
  fetches.push(url);
  if (url === POSITIONS_URL) return new Response(JSON.stringify({ positions }));   // the shape the wall answers to a server
  if (url === MANIFEST_URL) return new Response(JSON.stringify({ partyName: 'PEOPLE OF THE WALL', sprites }));
  if (url.includes(MONO)) return new Response(png(64, 64));                              // a sheet of the wrong size
  if (url.includes('/api/assets?')) return new Response(png(192, 192));
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;
function memory(): PeopleStore & { data: Map<string, string | Uint8Array> } {
  const data = new Map<string, string | Uint8Array>();
  return {
    data,
    getText: async (k) => { const v = data.get(k); return typeof v === 'string' ? v : null; },
    getBytes: async (k) => { const v = data.get(k); return v instanceof Uint8Array ? v : null; },
    set: async (k, v) => { data.set(k, v); },
  };
}
const store = memory();
const deps: PeopleDeps = { store, fetch: fakeFetch, aliases: { 'John Karp': 'KARP' }, now: () => Date.parse('2026-10-27T12:00:00Z') };
const get = async (path: string): Promise<Response> => handlePeople(new Request(`https://wall-arcade-cards.netlify.app${path}`), deps);

test('names match ignoring case, spaces and accents', () => {
  assert.equal(keyOf('mono kái'), 'MONOKAI');
  assert.equal(keyOf(' John\tKarp '), 'JOHNKARP');
  assert.notEqual(keyOf('John Karp'), keyOf('JOHNKARP.ETH'));
});

test("John's sprite is KARP's, through aliases.json; a name without sprite has null; a sprite without name is unmatched", async () => {
  const summary = await refresh(deps);
  assert.deepEqual(summary, { sprites: 2, mirroredNow: 2, withSprite: 1, unmatched: 1 });
  const people = await (await get('/people.json')).json() as Person[];
  assert.equal(people.length, 3, 'one object per named panel');
  const karp = people.find((p) => p.name === 'KARP') as Person;
  assert.deepEqual(karp, {
    panel: 342, name: 'KARP', handle: null, wallet: '0xaaaa000000000000000000000000000000000342',
    sprite: { id: JOHN, url: `https://wall-arcade-cards.netlify.app/people/sprites/${JOHN}.png`, cols: 4, rows: 4, frame: 48 },
    updatedAt: '2026-10-27T12:00:00.000Z',
  });
  assert.equal(people.find((p) => p.name === 'MONOKAI')?.sprite, null);
  assert.equal(people.find((p) => p.name === 'ALPHALABS.XYZ')?.handle, 'alphalabs_xyz');
  const unmatched = await (await get('/people/unmatched.json')).json() as { name: string }[];
  assert.deepEqual(unmatched.map((u) => u.name), ['Nobody On The Wall']);
  assert.deepEqual(await (await get('/people/stats.json')).json(), { names: 3, withSprite: 1, lastSpriteAt: '2026-10-27T12:00:00.000Z' });
});

test('the sprite sheets are mirrored once, served with CORS; a sheet of the wrong size is refused; the zip holds them', async () => {
  const sheet = await get(`/people/sprites/${JOHN}.png`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get('access-control-allow-origin'), '*');
  assert.match(sheet.headers.get('cache-control') ?? '', /immutable/);
  assert.equal((await get('/people.json')).headers.get('access-control-allow-origin'), '*');
  fetches = [];
  sprites = [...sprites, { id: MONO, name: 'monokai', src: `/api/assets?key=sprites%2F${MONO}.png`, cols: 4, rows: 4 }];
  const again = await refresh(deps);
  assert.equal(again.mirroredNow, 0, 'nothing new mirrored');
  assert.deepEqual(fetches.filter((u) => u.includes('/api/assets?')), [`https://www.spriteparty.com/api/assets?key=sprites%2F${MONO}.png`], 'only the new sheet is fetched');
  assert.equal((await get(`/people/sprites/${MONO}.png`)).status, 404, 'a 64 × 64 sheet is not served');
  const zip = unzipSync(new Uint8Array(await (await get('/people/sprites.zip')).arrayBuffer()));
  assert.deepEqual(Object.keys(zip).sort(), ['people.json', `sprites/${GHOST}.png`, `sprites/${JOHN}.png`]);
  assert.equal((JSON.parse(strFromU8(zip['people.json'] as Uint8Array)) as Person[]).length, 3);
  assert.equal((await get('/people/nope')).status, 404);
});
