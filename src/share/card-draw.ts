// Share cards: 1080 × 1080 images in the arcade's universe (concrete with the names of the wall as a watermark, ink, one
// blue, the grey dragon cut by an edge, the required credit line, the cabinet's address). Pure drawing on an injected
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
  g.font = `${weight} ${size}px ${MONO}, ui-monospace, monospace`; g.fillStyle = col; g.textBaseline = 'middle'; g.textAlign = 'left';
  const adv = size * 0.6 + size * sp, w = s.length * adv - size * sp;
  const sx = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
  for (let i = 0; i < s.length; i++) g.fillText(s[i] as string, sx + i * adv, y);
  return w;
}
const monoWidth = (len: number, size: number, sp = 0.14): number => len * (size * 0.6 + size * sp) - size * sp;
function anton(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left'): void {
  g.font = `${size}px ${ANTON}, Impact, sans-serif`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(s, x, y);
}
function antonFit(g: CanvasRenderingContext2D, s: string, maxW: number, maxSize: number): number {
  g.font = `100px ${ANTON}, Impact, sans-serif`; const w = g.measureText(s).width || 1; return Math.min(maxSize, 100 * maxW / w);
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

/** Concrete, the watermark of names, the header, the dragon cut by the right and bottom edges, the footer. */
function frame(env: CardEnv, base: CardBase, blueAddress: boolean): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = env.createCanvas(CARD, CARD);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = CONCRETE; g.fillRect(0, 0, CARD, CARD);
  if (base.wallNames.length) {
    g.font = `400 21px ${MONO}, ui-monospace, monospace`; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = 'rgba(11,11,11,0.045)';
    let k = 0;
    for (let y = 26; y < CARD; y += 36) {
      let x = -((y * 7) % 140);
      while (x < CARD) { const nm = `${(base.wallNames[(k++ * 7 + y) % base.wallNames.length] as string).toUpperCase()}  ·  `; g.fillText(nm, x, y); x += g.measureText(nm).width; }
    }
  }
  const dragon = base.dragon;
  if (dragon && dragon.width) {
    const w = 660, h = Math.round(w * dragon.height / dragon.width);   // cut by the right and the bottom edges
    g.save(); g.globalCompositeOperation = 'multiply'; g.drawImage(greyDragon(env, dragon, w, h), CARD - 430, CARD - h * 0.7, w, h); g.restore();
  }
  mono(g, 'THE WALL ARCADE', M, 62, 24, INK, 'left', 0.2, 500);
  mono(g, base.game.toUpperCase(), CARD - M, 62, 24, INK, 'right', 0.2, 500);
  g.fillStyle = INK; g.fillRect(0, 100, CARD, 2);
  // the cabinet's address, a block (blue when it is the card's one accent), then the credit line
  const host = hostOf(base.url), size = 27, tw = monoWidth(host.length, size, 0.1);
  const bx = M, by = CARD - 196, bh = 68, bw = tw + 120;
  g.fillStyle = blueAddress ? BLUE : INK; g.fillRect(bx, by, bw, bh);
  const fg = blueAddress ? INK : CONCRETE;
  mono(g, host, bx + 24, by + bh / 2 + 1, size, fg, 'left', 0.1, 500);
  arrow(g, bx + bw - 68, by + bh / 2, 44, fg);
  mono(g, 'A REMIX THE WALL EXPERIMENT', M, CARD - 92, 20, INK, 'left', 0.16, 500);
  mono(g, 'NFC SUMMIT 2027 · LISBON', M, CARD - 62, 20, INK, 'left', 0.16, 500);
  return { canvas, g };
}

/* ------------------------------------ cards ------------------------------------ */
/** FULL ROW, end of a run: the names of the best row, big; painted together by the player; the score. */
export function fullRowCard(env: CardEnv, base: CardBase, data: { label: string; names: string[]; player: string; score: number; practice: boolean }): HTMLCanvasElement {
  const { canvas, g } = frame(env, base, true);
  mono(g, data.label, M, 150, 24, LABEL, 'left', 0.2, 500);
  const names = data.names.length ? data.names : ['—'];
  const top = 186, bottom = 640, lh = Math.min(150, (bottom - top) / names.length);
  names.forEach((name, i) => {
    const size = Math.min(antonFit(g, name, CARD - 2 * M, lh * 1.05), lh * 1.08);
    anton(g, name, M - 4, top + lh * (i + 1) - lh * 0.1, size, INK);
  });
  if (data.player) {
    const by = `PAINTED TOGETHER BY ${/^0x/i.test(data.player) ? `0x${data.player.slice(2).toUpperCase()}` : data.player.toUpperCase()}`;
    mono(g, by, M, 686, Math.min(28, (CARD - 2 * M) / (by.length * 0.74)), INK, 'left', 0.14, 500);
  }
  mono(g, data.practice ? 'PRACTICE SCORE · NOT RECORDED' : 'SCORE', M, 744, 20, LABEL, 'left', 0.2, 500);
  anton(g, fmtScore(data.score), M - 4, 850, 104, INK);
  return canvas;
}

/** UNBREAKABLE, end of a run: how many people of the wall the balls bounced off, their names, the score. */
export function unbreakableCard(env: CardEnv, base: CardBase, data: { people: number; names: string[]; score: number; practice: boolean }): HTMLCanvasElement {
  const { canvas, g } = frame(env, base, true);
  mono(g, data.practice ? 'PRACTICE · NOT RECORDED' : 'A RUN ON UNBREAKABLE', M, 150, 24, LABEL, 'left', 0.2, 500);
  const lines = ['I BOUNCED OFF', `${data.people} ${data.people === 1 ? 'PERSON' : 'PEOPLE'}`, 'OF THE WALL'];
  lines.forEach((line, i) => anton(g, line, M - 4, 290 + i * 118, Math.min(antonFit(g, line, CARD - 2 * M, 136), 136), INK));
  // the names, flowing, " · " between them
  const size = 23, adv = size * 0.6 + size * 0.1, maxW = 590;     // left of the dragon
  let x = M, y = 588, line = 0, shown = 0;
  for (const name of data.names) {
    const piece = (shown ? ' · ' : '') + name, w = piece.length * adv;
    if (x + w > M + maxW) { if (++line >= 3) break; x = M; y += 36; mono(g, name, x, y, size, INK, 'left', 0.1, 500); x += name.length * adv; shown++; continue; }
    mono(g, piece, x, y, size, INK, 'left', 0.1, 500); x += w; shown++;
  }
  if (shown < data.names.length) mono(g, `+ ${data.names.length - shown} MORE`, M, y + 36, 20, LABEL, 'left', 0.16, 500);
  mono(g, 'SCORE', M, 768, 20, LABEL, 'left', 0.2, 500);
  anton(g, fmtScore(data.score), M - 4, 858, 96, INK);
  return canvas;
}

export type BoardRow = { rank: number; name: string; score: number; me?: boolean };
/** A game's leaderboard: the top 5, the player's line in blue (added under the five when it is lower), their rank. */
export function boardCard(env: CardEnv, base: CardBase, data: { rows: BoardRow[]; caption: string }): HTMLCanvasElement {
  const me = data.rows.find((row) => row.me);
  const { canvas, g } = frame(env, base, !me);
  mono(g, data.caption, M, 150, 24, LABEL, 'left', 0.2, 500);
  const title = `TOP 5 · ${base.game.toUpperCase()}`;
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
  if (!list.length) mono(g, 'NO SERVER-VERIFIED SCORE YET', M, 400, 28, INK, 'left', 0.14, 500);
  if (me) anton(g, `#${me.rank} ON ${base.game.toUpperCase()}`, M - 4, 846, Math.min(antonFit(g, `#${me.rank} ON ${base.game.toUpperCase()}`, 600, 84), 84), INK);
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
