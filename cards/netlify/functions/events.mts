// POST /api/events: the arcade's tags (cards/src/events.ts), one blob each in the store "events".
import { handleEvents } from '../../src/stats-service.js';
import { eventStore, statsStore } from '../../src/stats-store.js';
import { groupOf } from '../../src/group.js';

const group = groupOf(statsStore());                     // the credit group's apps and ours (cards/src/group.ts)
export default async (request: Request): Promise<Response> => handleEvents(request, { events: eventStore(), now: () => Date.now(), group });

export const config = { path: '/api/events' };
