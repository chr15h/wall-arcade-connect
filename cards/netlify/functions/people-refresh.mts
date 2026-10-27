// Every 5 minutes: new sprites from Sprite Party mirrored, people.json rebuilt (cards/src/people-service.ts, refresh).
import aliases from '../../people/aliases.json' with { type: 'json' };
import { refresh } from '../../src/people-service.js';
import { peopleStore } from '../../src/people-store.js';

export default async (): Promise<void> => { await refresh({ store: peopleStore(), fetch, aliases, now: () => Date.now() }); };

export const config = { schedule: '*/5 * * * *' };
