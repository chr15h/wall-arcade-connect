// STATS (src/events.ts, src/stats.ts, src/stats-sources.ts, src/stats-service.ts): the tags, the free/paid rule, the sums.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventsOfDay, parseEvent, recordEvent, type ArcadeEvent, type EventStore } from '../src/events.js';
import { handleEvents, handleStats } from '../src/stats-service.js';
import { buildStats, classify, LAUNCH, paidStarts, windows } from '../src/stats.js';
import { refreshStats, type StatsDeps } from '../src/stats-sources.js';

const FR = '5932be45-7ccb-483a-916d-0dcebff40ca2', UB = 'c5285ae3-512e-464a-aceb-17571e1fe3e9', DSR = '8617e311-f5d4-4e04-9010-19298f2ff9a0';
const GAMES3 = [
  { id: FR, title: 'FULL ROW', origin: 'https://yfq52eu3.srstudio.dev', tag: 'full-row' },
  { id: UB, title: 'UNBREAKABLE', origin: 'https://7x2phv5j.srstudio.dev', tag: 'unbreakable' },
  { id: DSR, title: 'Dirty Signals Radio', origin: 'https://sy3mgnnh.srstudio.dev' },
];
const HOLDER = '0xaaaa000000000000000000000000000000000342', OTHER = '0xbbbb000000000000000000000000000000000001';
const at = (iso: string): number => Date.parse(iso);

function memoryStore(): EventStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getText: async (k) => data.get(k) ?? null,
    set: async (k, v) => { data.set(k, v); },
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

test('free versus paid: a holder\'s first 3 paid starts of the week are free, the 4th is paid; a non-holder\'s are all paid', () => {
  const start = (w: string, iso: string, run: string): ArcadeEvent => ({ t: at(iso), e: 'paid_start', g: 'full-row', w, x: { run } });
  const events = [
    start(HOLDER, '2026-10-27T15:00:00Z', 'r1'), start(HOLDER, '2026-10-27T15:10:00Z', 'r2'),
    start(HOLDER, '2026-10-27T15:10:30Z', 'r2'),                   // the same run tagged again after a reload
    start(HOLDER, '2026-10-28T09:00:00Z', 'r3'), start(HOLDER, '2026-10-28T10:00:00Z', 'r4'),
    start(OTHER, '2026-10-27T16:00:00Z', 'r5'),
    start(HOLDER, '2026-10-30T15:30:00Z', 'r6'),                   // a new week (Friday 15:00 Lisbon): free again
    { t: at('2026-10-27T17:00:00Z'), e: 'paid_start', g: 'unbreakable' } as ArcadeEvent,   // no wallet
  ];
  const kinds = classify(paidStarts(events), new Set([HOLDER]));
  assert.deepEqual(kinds.map((k) => `${k.event.x?.run ?? '-'}:${k.kind}`), ['r1:free', 'r2:free', 'r5:paid', '-:unknown', 'r3:free', 'r4:paid', 'r6:free']);
});

test('events: checked, stamped, one blob each, folded into the day\'s file once', async () => {
  assert.throws(() => parseEvent({ event: 'card_view' }, 0), /unknown event/);         // the service's own events
  assert.throws(() => parseEvent({ event: 'hub_view', cookie: 'x' }, 0), /unexpected field cookie/);
  assert.throws(() => parseEvent({ event: 'paid_start', wallet: 'me' }, 0), /wallet/);
  const e = parseEvent({ event: 'paid_start', game: 'full-row', wallet: HOLDER.toUpperCase().replace('0X', '0x'), extra: { run: 'abc', creditsBefore: 3 } }, at('2026-10-27T15:00:00Z'));
  assert.deepEqual(e, { t: at('2026-10-27T15:00:00Z'), e: 'paid_start', g: 'full-row', w: HOLDER, x: { run: 'abc', creditsBefore: 3 } });

  const store = memoryStore();
  await recordEvent(store, e);
  await recordEvent(store, { t: at('2026-10-27T15:01:00Z'), e: 'hub_view' });
  const first = await eventsOfDay(store, '2026-10-27');
  assert.equal(first.length, 2);
  assert.equal(store.data.get('2026-10-27.ndjson')?.trim().split('\n').length, 2);
  await recordEvent(store, { t: at('2026-10-27T15:02:00Z'), e: 'game_open', g: 'unbreakable' });
  const again = await eventsOfDay(store, '2026-10-27');
  assert.deepEqual(again.map((x) => x.e), ['paid_start', 'hub_view', 'game_open']);
  assert.equal((await eventsOfDay(store, '2026-10-27')).length, 3);                    // folding twice changes nothing
});

test('POST /api/events: only from the arcade\'s pages, 204, no body', async () => {
  const store = memoryStore();
  const post = (origin: string | null, body: unknown): Promise<Response> => handleEvents(new Request('https://cards.test/api/events', {
    method: 'POST', body: JSON.stringify(body), headers: origin ? { origin, 'content-type': 'text/plain' } : {},
  }), { events: store, now: () => at('2026-10-27T15:00:00Z') });
  assert.equal((await post('https://yfq52eu3.srstudio.dev', { event: 'game_open', game: 'full-row' })).status, 204);
  assert.equal((await post('https://evil.example', { event: 'game_open' })).status, 403);
  assert.equal((await post(null, { event: 'game_open' })).status, 403);
  assert.equal((await post('https://6972mvu4.srstudio.dev', { event: 'nope' })).status, 400);
  assert.equal([...store.data.keys()].length, 1);
});

test('the sums: official plays, free/paid, players, packs, the funnel, three windows', () => {
  const now = at('2026-10-27T19:00:00Z');
  const ev = (iso: string, e: ArcadeEvent['e'], more: Partial<ArcadeEvent> = {}): ArcadeEvent => ({ t: at(iso), e, ...more });
  const events: ArcadeEvent[] = [
    ev('2026-10-27T14:10:00Z', 'hub_view'), ev('2026-10-27T14:11:00Z', 'hub_view'), ev('2026-10-27T14:12:00Z', 'hub_view'),
    ev('2026-10-27T14:13:00Z', 'game_open', { g: 'full-row' }), ev('2026-10-27T14:14:00Z', 'game_open', { g: 'unbreakable' }),
    ev('2026-10-27T14:15:00Z', 'practice_start', { g: 'full-row' }),
    ...[1, 2, 3, 4].map((i) => ev(`2026-10-27T15:0${i}:00Z`, 'paid_start', { g: 'full-row', w: HOLDER, x: { run: `h${i}` } })),
    ev('2026-10-27T16:00:00Z', 'paid_start', { g: 'unbreakable', w: OTHER, x: { run: 'o1' } }),
    ev('2026-10-27T16:05:00Z', 'paid_end', { g: 'unbreakable', w: OTHER, s: 400 }),
    ev('2026-10-27T16:06:00Z', 'post_on_x', { g: 'unbreakable', w: OTHER }),
    ev('2026-10-27T16:07:00Z', 'card_create', { g: 'unbreakable', c: 'AAAAAAAAAAAAAAAA' }),
    ev('2026-10-27T16:30:00Z', 'card_view', { c: 'AAAAAAAAAAAAAAAA', x: { fromX: true } }),
    ev('2026-10-27T16:31:00Z', 'card_view', { c: 'AAAAAAAAAAAAAAAA', x: { fromX: false } }),
  ];
  const usage = { games: { [FR]: { started: 4, completed: 3, credits: 4 }, [UB]: { started: 2, completed: 2, credits: 2 }, [DSR]: { started: 1, completed: 1, credits: 1 } }, total: { started: 7, completed: 6, credits: 7 } };
  const s = buildStats({
    now, games: GAMES3, events, usage: { today: usage, week: usage, launch: usage, days: { '2026-10-27': usage } }, holders: new Set([HOLDER]),
    packs: [{ t: at('2026-10-27T15:35:00Z'), wallet: OTHER, name: 'tylerguyot.eth', eth: 0.005, packs: 1 }],
    leaderboards: { [UB]: { today: [{ name: 'tylerguyot.eth', score: 400, at: null }] } }, pot: '0.0150',
    people: { names: 190, withSprite: 6, unmatched: 3, lastSpriteAt: null, mirrored: { a: '2026-10-27T15:00:00Z', b: '2026-10-26T15:00:00Z' } }, sources: {},
  });
  const today = s.windows.today as any;
  assert.deepEqual(windows(now).map((w) => [w.key, new Date(w.from).toISOString()]), [['today', '2026-10-27T00:00:00.000Z'], ['week', '2026-10-21T23:00:00.000Z'], ['launch', '2026-10-27T14:00:00.000Z']]);
  assert.equal(LAUNCH, at('2026-10-27T14:00:00Z'));
  const fr = today.plays.games[FR], ub = today.plays.games[UB], dsr = today.plays.games[DSR], tot = today.plays.total;
  assert.deepEqual(s.games.map((g) => g.title), ['FULL ROW', 'UNBREAKABLE', 'Dirty Signals Radio']);
  assert.deepEqual([dsr.started, dsr.completed, dsr.free, dsr.paid, dsr.unattributed, dsr.practice], [1, 1, 0, 0, 1, 0]);   // an artist's game: not tagged by us
  assert.deepEqual([fr.started, fr.completed, fr.abandoned, fr.free, fr.paid, fr.practice, fr.official], [4, 3, 1, 3, 1, 1, true]);
  assert.deepEqual([ub.started, ub.free, ub.paid, ub.unattributed, ub.diff], [2, 0, 1, 1, -1]);       // one start not tagged
  assert.deepEqual([tot.started, tot.completed, tot.free, tot.paid], [7, 6, 3, 2]);
  assert.deepEqual([today.players.wallets, today.players.holders, today.players.nonHolders, today.players.newToday], [2, 1, 1, 2]);
  assert.deepEqual(today.players.playsPerPlayer, { avg: 2.5, max: 4 });
  assert.deepEqual([today.money.packs, today.money.conversion], [1, 50]);                    // 1 buyer of the 2 paying players
  assert.deepEqual([today.share.cards, today.share.postOnX, today.share.cardViews, today.share.fromX], [1, 1, 2, 1]);
  assert.equal(today.sprites, 1);
  assert.deepEqual(s.funnel.map((f) => [f.count, f.pct]), [[3, null], [2, 66.7], [1, 50], [7, 700], [6, 85.7], [1, 16.7], [1, 100]]);
  assert.deepEqual(s.days, [{ day: '2026-10-27', plays: 7, official: true, players: 2, packs: 1, cards: 1, sprites: 1 }]);
  assert.equal(s.hours[15]?.paid, 4);
  assert.deepEqual(s.credits, { granted: 570, bought: 50, consumed: 7, inCirculation: 613 });
  assert.equal(s.now.weekEndsAt, '2026-10-30T15:00:00.000Z');
});

test('refreshStats without a token: the tags and the other sources still count, the page and stats.json answer', async () => {
  const events = memoryStore(), kept = new Map<string, string>();
  await recordEvent(events, { t: at('2026-10-27T15:00:00Z'), e: 'paid_start', g: 'full-row', w: HOLDER, x: { run: 'a' } });
  await recordEvent(events, { t: at('2026-10-27T15:01:00Z'), e: 'paid_start', g: 'full-row', w: HOLDER, x: { run: 'b', test: 'check' } });   // a check, not counted
  const fakeFetch = (async (url: string) => {
    if (url.startsWith('https://eth.blockscout.com/')) return Response.json({ items: [
      { timestamp: '2026-10-27T15:35:00Z', value: '5000000000000000', result: 'success', from: { hash: OTHER, ens_domain_name: 'tylerguyot.eth' }, to: { hash: '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad' } },
      { timestamp: '2026-10-27T15:40:00Z', value: '5000000000000000', result: 'success', from: { hash: '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad' }, to: { hash: OTHER } },   // a payout, out
      { timestamp: '2026-10-21T10:00:00Z', value: '5000000000000000', result: 'success', from: { hash: HOLDER, ens_domain_name: null }, to: { hash: '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad' } },
    ], next_page_params: null });
    if (url.includes('/scoring/leaderboard')) return Response.json({ entries: [{ score: '515', achievedAt: '2026-10-27T16:33:25Z', player: { ensName: 'johnkarp.eth' } }] });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const people = { getText: async (k: string) => (k === 'people.json' ? JSON.stringify([{ panel: 342, name: 'KARP', wallet: HOLDER, sprite: null }]) : null), getBytes: async () => null, set: async () => {} };
  const deps: StatsDeps = {
    fetch: fakeFetch, now: () => at('2026-10-27T19:00:00Z'), token: undefined, events, people,
    pot: { store: { get: async () => null, set: async () => {} }, balance: async () => 15_000_000_000_000_000n },
    store: { getText: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.set(k, v); } },
  };
  const s = await refreshStats(deps);
  assert.equal(s.sources.usage, 'no RARE_PROFILE_TOKEN');
  assert.equal(s.now.pot, '0.0150');
  const today = s.windows.today as any;
  assert.deepEqual([today.plays.total.started, today.plays.total.free, today.plays.total.official], [1, 1, false]);
  assert.deepEqual(today.money.buyers.map((b: { name: string }) => b.name), ['tylerguyot.eth']);   // John's test pack of the 21st is before the launch
  assert.equal(today.players.leaderboards[UB].top3[0].name, 'johnkarp.eth');
  assert.ok(kept.get('stats.json'));
  const page = await handleStats(new Request('https://cards.test/stats'), deps);
  const html = await page.text();
  assert.match(html, /Arcade Stats/);
  assert.match(html, /tylerguyot\.eth/);
  assert.match(html, /no RARE_PROFILE_TOKEN/);
  const json = await (await handleStats(new Request('https://cards.test/stats.json'), deps)).json() as { generatedAt: string };
  assert.equal(json.generatedAt, '2026-10-27T19:00:00.000Z');
});

test('a card\'s page opened is tagged (from X when the referer is t.co / x.com), a link preview bot is not', async () => {
  const { handle } = await import('../src/service.js');
  const card = { kind: 'bounce', names: [], people: 0, score: 10, practice: false };
  const files = new Map<string, unknown>([['AAAAAAAAAAAAAAAA.json', card]]);
  const tags: ArcadeEvent[] = [];
  const deps = {
    store: { get: (async (k: string) => files.get(k) ?? null) as never, set: async () => undefined },
    wallNames: async () => [], leaderboard: async () => [], tag: async (e: ArcadeEvent) => { tags.push(e); }, now: () => 1,
  };
  const open = (headers: Record<string, string>): Promise<Response> => handle(new Request('https://cards.test/r/AAAAAAAAAAAAAAAA', { headers }), deps);
  assert.equal((await open({ referer: 'https://t.co/abc', 'user-agent': 'Mozilla/5.0 (iPhone)' })).status, 200);
  await open({ 'user-agent': 'Mozilla/5.0' });
  await open({ 'user-agent': 'Twitterbot/1.0' });
  assert.deepEqual(tags.map((t) => [t.e, t.g, t.c, t.x?.fromX]), [['card_view', 'unbreakable', 'AAAAAAAAAAAAAAAA', true], ['card_view', 'unbreakable', 'AAAAAAAAAAAAAAAA', false]]);
});

test('with a token: one line per app of the group, named by the usage report or its page, the official counts', async () => {
  const kept = new Map<string, string>(), asked: string[] = [];
  const group = { id: '60faaf46-ba4b-460c-a82a-adb852371a94', slug: 'wall-arcade-nfc-50', displayName: 'THE WALL ARCADE credits', chainId: 1, currency: 'ETH', tokenAddress: null,
    treasuryAddress: '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad', packPriceAtomic: '5000000000000000', packCredits: 50, purchasesPaused: false, newUsesPaused: false, paymentConfigId: null,
    apps: [FR, UB, DSR, 'feedbeef-0000-4000-8000-000000000000'].map((productId, i) => ({ productId, origin: ['https://yfq52eu3.srstudio.dev', 'https://7x2phv5j.srstudio.dev', 'https://sy3mgnnh.srstudio.dev', 'https://zzzzzzzz.srstudio.dev'][i], creditCost: 1 })) };
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    if (url === 'https://studio.superrare.com/auth/cli/exchange') { asked.push('exchange'); return Response.json(JSON.parse(String(init?.body)).token === 'slk_test' ? { sessionToken: 'jwt_test' } : {}); }
    if (url.startsWith('https://studio.superrare.com')) {
      if ((init?.headers as Record<string, string>).Authorization !== 'Bearer jwt_test') return Response.json({ error: 'auth' }, { status: 401 });
      const body = JSON.parse(String(init?.body)) as { action: string; from?: string };
      asked.push(body.action);
      if (body.action === 'get-credit-group') return Response.json({ group });
      if (body.action === 'get-credit-group-usage') return Response.json({ groupId: group.id, from: body.from, to: body.from, page: { hasMore: false, nextCursor: null },
        totals: { capturedPlays: '7', completedPlays: '6', creditsConsumed: '7' },
        games: [{ appId: FR, title: 'FULL ROW', capturedPlays: '2', completedPlays: '2', creditsConsumed: '2' }, { appId: UB, title: 'UNBREAKABLE', capturedPlays: '4', completedPlays: '3', creditsConsumed: '4' },
          { appId: DSR, title: 'Dirty Signals Radio', capturedPlays: '1', completedPlays: '1', creditsConsumed: '1' }] });
    }
    if (url === 'https://zzzzzzzz.srstudio.dev/') return new Response('<title>Next Game · Someone · The Wall Arcade</title>');
    if (url.includes('/scoring/leaderboard')) return url.startsWith('https://sy3mgnnh') ? new Response('no', { status: 404 }) : Response.json({ entries: [] });
    if (url.startsWith('https://eth.blockscout.com/')) return Response.json({ items: [], next_page_params: null });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  const deps: StatsDeps = {
    fetch: fakeFetch, now: () => at('2026-10-27T19:00:00Z'), token: 'slk_test', events: memoryStore(),
    people: { getText: async () => null, getBytes: async () => null, set: async () => {} },
    pot: { store: { get: async () => null, set: async () => {} }, balance: async () => 0n },
    store: { getText: async (k) => kept.get(k) ?? null, set: async (k, v) => { kept.set(k, v); } },
  };
  const s = await refreshStats(deps);
  assert.equal(s.sources.usage, 'ok');
  assert.equal(s.sources.leaderboards, 'none for Dirty Signals Radio');
  assert.deepEqual(s.games.map((g) => g.title), ['FULL ROW', 'UNBREAKABLE', 'Dirty Signals Radio', 'Next Game']);
  const today = s.windows.launch as any;
  assert.deepEqual(Object.values(today.plays.games).map((r: any) => [r.started, r.completed, r.official]), [[2, 2, true], [4, 3, true], [1, 1, true], [0, 0, true]]);
  assert.deepEqual([today.plays.total.started, today.plays.total.completed], [7, 6]);
  assert.ok(asked.includes('get-credit-group'));
  assert.equal(asked.filter((a) => a === 'exchange').length, 1);                        // one session for the whole refresh
  assert.equal(JSON.parse(kept.get('games.json') ?? '{}')['feedbeef-0000-4000-8000-000000000000'], 'Next Game');
  const html = await (await handleStats(new Request('https://cards.test/stats'), deps)).text();
  assert.match(html, /<th>Dirty Signals Radio<\/th>/);
  assert.match(html, /<th>Next Game<\/th>/);
  assert.doesNotMatch(html, /slk_test/);
});
