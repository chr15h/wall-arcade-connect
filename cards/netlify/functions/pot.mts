// GET /pot: THE WALL ARCADE's jackpot, the treasury's balance, live (cards/src/pot.ts). Public, read-only, cached 60 s.
import { currentPot, treasuryBalance } from '../../src/pot.js';
import { potStore } from '../../src/pot-store.js';

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
export default async (): Promise<Response> => {
  try {
    const pot = await currentPot({ store: potStore(), balance: () => treasuryBalance() });
    return new Response(JSON.stringify(pot), { headers: { ...headers, 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': 'public, s-maxage=60' } });
  } catch {
    return new Response(JSON.stringify({ error: 'the jackpot cannot be read right now' }), { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
};

export const config = { path: '/pot' };
