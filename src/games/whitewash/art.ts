// NFT INVADERS' raiders: works by XCOPY, used under CC0 (a fan-made game: not made, endorsed by or affiliated with XCOPY;
// the page says so wherever it names him). Display only (the engine and the verifier never see the art). Each wave
// brings one series, in turn; which work a raider wears is a pure function of the run's seed and the raider's id, so a
// replay shows the same faces. Sources and the CC0 statement: art/README.md.
import { fnv1a } from '../../common/det.js';
import griftersData from './art/grifters.json' with { type: 'json' };
import xcopyData from './art/xcopy.json' with { type: 'json' };

/** A work: its picture, and whether its black ground was cut away (a free figure) or it keeps a round frame. */
type Work = { src: string; cut?: boolean };
export type Collection = { key: string; title: string; by: string; items: readonly Work[] };
const series = (xcopyData as { waves: { key: string; title: string; years: string; items: Work[] }[] }).waves;
const wave = (key: string): Collection => {
  const s = series.find((w) => w.key === key);
  return { key, title: s?.title ?? key.toUpperCase(), by: 'CC0 ART BY XCOPY · NOT AFFILIATED', items: s?.items ?? [] };
};
/** The rotation, one series per wave. */
export const COLLECTIONS: readonly Collection[] = [
  wave('max-pain'),
  { key: 'grifters', title: 'GRIFTERS', by: 'CC0 ART BY XCOPY · NOT AFFILIATED', items: (griftersData as { items: Work[] }).items },
  wave('traitors'),
  wave('superrare-2019'),
  wave('fresh-hell'),
  wave('superrare'),
  wave('early'),
].filter((c) => c.items.length > 0);
/** The series a wave (1-based) is drawn from: they take turns. */
export const collectionOfWave = (n: number): Collection => COLLECTIONS[(Math.max(1, n) - 1) % COLLECTIONS.length] as Collection;

// Small reductions of the works, embedded so the game needs no network for them.
const pictures = new Map<string, HTMLImageElement>();
let onLoad: () => void = () => undefined;
/** Called when a picture is ready (the stage redraws). */
export const onArt = (f: () => void): void => { onLoad = f; };
function picture(work: Work): HTMLImageElement | null {
  let img = pictures.get(work.src);
  if (!img) { img = new Image(); img.onload = () => onLoad(); img.src = work.src; pictures.set(work.src, img); }
  return img.complete && img.naturalWidth ? img : null;
}
/** A cut-out figure's ink silhouette (its sticker outline), made once per picture. */
const silhouettes = new Map<string, HTMLCanvasElement>();
function silhouette(work: Work, img: HTMLImageElement): HTMLCanvasElement {
  let cv = silhouettes.get(work.src);
  if (!cv) {
    cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#0B0B0B'; g.fillRect(0, 0, cv.width, cv.height);
    silhouettes.set(work.src, cv);
  }
  return cv;
}
const RING: readonly (readonly [number, number])[] = [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]];

/** Draws raider `id` of wave `n` (seed `seed`) centred on (x, y), `size` px, leaning by `tilt` radians, with XCOPY's
 *  flicker (now and then a frame slips sideways): a cut-out figure as an ink-outlined sticker, any other work round. */
export function drawRaider(g: CanvasRenderingContext2D, seed: number, n: number, id: number, x: number, y: number, size: number, tilt: number, now: number): void {
  const key = fnv1a(`raider:${seed}:${id}`), c = collectionOfWave(n), work = c.items[key % Math.max(1, c.items.length)];
  if (!work) return;
  const img = picture(work), r = size / 2 - 1;
  const glitch = ((now / 90 + (key % 97)) | 0) % 23 === 0 ? 3 : 0;
  g.save(); g.translate(x, y); g.rotate(tilt);
  if (work.cut && img) {
    const s = size * 1.1, smooth = g.imageSmoothingEnabled;                   // a free figure reads a little larger
    g.imageSmoothingEnabled = true;
    const ink = silhouette(work, img);
    for (const [dx, dy] of RING) g.drawImage(ink, -s / 2 + dx + glitch, -s / 2 + dy, s, s);
    g.drawImage(img, -s / 2 + glitch, -s / 2, s, s);
    g.imageSmoothingEnabled = smooth;
    g.restore();
    return;
  }
  g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.closePath();
  g.fillStyle = '#0B0B0B'; g.fill();
  if (img) {
    g.save(); g.clip();
    const smooth = g.imageSmoothingEnabled; g.imageSmoothingEnabled = true;
    g.drawImage(img, -r - 2 + glitch, -r - 2, 2 * r + 4, 2 * r + 4);
    g.imageSmoothingEnabled = smooth;
    g.restore();
  }
  g.strokeStyle = '#0B0B0B'; g.lineWidth = 2; g.stroke();
  g.restore();
}
