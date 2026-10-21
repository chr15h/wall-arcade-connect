// The jackpot (src/pot.ts): the treasury's balance, live, 4 decimals; the last amount served again when no RPC answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentPot, eth4, treasuryBalance, type PotStore } from '../src/pot.js';

const ETH = 10n ** 18n, milli = (n: number): bigint => BigInt(n) * 10n ** 15n;
function memoryStore(): PotStore {
  const data = new Map<string, string>();
  return { get: async (key) => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); } };
}

test('ETH with 4 decimals, rounded down', () => {
  assert.equal(eth4(milli(15)), '0.0150');
  assert.equal(eth4(ETH + 2_399_999_999_999_999n), '1.0023');                    // 1.00239…: rounded down
  assert.equal(eth4(0n), '0.0000');
  assert.equal(eth4(12n * ETH + milli(345)), '12.3450');
});

test('the jackpot is the treasury balance', async () => {
  assert.deepEqual(await currentPot({ store: memoryStore(), balance: async () => milli(15) }), { pot: '0.0150' });
});

test('no RPC: the last amount served; none yet: an error (the hub keeps "— ETH")', async () => {
  const store = memoryStore();
  let up = true;
  const deps = { store, balance: async () => { if (!up) throw new Error('down'); return milli(2000); } };
  const first = await currentPot(deps);
  up = false;
  assert.deepEqual(await currentPot(deps), first);
  await assert.rejects(currentPot({ store: memoryStore(), balance: async () => { throw new Error('down'); } }));
});

test('the treasury balance comes from the first public RPC that answers', async () => {
  const calls: string[] = [];
  const fake = (async (url: string, init: { body: string }) => {
    calls.push(url);
    assert.match(init.body, /eth_getBalance.*0xb6ede0158e1792ed25e1367edeec05a824d7c9ad.*latest/);
    if (url === 'https://a.example') throw new Error('timeout');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xb1a2bc2ec50000' }));   // 0.05 ETH
  }) as unknown as typeof fetch;
  assert.equal(await treasuryBalance(fake, ['https://a.example', 'https://b.example']), milli(50));
  assert.deepEqual(calls, ['https://a.example', 'https://b.example']);
});
