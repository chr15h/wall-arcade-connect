// The stats' sources on this site: Netlify Blobs, fetch, the jackpot, and the usage report's token (RARE_PROFILE_TOKEN,
// a Netlify environment variable, never in the repository).
import { peopleStore } from './people-store.js';
import { treasuryBalance } from './pot.js';
import { potStore } from './pot-store.js';
import { eventStore, statsStore } from './stats-store.js';
import type { StatsDeps } from './stats-sources.js';

export const statsDeps = (): StatsDeps => ({
  fetch, now: () => Date.now(), token: process.env.RARE_PROFILE_TOKEN || undefined,
  events: eventStore(), people: peopleStore(), store: statsStore(),
  pot: { store: potStore(), balance: () => treasuryBalance() },
});
