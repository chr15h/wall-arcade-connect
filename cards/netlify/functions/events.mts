// POST /api/events: the arcade's tags (cards/src/events.ts), one blob each in the store "events".
import { handleEvents } from '../../src/stats-service.js';
import { eventStore, statsStore } from '../../src/stats-store.js';
import { groupOrigins } from '../../src/origins.js';

const origins = groupOrigins(statsStore());               // the credit group's apps and ours (cards/src/origins.ts)
export default async (request: Request): Promise<Response> => handleEvents(request, { events: eventStore(), now: () => Date.now(), origins });

export const config = { path: '/api/events' };
