// The stats' stores on Netlify Blobs: "events" (our tags, cards/src/events.ts) and "stats" (stats.json, the usage report's past days).
import { getStore } from '@netlify/blobs';
import type { EventStore } from './events.js';

export function eventStore(): EventStore {
  const store = getStore({ name: 'events', consistency: 'strong' });
  return {
    getText: (key) => store.get(key, { type: 'text' }),
    set: async (key, value) => { await store.set(key, value); },
    list: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key),
  };
}
export function statsStore(): { getText(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } {
  const store = getStore({ name: 'stats', consistency: 'strong' });
  return { getText: (key) => store.get(key, { type: 'text' }), set: async (key, value) => { await store.set(key, value); } };
}
