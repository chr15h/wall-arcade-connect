// Cuts the black ground away from a small picture (RGBA pixels), the way a paint bucket would: only the near-black pixels
// connected to the picture's edge go, so the blacks enclosed in a figure (its eyes, its outlines) stay. Grain left
// floating in the cleared ground (XCOPY's noise) is then cleared too: a pixel that the cleared ground mostly surrounds
// goes, twice over. Returns the share of the picture made transparent (a picture on another ground loses almost none).
export function cutBlackGround(px: Uint8ClampedArray, w: number, h: number, threshold = 34): number {
  const dark = (i: number): boolean => 0.299 * (px[i * 4] as number) + 0.587 * (px[i * 4 + 1] as number) + 0.114 * (px[i * 4 + 2] as number) < threshold;
  const ground = new Uint8Array(w * h), queue: number[] = [];
  const seed = (i: number): void => { if (!ground[i] && dark(i)) { ground[i] = 1; queue.push(i); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (queue.length) {
    const i = queue.pop() as number, x = i % w, y = (i - x) / w;
    if (x > 0) seed(i - 1); if (x < w - 1) seed(i + 1); if (y > 0) seed(i - w); if (y < h - 1) seed(i + w);
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = ground.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ground[i]) continue;
      let around = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        n++; if (xx < 0 || yy < 0 || xx >= w || yy >= h || ground[yy * w + xx]) around++;
      }
      if (around >= 6) next[i] = 1;
    }
    ground.set(next);
  }
  let cut = 0;
  for (let i = 0; i < w * h; i++) if (ground[i]) { px[i * 4 + 3] = 0; cut++; }
  return cut / (w * h);
}

/** The share of the kept (opaque) pixels that belong to the largest 8-connected piece: near 1 for one figure, low when
 *  the cut left confetti (a glitch work with no single figure). */
export function largestPieceShare(px: Uint8ClampedArray, w: number, h: number): number {
  const seen = new Uint8Array(w * h);
  let kept = 0, best = 0;
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || (px[s * 4 + 3] as number) === 0) continue;
    let size = 0; const stack = [s]; seen[s] = 1;
    while (stack.length) {
      const i = stack.pop() as number, x = i % w, y = (i - x) / w; size++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && !seen[j] && (px[j * 4 + 3] as number) > 0) { seen[j] = 1; stack.push(j); }
      }
    }
    kept += size; best = Math.max(best, size);
  }
  return kept ? best / kept : 0;
}
/** How the kept figure sits: the share of the picture's edge it still covers (a scene runs along the edges, a figure
 *  does not), and how much of its convex outline it fills (a head ≈ 0.85; a crescent left by a cut face far less). */
export function figureShape(px: Uint8ClampedArray, w: number, h: number): { edge: number; solidity: number } {
  const opaque = (x: number, y: number): boolean => (px[(y * w + x) * 4 + 3] as number) > 0;
  let edge = 0;
  for (let i = 0; i < w; i++) { if (opaque(i, 0)) edge++; if (opaque(i, h - 1)) edge++; }
  for (let i = 1; i < h - 1; i++) { if (opaque(0, i)) edge++; if (opaque(w - 1, i)) edge++; }
  // convex hull (monotone chain) of the opaque pixels' extreme points per row
  const pts: [number, number][] = [];
  let kept = 0;
  for (let y = 0; y < h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) if (opaque(x, y)) { kept++; if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) { pts.push([lo, y], [lo, y + 1], [hi + 1, y], [hi + 1, y + 1]); }
  }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of list) { while (out.length >= 2 && cross(out[out.length - 2] as [number, number], out[out.length - 1] as [number, number], p) <= 0) out.pop(); out.push(p); }
    out.pop(); return out;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  let area = 0;
  for (let i = 0; i < hull.length; i++) { const p = hull[i] as [number, number], q = hull[(i + 1) % hull.length] as [number, number]; area += p[0] * q[1] - q[0] * p[1]; }
  return { edge: edge / (2 * w + 2 * h - 4), solidity: area ? kept / (Math.abs(area) / 2) : 0 };
}
/** A work is shown cut out when the black ground took 30–85 % of it, what is left is one figure (90 % in one piece),
 *  mostly clear of the edges (at most 24 % of them) and solid (it fills 70 % of its convex outline); otherwise it is
 *  framed. Tuned on the 74 works of the game: every Grifter and the Max Pain heads pass, no scene or glitch work does. */
export const looksCutOut = (cut: number, piece: number, shape: { edge: number; solidity: number }): boolean =>
  cut >= 0.3 && cut <= 0.85 && piece >= 0.9 && shape.edge <= 0.24 && shape.solidity >= 0.7;

/** Reduces `img` (its centre square) to `size` px and cuts its black ground when that leaves a clean figure. */
export async function reduceWork(img: { width: number; height: number }, size: number, smooth: boolean,
  canvasFor: (w: number, h: number) => { getContext(kind: '2d'): any; encode(format: 'webp', quality: number): Promise<Buffer> }): Promise<{ data: Buffer; cut: boolean }> {
  const canvas = canvasFor(size, size), g = canvas.getContext('2d');
  g.imageSmoothingEnabled = smooth;
  const s = Math.min(img.width, img.height);
  g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  const pixels = g.getImageData(0, 0, size, size);
  const cutShare = cutBlackGround(pixels.data, size, size);
  const cut = looksCutOut(cutShare, largestPieceShare(pixels.data, size, size), figureShape(pixels.data, size, size));
  if (cut) g.putImageData(pixels, 0, 0);
  return { data: await canvas.encode('webp', 85), cut };
}
