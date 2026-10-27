// GET /stats and /stats.json (cards/src/stats-service.ts): the arcade's numbers, from stats.json (refreshed every 15 minutes).
import { handleStats } from '../../src/stats-service.js';
import { statsDeps } from '../../src/stats-netlify.js';

export default async (request: Request): Promise<Response> => handleStats(request, statsDeps());

export const config = { path: ['/stats', '/stats.json'] };
