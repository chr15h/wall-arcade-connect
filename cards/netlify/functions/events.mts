// POST /api/events: the arcade's tags (cards/src/events.ts), one blob each in the store "events".
import { handleEvents } from '../../src/stats-service.js';
import { eventStore } from '../../src/stats-store.js';

export default async (request: Request): Promise<Response> => handleEvents(request, { events: eventStore(), now: () => Date.now() });

export const config = { path: '/api/events' };
