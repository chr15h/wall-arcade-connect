// The mixed CC0 line-up (NFT INVADERS since its second release): one collection per wave, in turn, Nouns (drawn on the
// fly from the on-chain artwork), MAX PAIN AND FRENS, CrypToadz, TRAITORS, mfers, EARLY WORKS (XCOPY's three from
// art-xcopy.ts). A fan-made game, affiliated with none of them. See art/README.md.
import nounsData from './art/nouns-image-data.json' with { type: 'json' };
import cryptoadzData from './art/cryptoadz.json' with { type: 'json' };
import mfersData from './art/mfers.json' with { type: 'json' };
import { createArt, type Work } from './art.js';
import { xcopyWave } from './art-xcopy.js';

/* Nouns: a part is the on-chain run-length encoding of the Nouns descriptor: a palette byte, the bounds (top, right,
   bottom, left; right exclusive, bottom inclusive) of a 32 × 32 image, then (length, colour index) runs filling the box
   row by row; colour 0 is transparent. */
type Part = { filename: string; data: string };
const { palette, images } = nounsData as { palette: string[]; images: Record<'bodies' | 'accessories' | 'heads' | 'glasses', Part[]> };
function paintPart(px: Uint8ClampedArray, hex: string): void {
  const b: number[] = [];
  for (let i = 2; i < hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16));
  const top = b[1] as number, right = b[2] as number, left = b[4] as number;
  let x = left, y = top;
  for (let i = 5; i + 1 < b.length; i += 2) {
    const len = b[i] as number, colour = palette[b[i + 1] as number] ?? '';
    for (let k = 0; k < len; k++) {
      if (colour && x < 32 && y < 32) {
        const o = (y * 32 + x) * 4;
        px[o] = parseInt(colour.slice(0, 2), 16); px[o + 1] = parseInt(colour.slice(2, 4), 16); px[o + 2] = parseInt(colour.slice(4, 6), 16); px[o + 3] = 255;
      }
      if (++x >= right) { x = left; y++; }
    }
  }
}
const nouns = new Map<number, HTMLCanvasElement>();
/** A Noun as a 32 × 32 canvas, its traits picked from `key` (body, accessory, head, glasses, in that layer order). */
function noun(key: number): HTMLCanvasElement {
  let cv = nouns.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
  const g = cv.getContext('2d') as CanvasRenderingContext2D, img = g.createImageData(32, 32);
  let h = key;
  for (const kind of ['bodies', 'accessories', 'heads', 'glasses'] as const) {
    const list = images[kind];
    paintPart(img.data, (list[h % list.length] as Part).data);
    h = Math.floor(h / list.length) ^ (h >>> 7);
  }
  g.putImageData(img, 0, 0);
  if (nouns.size > 200) nouns.clear();
  nouns.set(key, cv);
  return cv;
}

type Set = { pixel: boolean; items: Work[] };
export const CC0_ART = createArt([
  { key: 'nouns', title: 'NOUNS', by: 'CC0 ART · NOUNS DAO · NOT AFFILIATED', figure: noun },
  xcopyWave('max-pain'),
  { key: 'cryptoadz', title: 'CRYPTOADZ', by: 'CC0 ART BY GREMPLIN · NOT AFFILIATED', items: (cryptoadzData as Set).items, pixel: true },
  xcopyWave('traitors'),
  { key: 'mfers', title: 'MFERS', by: 'CC0 ART BY SARTOSHI · NOT AFFILIATED', items: (mfersData as Set).items },
  xcopyWave('early'),
]);
