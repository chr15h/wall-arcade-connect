// The invaders' art, display only (the engine and the verifier never see it): a line-up of collections, one per wave in
// turn. Which work a raider wears is a pure function of the run's seed and the raider's id, so a replay shows the same
// faces. A work whose ground was cut away (scripts/cutout.ts) is drawn free, as an ink-outlined sticker; any other work in
// a round frame. Each game builds its own line-up (art-xcopy.ts, art-cc0.ts), so a game ships only its own art.
import { fnv1a } from '../../common/det.js';

/** A work: its picture, and whether its ground was cut away (a free figure) or it keeps a round frame. */
export type Work = { src: string; cut?: boolean };
export type Collection = {
  key: string; title: string;
  /** The credit under a wave's title in its announcement. */
  by: string;
  /** Pictures, drawn smooth (or sharp, for pixel art)… */
  items?: readonly Work[]; pixel?: boolean;
  /** …or a figure drawn on the fly (a Noun from its on-chain traits), always free and sharp. */
  figure?: (key: number) => HTMLCanvasElement;
  /** XCOPY's flicker: now and then a frame slips sideways. */
  glitch?: boolean;
};
export type Art = {
  /** The collection a wave (1-based) is drawn from: they take turns. */
  collectionOfWave(wave: number): Collection;
  /** Draws raider `id` of wave `wave` (seed `seed`) centred on (x, y), `size` px, leaning by `tilt` radians. */
  drawRaider(g: CanvasRenderingContext2D, seed: number, wave: number, id: number, x: number, y: number, size: number, tilt: number, now: number): void;
};

// Small reductions of the works, embedded so the game needs no network for them.
const pictures = new Map<string, HTMLImageElement>();
let onLoad: () => void = () => undefined;
/** Called when a picture is ready (the stage redraws). */
export const onArt = (f: () => void): void => { onLoad = f; };
function picture(src: string): HTMLImageElement | null {
  let img = pictures.get(src);
  if (!img) { img = new Image(); img.onload = () => onLoad(); img.src = src; pictures.set(src, img); }
  return img.complete && img.naturalWidth ? img : null;
}
/** A free figure's ink silhouette (its sticker outline), made once per picture. */
const silhouettes = new WeakMap<CanvasImageSource, HTMLCanvasElement>();
function silhouette(img: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  let cv = silhouettes.get(img);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = img instanceof HTMLImageElement ? img.naturalWidth : img.width; cv.height = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    const g = cv.getContext('2d') as CanvasRenderingContext2D;
    g.drawImage(img, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#0B0B0B'; g.fillRect(0, 0, cv.width, cv.height);
    silhouettes.set(img, cv);
  }
  return cv;
}
const RING: readonly (readonly [number, number])[] = [[-2, 0], [2, 0], [0, -2], [0, 2], [-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]];

/** A game's line-up. */
export function createArt(collections: readonly Collection[]): Art {
  const lineUp = collections.filter((c) => c.figure || (c.items && c.items.length > 0));
  const collectionOfWave = (wave: number): Collection => lineUp[(Math.max(1, wave) - 1) % lineUp.length] as Collection;
  function drawRaider(g: CanvasRenderingContext2D, seed: number, wave: number, id: number, x: number, y: number, size: number, tilt: number, now: number): void {
    const key = fnv1a(`raider:${seed}:${id}`), c = collectionOfWave(wave);
    let img: HTMLImageElement | HTMLCanvasElement | null = null, cut = false, sharp = false;
    if (c.figure) { img = c.figure(key); cut = true; sharp = true; }
    else {
      const work = c.items?.[key % Math.max(1, c.items.length)];
      if (!work) return;
      img = picture(work.src); cut = Boolean(work.cut); sharp = Boolean(c.pixel);
    }
    const r = size / 2 - 1, glitch = c.glitch && ((now / 90 + (key % 97)) | 0) % 23 === 0 ? 3 : 0, smooth = g.imageSmoothingEnabled;
    g.save(); g.translate(x, y); g.rotate(tilt);
    if (cut && img) {                                                       // a free figure, a little larger, outlined in ink
      const s = size * 1.1, ink = silhouette(img);
      g.imageSmoothingEnabled = !sharp;
      for (const [dx, dy] of RING) g.drawImage(ink, -s / 2 + dx + glitch, -s / 2 + dy, s, s);
      g.drawImage(img, -s / 2 + glitch, -s / 2, s, s);
    } else {                                                                // a round frame
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.closePath();
      g.fillStyle = '#0B0B0B'; g.fill();
      if (img) { g.save(); g.clip(); g.imageSmoothingEnabled = !sharp; g.drawImage(img, -r - 2 + glitch, -r - 2, 2 * r + 4, 2 * r + 4); g.restore(); }
      g.strokeStyle = '#0B0B0B'; g.lineWidth = 2; g.stroke();
    }
    g.imageSmoothingEnabled = smooth;
    g.restore();
  }
  return { collectionOfWave, drawRaider };
}
