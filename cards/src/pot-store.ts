// The jackpot's store on Netlify Blobs (store "pot"): the last amount served, for when no RPC answers.
import { getStore } from '@netlify/blobs';
import type { PotStore } from './pot.js';

export function potStore(): PotStore {
  const store = getStore({ name: 'pot', consistency: 'strong' });
  return {
    get: (key) => store.get(key, { type: 'text' }),
    set: async (key, value) => { await store.set(key, value); },
  };
}
