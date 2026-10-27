// PEOPLE: people.json, the mirrored sprite sheets, stats, unmatched, the zip, refresh (cards/src/people-service.ts).
import aliases from '../../people/aliases.json' with { type: 'json' };
import { handlePeople } from '../../src/people-service.js';
import { peopleStore } from '../../src/people-store.js';

export default async (request: Request): Promise<Response> => handlePeople(request, { store: peopleStore(), fetch, aliases, now: () => Date.now() });

export const config = { path: ['/people.json', '/people/*'] };
