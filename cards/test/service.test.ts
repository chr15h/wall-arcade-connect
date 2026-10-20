import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import snapshot from '../../src/generated/wall.json' with { type: 'json' };
import { handle, type CardStore } from '../src/service.js';

const names = snapshot.positions.map((p: { n: string }) => p.n);
function memoryStore(): CardStore & { data: Map<string, string | ArrayBuffer> } {
  const data = new Map<string, string | ArrayBuffer>();
  return {
    data,
    async get(key: string, type: 'json' | 'arrayBuffer'): Promise<any> {
      const v = data.get(key); if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v as string) : v;
    },
    async set(key: string, value: string | ArrayBuffer | Blob) { data.set(key, value as string | ArrayBuffer); return undefined; },
  } as CardStore & { data: Map<string, string | ArrayBuffer> };
}
const ORIGIN = 'https://cards.example';
const BOARD = [
  { rank: 1, score: '682', player: { kind: 'wallet', displayName: '0x1234567890abcdef1234567890abcdef12345678', ensName: 'player.eth' } },
  { rank: 2, score: '22', player: { kind: 'wallet', displayName: '0x510f00000000000000000000000000000000c839', ensName: null } },
  { rank: 3, score: '9', player: { kind: 'profile', displayName: 'Buy my token' } },
];
const deps = { store: memoryStore(), wallNames: async () => names, leaderboard: async () => BOARD };
const post = (body: unknown, origin = 'https://yfq52eu3.srstudio.dev') => handle(new Request(`${ORIGIN}/api/cards`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) }), deps);
const get = (path: string) => handle(new Request(`${ORIGIN}${path}`), deps);
const pngSize = (buf: ArrayBuffer): [number, number] => { const v = new DataView(buf); return [v.getUint32(16), v.getUint32(20)]; };
mkdirSync(new URL('../../dist/cards/', import.meta.url), { recursive: true });
const save = (name: string, buf: ArrayBuffer) => writeFileSync(new URL(`../../dist/cards/${name}`, import.meta.url), Buffer.from(buf));

const ROW = { kind: 'row', names: ['K4NCUN0', 'normies', 'JPEG-FRENS'], line: 'ROW 4', points: 120, score: 1460, player: 'player.eth' };

test('a row card: created once, same id for the same card, a page with the X tags that sends people to the cabinet', async () => {
  const r1 = await post(ROW), b1 = await r1.json() as { id: string; url: string; image: string };
  assert.equal(r1.status, 200); assert.match(b1.id, /^[A-Za-z0-9_-]{16}$/); assert.equal(b1.url, `${ORIGIN}/r/${b1.id}`);
  assert.equal(r1.headers.get('access-control-allow-origin'), 'https://yfq52eu3.srstudio.dev');
  const b2 = await (await post({ ...ROW })).json() as { id: string };
  assert.equal(b2.id, b1.id, 'deterministic id');
  const html = await (await get(`/r/${b1.id}`)).text();
  for (const tag of ['<meta name="twitter:card" content="summary_large_image">', `<meta property="og:image" content="${ORIGIN}/r/${b1.id}.x.png">`,
    '<meta http-equiv="refresh" content="0; url=https://yfq52eu3.srstudio.dev/">', 'K4NCUN0 · NORMIES · JPEG-FRENS']) assert.ok(html.includes(tag), tag);
  const square = await (await get(`/r/${b1.id}.png`)).arrayBuffer(), wide = await (await get(`/r/${b1.id}.x.png`)).arrayBuffer();
  assert.deepEqual(pngSize(square), [1080, 1080]); assert.deepEqual(pngSize(wide), [1200, 630]);
  save('service-row.png', square); save('service-row.x.png', wide);
});

test('a bounce card and a board card render too', async () => {
  const bounce = await (await post({ kind: 'bounce', names: ['THE', 'CERA', 'GVC', 'ANIMATTTIC', 'DAN'], people: 12, score: 208 }, 'https://7x2phv5j.srstudio.dev')).json() as { id: string };
  const html = await (await get(`/r/${bounce.id}`)).text();
  assert.ok(html.includes('url=https://7x2phv5j.srstudio.dev/'));
  save('service-bounce.png', await (await get(`/r/${bounce.id}.png`)).arrayBuffer());
  const board = await (await post({ kind: 'board', game: 'full-row', me: 'player.eth' })).json() as { id: string };
  const boardHtml = await (await get(`/r/${board.id}`)).text();
  assert.ok(boardHtml.includes('#1 on FULL ROW · 682 points.'), 'the rows come from the platform');
  assert.ok(!boardHtml.includes('token'), 'a name that is neither ENS nor an address is left out');
  const byAddress = await (await post({ kind: 'board', game: 'full-row', me: '0x510f00000000000000000000000000000000c839' })).json() as { id: string };
  assert.ok((await (await get(`/r/${byAddress.id}`)).text()).includes('#2 on FULL ROW · 22 points.'));
  save('service-board.png', await (await get(`/r/${board.id}.png`)).arrayBuffer());
  save('service-board.x.png', await (await get(`/r/${board.id}.x.png`)).arrayBuffer());
});

test('nothing else can appear on a card', async () => {
  const bad: unknown[] = [
    { ...ROW, names: ['HELLO WORLD'] }, { ...ROW, names: [] }, { ...ROW, names: Array(9).fill('NORMIES') },
    { ...ROW, score: '1460' }, { ...ROW, score: -1 }, { ...ROW, score: 1.5 }, { ...ROW, points: 10 ** 9 },
    { ...ROW, player: 'buy my token' }, { ...ROW, player: '<script>' }, { ...ROW, player: 'x'.repeat(50) + '.eth' },
    { ...ROW, line: 'ROW 9' }, { ...ROW, extra: 1 }, { ...ROW, kind: 'tweet' },
    { kind: 'bounce', names: ['NORMIES', 'STONE'], people: 1, score: 3 },
    { kind: 'board', game: 'tap-the-name' },
    { kind: 'board', game: 'full-row', rows: [{ rank: 1, name: 'a.eth', score: 999999 }] },
    { kind: 'board', game: 'full-row', me: 'Free money' },
  ];
  for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 90));
  const big = await handle(new Request(`${ORIGIN}/api/cards`, { method: 'POST', body: 'x'.repeat(9000) }), deps);
  assert.equal(big.status, 413);
  assert.equal((await post(ROW, 'https://evil.example')).headers.get('access-control-allow-origin'), null, 'no CORS for other sites');
  assert.equal((await get('/r/AAAAAAAAAAAAAAAA')).status, 404); assert.equal((await get('/r/../x')).status, 404);
  const full = await (await post({ ...ROW, player: '0x1234567890AbcdEF1234567890aBcDeF12345678' })).json() as { id: string };
  assert.ok((await (await get(`/r/${full.id}`)).text()).includes('by 0x1234…5678'), 'a full address is shortened');
});
