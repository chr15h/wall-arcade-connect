// PEOPLE's store on Netlify Blobs (store "people"): the mirrored sprite sheets and the built documents.
import { getStore } from '@netlify/blobs';
import type { PeopleStore } from './people-service.js';

export function peopleStore(): PeopleStore {
  const store = getStore({ name: 'people', consistency: 'strong' });
  return {
    getText: (key) => store.get(key, { type: 'text' }),
    getBytes: async (key) => { const b = await store.get(key, { type: 'arrayBuffer' }); return b ? new Uint8Array(b) : null; },
    set: async (key, value) => { await store.set(key, typeof value === 'string' ? value : (value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)); },
  };
}
