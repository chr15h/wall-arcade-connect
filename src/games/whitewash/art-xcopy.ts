// NFT INVADERS' line-up: works by XCOPY, used under CC0 (a fan-made game: not made, endorsed by or affiliated with XCOPY;
// the page says so wherever it names him). One series per wave; see art/README.md.
import griftersData from './art/grifters.json' with { type: 'json' };
import xcopyData from './art/xcopy.json' with { type: 'json' };
import { createArt, type Collection, type Work } from './art.js';

const BY = 'CC0 ART BY XCOPY · NOT AFFILIATED';
const series = (xcopyData as { waves: { key: string; title: string; items: Work[] }[] }).waves;
/** One XCOPY series as a wave (the mixed line-up, art-cc0.ts, borrows some). */
export const xcopyWave = (key: string): Collection => {
  if (key === 'grifters') return { key, title: 'GRIFTERS', by: BY, items: (griftersData as { items: Work[] }).items, glitch: true };
  const s = series.find((w) => w.key === key);
  return { key, title: s?.title ?? key.toUpperCase(), by: BY, items: s?.items ?? [], glitch: true };
};
const wave = xcopyWave;
/** The all-XCOPY line-up (NFT INVADERS' first release). */
export const XCOPY_ART = createArt([
  wave('max-pain'),
  wave('grifters'),
  wave('traitors'),
  wave('superrare-2019'),
  wave('fresh-hell'),
  wave('superrare'),
  wave('early'),
]);
