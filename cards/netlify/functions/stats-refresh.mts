// Every 15 minutes: every source read again, stats.json rewritten (cards/src/stats-sources.ts).
import { refreshStats } from '../../src/stats-sources.js';
import { statsDeps } from '../../src/stats-netlify.js';

export default async (): Promise<void> => { await refreshStats(statsDeps()); };

export const config = { schedule: '*/15 * * * *' };
