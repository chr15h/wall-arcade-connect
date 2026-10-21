// Share cards: 1080 × 1080 images in the arcade's universe (concrete with the names of the wall as a watermark, ink, one
// blue, a small grey dragon cut by an edge, THE WALL ARCADE and the cabinet's address at the bottom). Pure drawing on an injected
// canvas: the card service (cards/) renders them server-side with @napi-rs/canvas and the fonts registered under the
// family names below (Anton and IBM Plex Mono, SIL OFL).
export const CARD = 1080;
const INK = '#0B0B0B', CONCRETE = '#DEDBD3', LABEL = '#6B685F', BLUE = '#2E7FD6';
const ANTON = '"WallCard Anton"', MONO = '"WallCard Mono"';
const M = 64;                                                   // outer margin

export type CardBase = {
  /** Game title shown in the header, e.g. FULL ROW. */
  game: string;
  /** The cabinet's address (https://…/), shown on the card. */
  url: string;
  /** The wall's names, for the watermark. */
  wallNames: readonly string[];
  /** The grey dragon (any loaded image). */
  dragon?: DragonImage | null;
};
/** What drawing needs from its host: a canvas factory (DOM or @napi-rs/canvas). */
export type CardEnv = { createCanvas(width: number, height: number): HTMLCanvasElement };
export type DragonImage = CanvasImageSource & { width: number; height: number };

/* ------------------------------- drawing helpers ------------------------------- */
function mono(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, col: string, align: 'left' | 'center' | 'right' = 'left', sp = 0.14, weight = 400): number {
  g.font = `${weight} ${size}px ${MONO}, "IBM Plex Mono", ui-monospace, monospace`; g.fillStyle = col; g.textBaseline = 'middle'; g.textAlign = 'left';
  const adv = size * 0.6 + size * sp, w = s.length * adv - size * sp;
  const sx = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
  for (let i = 0; i < s.length; i++) g.fillText(s[i] as string, sx + i * adv, y);
  return w;
}
const monoWidth = (len: number, size: number, sp = 0.14): number => len * (size * 0.6 + size * sp) - size * sp;
function anton(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left'): void {
  g.font = `${size}px ${ANTON}, Anton, Impact, sans-serif`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(s, x, y);
}
function antonFit(g: CanvasRenderingContext2D, s: string, maxW: number, maxSize: number): number {
  g.font = `100px ${ANTON}, Anton, Impact, sans-serif`; const w = g.measureText(s).width || 1; return Math.min(maxSize, 100 * maxW / w);
}
/** An arrow drawn with strokes (the subset fonts carry no →). */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, w: number, col: string): void {
  g.strokeStyle = col; g.lineWidth = 4; g.lineCap = 'square';
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y); g.moveTo(x + w - 14, y - 12); g.lineTo(x + w, y); g.lineTo(x + w - 14, y + 12); g.stroke();
}
export const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const hostOf = (url: string): string => { try { return new URL(url).host.toUpperCase(); } catch { return url.toUpperCase(); } };

/** The dragon in grey only (its spray can is coloured in the source): the card's one colour stays the blue. */
const greyCache = new WeakMap<object, HTMLCanvasElement>();
function greyDragon(env: CardEnv, img: DragonImage, w: number, h: number): CanvasImageSource {
  const hit = greyCache.get(img); if (hit && hit.width === w) return hit;
  const cv = env.createCanvas(w, h);
  const g = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.drawImage(img, 0, 0, w, h);
  try {
    const data = g.getImageData(0, 0, w, h), px = data.data;
    for (let i = 0; i < px.length; i += 4) { const y = 0.299 * (px[i] as number) + 0.587 * (px[i + 1] as number) + 0.114 * (px[i + 2] as number); px[i] = y; px[i + 1] = y; px[i + 2] = y; }
    g.putImageData(data, 0, 0);
  } catch { return img; }                                       // a tainted image: keep it as it is
  greyCache.set(img, cv);
  return cv;
}

/** Concrete, the watermark of names, the game's name, a small dragon cut by the right edge, and the footer: THE WALL
 *  ARCADE · the cabinet's address. Nothing else: a card shows what was played, not the arcade's fine print. */
function frame(env: CardEnv, base: CardBase, tag = ''): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = env.createCanvas(CARD, CARD);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = CONCRETE; g.fillRect(0, 0, CARD, CARD);
  if (base.wallNames.length) {
    g.font = `400 21px ${MONO}, "IBM Plex Mono", ui-monospace, monospace`; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = 'rgba(11,11,11,0.045)';
    let k = 0;
    for (let y = 26; y < CARD; y += 36) {
      let x = -((y * 7) % 140);
      while (x < CARD) { const nm = `${(base.wallNames[(k++ * 7 + y) % base.wallNames.length] as string).toUpperCase()}  ·  `; g.fillText(nm, x, y); x += g.measureText(nm).width; }
    }
  }
  const dragon = base.dragon;
  if (dragon && dragon.width) {
    const w = 300, h = Math.round(w * dragon.height / dragon.width);    // small, cut by the right edge, standing on the footer line
    g.save(); g.globalCompositeOperation = 'multiply'; g.drawImage(greyDragon(env, dragon, w, h), CARD - 200, CARD - 86 - h, w, h); g.restore();
  }
  mono(g, base.game.toUpperCase(), M, 66, 30, INK, 'left', 0.2, 500);
  if (tag) mono(g, tag, CARD - M, 66, 30, BLUE, 'right', 0.2, 500);
  g.fillStyle = INK; g.fillRect(0, 108, CARD, 2);
  g.fillRect(0, CARD - 86, CARD, 2);
  mono(g, `THE WALL ARCADE · ${hostOf(base.url)}`, M, CARD - 44, 22, INK, 'left', 0.12, 500);
  return { canvas, g };
}

/** Score, then the week's rank and the player, in the right-hand column of a card. */
function scoreBlock(g: CanvasRenderingContext2D, x: number, y: number, maxW: number, data: { score: number; rank?: number; player?: string; practice: boolean }): void {
  anton(g, fmtScore(data.score), x - 4, y, Math.min(antonFit(g, fmtScore(data.score), maxW, 150), 150), INK);
  let line = y + 64;
  if (!data.practice && data.rank) { anton(g, `#${data.rank} THIS WEEK`, x - 2, line + 30, Math.min(antonFit(g, `#${data.rank} THIS WEEK`, maxW, 58), 58), BLUE); line += 74; }
  if (data.player) {
    const p = /^0x[0-9a-f]{40}$/i.test(data.player) ? `${data.player.slice(0, 6)}…${data.player.slice(-4)}` : data.player;   // a full address, shortened
    const who = /^0x/i.test(p) ? `0x${p.slice(2).toUpperCase()}` : p.toUpperCase();
    mono(g, who, x, line + 16, Math.min(30, maxW / Math.max(1, who.length * 0.74)), INK, 'left', 0.14, 500);
  }
}

/** Names, big, one per line, from `top` down to `bottom`, left of the dragon. */
function bigNames(g: CanvasRenderingContext2D, names: string[], top: number, bottom: number, maxW: number): void {
  const list = names.length ? names.slice(0, 5) : ['—'];
  const lh = Math.min(96, (bottom - top) / list.length);
  list.forEach((name, i) => {
    const size = Math.min(antonFit(g, name, maxW, lh * 1.02), lh * 1.02);
    anton(g, name, M - 3, top + lh * (i + 1) - lh * 0.12, size, INK);
  });
}

/* ------------------------------------ cards ------------------------------------ */
export type RowCardData = {
  /** The best row's names. */
  names: string[];
  /** Where it was painted: "ROW 3" / "COL 5" (drawn in blue on the grid), when known. */
  line?: string;
  /** The final 8 × 8 grid, 8 row bytes (bit x of rows[y] = cell (x, y)), when known. */
  grid?: number[];
  score: number;
  rank?: number;
  player?: string;
  practice: boolean;
};
/** FULL ROW: the final grid with the painted row in blue, the score, the week's rank, the best row's names, the player. */
export function fullRowCard(env: CardEnv, base: CardBase, data: RowCardData): HTMLCanvasElement {
  const { canvas, g } = frame(env, base, data.practice ? 'PRACTICE' : '');
  const gx = M, gy = 152, cell = 52, size = cell * 8;
  g.fillStyle = CONCRETE; g.fillRect(gx, gy, size, size);
  const rows = data.grid && data.grid.length === 8 ? data.grid : [];
  g.fillStyle = INK;
  rows.forEach((bits, y) => { for (let x = 0; x < 8; x++) if ((bits >> x) & 1) g.fillRect(gx + x * cell, gy + y * cell, cell, cell); });
  const m = data.line ? /^(ROW|COL) ([1-8])$/.exec(data.line) : null;
  if (m) {
    const i = Number(m[2]) - 1;
    g.fillStyle = BLUE;
    if (m[1] === 'ROW') g.fillRect(gx, gy + i * cell, size, cell); else g.fillRect(gx + i * cell, gy, cell, size);
  }
  g.fillStyle = INK;
  for (let i = 0; i <= 8; i++) { g.fillRect(gx + i * cell, gy, 2, size + 2); g.fillRect(gx, gy + i * cell, size + 2, 2); }
  scoreBlock(g, gx + size + 48, gy + 120, CARD - (gx + size + 48) - M, data);
  if (data.names.length) bigNames(g, data.names, gy + size + 24, CARD - 110, 640);
  return canvas;
}

export type BounceCardData = { people: number; names: string[]; score: number; rank?: number; player?: string; practice: boolean };
/** UNBREAKABLE: the wall at the end, a brick per person the balls bounced off, their names in chalk; the score, the
 *  week's rank, the player. */
export function unbreakableCard(env: CardEnv, base: CardBase, data: BounceCardData): HTMLCanvasElement {
  const { canvas, g } = frame(env, base, data.practice ? 'PRACTICE' : '');
  const head = `I BOUNCED OFF ${data.people} ${data.people === 1 ? 'PERSON' : 'PEOPLE'}`;
  anton(g, head, M - 3, 236, Math.min(antonFit(g, head, CARD - 2 * M, 104), 104), INK);
  // the wall: staggered courses of solid bricks (the dragon stands behind it), the names painted in chalk on ink
  const bw = 232, bh = 64, gap = 8, top = 296, right = CARD - M;
  const courses = Math.max(2, Math.min(5, Math.ceil(data.names.length / 4) + 1));   // as high as the names need
  let k = 0;
  for (let r = 0; r < courses; r++) {
    const y = top + r * (bh + gap);
    for (let x = M - (r % 2 ? (bw + gap) / 2 : 0); x < right; x += bw + gap) {
      const l = Math.max(M, x), w = Math.min(right, x + bw) - l;
      const name = w > bw * 0.6 ? data.names[k] : undefined;
      g.fillStyle = name ? INK : CONCRETE; g.fillRect(l, y, w, bh);
      g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(l + 1, y + 1, w - 2, bh - 2);
      if (!name) continue;
      let t = name; const room = w - 24;
      while (t.length > 3 && monoWidth(t.length, 24, 0.06) > room) t = `${t.slice(0, -2)}…`;
      mono(g, t, l + w / 2, y + bh / 2 + 1, 24, '#F2F0EB', 'center', 0.06, 500);
      k++;
    }
  }
  scoreBlock(g, M, top + courses * (bh + gap) + 150, 600, data);
  return canvas;
}

export type BoardRow = { rank: number; name: string; score: number; me?: boolean };
/** A game's leaderboard: the top 5, the player's line in blue (added under the five when it is lower), their rank. */
export function boardCard(env: CardEnv, base: CardBase, data: { rows: BoardRow[]; caption: string }): HTMLCanvasElement {
  const me = data.rows.find((row) => row.me);
  const { canvas, g } = frame(env, base);
  mono(g, data.caption, M, 150, 24, LABEL, 'left', 0.2, 500);
  const title = 'TOP 5';
  anton(g, title, M - 4, 286, Math.min(antonFit(g, title, CARD - 2 * M, 130), 130), INK);
  const top5 = data.rows.filter((row) => row.rank <= 5).slice(0, 5);
  const list = me && me.rank > 5 ? [...top5, me] : top5;
  const rh = 72;
  // the table sits on solid concrete: the dragon is cut by it, and no score ever lands on the drawing
  g.fillStyle = CONCRETE; g.fillRect(M - 16, 332, CARD - 2 * M + 32, list.length * rh + (me && me.rank > 5 ? 30 : 8));
  list.forEach((row, i) => {
    const y = 340 + i * rh + (me && row === me && me.rank > 5 ? 22 : 0);
    if (row.me) { g.fillStyle = BLUE; g.fillRect(M - 16, y, CARD - 2 * M + 32, rh - 8); }
    else { g.fillStyle = INK; g.fillRect(M, y + rh - 5, CARD - 2 * M, 1); }
    const mid = y + (rh - 8) / 2 + 2;
    mono(g, `#${row.rank}`, M, mid, 26, INK, 'left', 0.1, 500);
    let name = /^0x/i.test(row.name) ? `0x${row.name.slice(2).toUpperCase()}` : row.name.toUpperCase(); const room = 560;
    while (name.length > 4 && monoWidth(name.length, 30, 0.08) > room) name = `${name.slice(0, -2)}…`;
    mono(g, name, M + 96, mid, 30, INK, 'left', 0.08, 500);
    anton(g, fmtScore(row.score), CARD - M, mid + 22, 58, INK, 'right');
  });
  if (!list.length) mono(g, 'NO SCORE YET THIS WEEK', M, 400, 28, INK, 'left', 0.14, 500);
  if (me) {                                                   // the board is THIS WEEK's (src/shell/week.ts)
    const line = `#${me.rank} ON ${base.game.toUpperCase()} THIS WEEK`;
    anton(g, line, M - 4, 846, Math.min(antonFit(g, line, 600, 84), 84), INK);
  }
  return canvas;
}


/**
 * The link preview for X (summary_large_image shows a 1.91:1 crop): the whole square card, scaled to the preview's
 * height and centred on the same concrete and watermark, so nothing of it is cut.
 */
export const PREVIEW_W = 1200, PREVIEW_H = 630;
export function xPreview(env: CardEnv, card: HTMLCanvasElement, wallNames: readonly string[]): HTMLCanvasElement {
  const canvas = env.createCanvas(PREVIEW_W, PREVIEW_H);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = CONCRETE; g.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  void wallNames;                                               // plain concrete around the card: one watermark, the card's
  const s = PREVIEW_H, x0 = (PREVIEW_W - s) / 2;
  g.drawImage(card, x0, 0, s, s);
  g.fillStyle = INK; g.fillRect(x0 - 1, 0, 1, s); g.fillRect(x0 + s, 0, 1, s);
  return canvas;
}
