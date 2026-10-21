// THE WALL ARCADE's jackpot: the treasury wallet's balance, live (independent of Netlify: netlify/functions/pot.mts
// plugs in Netlify Blobs and fetch). Every paid play goes straight into it; every Friday it is split by hand.
// If no public RPC answers, the last amount served is served again; with none, an error (the hub keeps "— ETH").
// Nothing of the former arcade (packs, coins, its own pot) is read or reused.
export const TREASURY = '0xb6ede0158e1792ed25e1367edeec05a824d7c9ad';
export const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://eth.llamarpc.com'];
const WEI = 10n ** 18n;

export interface PotStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
export type PotDeps = { store: PotStore; balance(): Promise<bigint> };
export type Pot = { pot: string };

/** Wei → ETH with 4 decimals, rounded down ("0.0150"). */
export function eth4(wei: bigint): string {
  const w = wei < 0n ? 0n : wei;
  const units = w / (WEI / 10_000n);
  return `${units / 10_000n}.${String(units % 10_000n).padStart(4, '0')}`;
}

/** The jackpot now; throws when nothing can be served. */
export async function currentPot(deps: PotDeps): Promise<Pot> {
  let balance: bigint;
  try { balance = await deps.balance(); } catch (error) {
    const last = await deps.store.get('last');
    if (last) return JSON.parse(last) as Pot;
    throw error;
  }
  const pot: Pot = { pot: eth4(balance) };
  await deps.store.set('last', JSON.stringify(pot));
  return pot;
}

/** eth_getBalance of the treasury at the latest block, from the first public RPC that answers. */
export async function treasuryBalance(fetchImpl: typeof fetch = fetch, rpcs: string[] = RPCS): Promise<bigint> {
  let lastError: unknown = new Error('no RPC');
  for (const url of rpcs) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [TREASURY, 'latest'] }),
      });
      const body = await response.json() as { result?: string };
      if (response.ok && typeof body.result === 'string' && /^0x[0-9a-f]+$/i.test(body.result)) return BigInt(body.result);
      lastError = new Error(`${url}: no balance`);
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
