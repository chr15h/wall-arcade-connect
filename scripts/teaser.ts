// THE WALL ARCADE teaser, 16 bits: a pixel world at 480 × 270, drawn in the 8 tones of NFC (comms/teaser/palette.json) into an
// indexed frame buffer, scaled 4× nearest-neighbour (crisp pixels, never smoothed). Every text, the gameplay order and
// sources, the names on the plaques come from comms/teaser/teaser.config.json; the names are the wall's snapshot
// (src/generated/wall.json). Fonts: Press Start 2P and Silkscreen (SIL OFL, comms/teaser/assets), rendered then
// thresholded so every glyph pixel is a whole pixel. No generated imagery, nothing from an existing game.
//
//   node --import tsx scripts/teaser.ts stills [--out comms/teaser/out]     the board of six stills (title, 4 scenes, end)
//
// Every movement is a whole number of pixels per frame (30 fps); the stills are frames of the same functions.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import snapshot from '../src/generated/wall.json' with { type: 'json' };

const root = new URL('../', import.meta.url);
const argv = process.argv.slice(2);
const arg = (name: string, fallback = ''): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const OUT = arg('out', 'comms/teaser/out');

/* ------------------------------- palette, config ------------------------------ */
const paletteJson = JSON.parse(await readFile(new URL(arg('palette', 'comms/teaser/palette.json'), root), 'utf8')) as Record<string, string>;
const NAMES = ['ink', 'darkGrey', 'midGrey', 'stone', 'concrete', 'chalk', 'blue', 'blueLight'] as const;
type Colour = typeof NAMES[number];
const C = Object.fromEntries(NAMES.map((n, i) => [n, i])) as Record<Colour, number>;
const RGB = NAMES.map((n) => {
  const hex = paletteJson[n]; if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`palette: ${n} missing`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const;
});
type Sequence = { scene: 'wall' | 'row' | 'chest' | 'yourgame'; line: string; gameplay: { label: string; source: string } };
type Config = {
  title: [string, string]; hudNames: number | null; plaques: { start: number; skip?: string[] }; row: { start: number };
  sequences: Sequence[]; end: { line: string; url: string; credit: string }; yourGame: string;
  typing: { cps: number; readable: number; start: number };
};
const CFG = JSON.parse(await readFile(new URL(arg('config', 'comms/teaser/teaser.config.json'), root), 'utf8')) as Config;

/* ------------------------------------ wall ------------------------------------ */
type Panel = { p: number; n: string };
const PANELS = new Map<number, Panel>((snapshot.positions as Panel[]).map((panel) => [panel.p, panel]));
const nameAt = (pos: number): string => PANELS.get(pos)?.n.toUpperCase() ?? '';
/** The HUD's count of names: live from the wall's backend when it answers within 4 s, else the configured count, else the snapshot's. */
async function liveCount(): Promise<number | null> {
  try {
    const res = await fetch('https://otw-arcade.netlify.app/positions', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const raw = await res.json() as { minted?: boolean; name?: string }[] | { positions: { minted?: boolean; name?: string }[] };
    const items = Array.isArray(raw) ? raw : raw.positions;
    const n = items.filter((item) => item.minted && typeof item.name === 'string' && item.name.length > 0).length;
    return n > 0 ? n : null;
  } catch { return null; }
}
const LIVE = argv.includes('--offline') ? null : await liveCount();
const HUD_COUNT = LIVE ?? CFG.hudNames ?? snapshot.count;
console.log(`HUD: ${HUD_COUNT} NAMES (${LIVE !== null ? 'live' : CFG.hudNames !== null ? 'config' : 'snapshot'})`);
/** The named panels in wall order: the plaques of the long wall carry them one after another (no blank plaque). */
const SKIP = new Set((CFG.plaques.skip ?? []).map((n) => n.toUpperCase()));
const NAMED = (snapshot.positions as Panel[]).map((panel) => panel.n.toUpperCase()).filter((n) => !SKIP.has(n));
const namedAt = (k: number): string => NAMED[((k % NAMED.length) + NAMED.length) % NAMED.length] as string;

/* ------------------------------------ fonts ----------------------------------- */
GlobalFonts.register(await readFile(new URL('comms/teaser/assets/PressStart2P-400.ttf', root)), 'Teaser PS2P');
GlobalFonts.register(await readFile(new URL('comms/teaser/assets/Silkscreen-400.ttf', root)), 'Teaser Silk');
type Font = 'big' | 'small';
const FONT: Record<Font, string> = { big: '8px "Teaser PS2P"', small: '8px "Teaser Silk"' };
type Mask = { w: number; h: number; bits: Uint8Array };
const maskCache = new Map<string, Mask>();
const capTop: Partial<Record<Font, number>> = {};
/** A text as whole pixels: drawn once on a canvas, thresholded, cropped from the cap line (y = 0 is the top of an H). */
function mask(text: string, font: Font): Mask {
  const key = `${font}|${text}`, hit = maskCache.get(key); if (hit) return hit;
  const probe = createCanvas(16, 16).getContext('2d'); probe.font = FONT[font];
  const w = Math.max(1, Math.ceil(probe.measureText(text).width) + 2), H = 24;
  const cv = createCanvas(w, H), g = cv.getContext('2d');
  g.font = FONT[font]; g.fillStyle = '#fff'; g.textBaseline = 'alphabetic'; g.fillText(text, 0, 16);
  const data = g.getImageData(0, 0, w, H).data;
  if (capTop[font] === undefined) {
    const hc = createCanvas(16, H), hg = hc.getContext('2d'); hg.font = FONT[font]; hg.fillStyle = '#fff'; hg.textBaseline = 'alphabetic'; hg.fillText('H', 0, 16);
    const hd = hg.getImageData(0, 0, 16, H).data; let top = 0;
    for (let y = 0; y < H; y++) { let ink = false; for (let x = 0; x < 16; x++) if ((hd[(y * 16 + x) * 4 + 3] as number) >= 110) ink = true; if (ink) { top = y; break; } }
    capTop[font] = top;
  }
  const top = capTop[font] as number, h = H - top, bits = new Uint8Array(w * h);
  let right = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((data[((y + top) * w + x) * 4 + 3] as number) >= 110) { bits[y * w + x] = 1; right = Math.max(right, x + 1); }
  const m = { w: right, h, bits: bits }, full = { ...m, stride: w };
  const out: Mask = { w: right, h, bits: new Uint8Array(right * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < right; x++) out.bits[y * right + x] = full.bits[y * full.stride + x] as number;
  maskCache.set(key, out);
  return out;
}
const textWidth = (text: string, font: Font): number => mask(text, font).w;

/* --------------------------------- frame buffer -------------------------------- */
class Frame {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: Colour) { this.px = new Uint8Array(w * h).fill(C[bg]); }
  set(x: number, y: number, c: Colour): void { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = C[c]; }
  rect(x: number, y: number, w: number, h: number, c: Colour): void {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    for (let yy = y0; yy < y1; yy++) this.px.fill(C[c], yy * this.w + x0, yy * this.w + Math.max(x0, x1));
  }
  frameRect(x: number, y: number, w: number, h: number, t: number, c: Colour): void { this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c); this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c); }
  /** A dotted outline: 2 pixels on, 2 off. */
  dotted(x: number, y: number, w: number, h: number, c: Colour): void {
    for (let i = 0; i < w; i++) if ((i >> 1) % 2 === 0) { this.set(x + i, y, c); this.set(x + i, y + h - 1, c); }
    for (let i = 0; i < h; i++) if ((i >> 1) % 2 === 0) { this.set(x, y + i, c); this.set(x + w - 1, y + i, c); }
  }
  /** A disc with a light top-left, a shaded bottom-right and an outline: the round tree, the coin. */
  disc(cx: number, cy: number, r: number, fill: Colour, light: Colour | null, shade: Colour | null, outline: Colour | null): void {
    for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) {
      const d = dx * dx + dy * dy;
      if (d <= r * r) {
        let c = fill;
        if (light && dx + dy < -r * 0.75 && d < r * r * 0.7) c = light;
        else if (shade && dx + dy > r * 0.55) c = shade;
        this.set(cx + dx, cy + dy, c);
      } else if (outline && d <= (r + 1) * (r + 1)) this.set(cx + dx, cy + dy, outline);
    }
  }
  text(s: string, x: number, y: number, font: Font, c: Colour, shadow: Colour | null = null): number {
    const m = mask(s, font);
    for (const [ox, oy, col] of (shadow ? [[1, 1, shadow], [0, 0, c]] : [[0, 0, c]]) as [number, number, Colour][]) {
      for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) if (m.bits[yy * m.w + xx]) this.set(x + xx + ox, y + yy + oy, col);
    }
    return m.w;
  }
  /** A sprite from rows of characters, each mapped to a colour ('.' is transparent). */
  sprite(rows: readonly string[], x: number, y: number, map: Record<string, Colour>): void {
    rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const k = row[i] as string; const c = map[k]; if (c) this.set(x + i, y + j, c); } });
  }
  /** Scaled nearest-neighbour to RGBA. */
  rgba(scale: number): Uint8ClampedArray {
    const W = this.w * scale, out = new Uint8ClampedArray(W * this.h * scale * 4);
    for (let y = 0; y < this.h; y++) {
      const line = new Uint8ClampedArray(W * 4);
      for (let x = 0; x < this.w; x++) {
        const [r, g, b] = RGB[this.px[y * this.w + x] as number] as readonly [number, number, number];
        for (let k = 0; k < scale; k++) { const o = (x * scale + k) * 4; line[o] = r; line[o + 1] = g; line[o + 2] = b; line[o + 3] = 255; }
      }
      for (let k = 0; k < scale; k++) out.set(line, (y * scale + k) * W * 4);
    }
    return out;
  }
}
/** A stable pseudo-random integer for a few integers (decor, tones). */
const hash = (...n: number[]): number => { let h = 2166136261; for (const v of n) { h ^= v | 0; h = Math.imul(h, 16777619); h ^= h >>> 13; } return h >>> 0; };

/* ------------------------------------ sprites ----------------------------------- */
const HEART = ['.###...###.', '#bbb#.#bbb#', '#bwbb#bbbb#', '#bwbbbbbbb#', '#bbbbbbbbb#', '.#bbbbbbb#.', '..#bbbbb#..', '...#bbb#...', '....#b#....', '.....#.....'];
const SPARK = ['...b...', '...b...', '..blb..', 'bblllbb', '..blb..', '...b...', '...b...'];
const SPARK_SMALL = ['.b.', 'blb', '.b.'];
const SPARK_MAP: Record<string, Colour> = { b: 'blue', l: 'blueLight' };
const COIN = ['.bllb.', 'bllclb', 'bllclb', 'bllllb', 'bllllb', '.bbbb.'];
const COIN_EDGE = ['.bb.', 'blcb', 'blcb', 'bllb', 'bllb', '.bb.'];
const COIN_MAP: Record<string, Colour> = { b: 'blue', l: 'blueLight', c: 'chalk' };

function hud(f: Frame, heartsOn: boolean): void {
  for (let i = 0; i < 5; i++) f.sprite(HEART, 6 + i * 13, 5, { '#': 'ink', b: heartsOn ? 'blue' : 'chalk', w: heartsOn ? 'blueLight' : 'chalk' });
  const s = `${HUD_COUNT} NAMES`;
  f.text(s, f.w - 6 - textWidth(s, 'big'), 7, 'big', 'chalk', 'ink');
}

/* ------------------------------------ decor ------------------------------------- */
function sky(f: Frame, bottom: number, t: number, seed = 1): void {
  f.rect(0, 0, f.w, bottom, 'ink');
  for (let i = 0; i < 26; i++) {
    const x = hash(seed, i, 1) % f.w, y = hash(seed, i, 2) % Math.max(1, bottom - 8);
    const on = ((Math.floor(t * 4) + i) % 7) !== 0;
    f.set(x, y, on ? 'chalk' : 'darkGrey');
  }
}
/** The forest at the back: a row of round canopies, scrolled at half the camera. */
function forest(f: Frame, top: number, bottom: number, cam: number): void {
  f.rect(0, top + 10, f.w, bottom - top - 10, 'darkGrey');
  const off = Math.floor(cam / 2);
  for (let k = Math.floor(off / 18) - 1; k * 18 - off < f.w + 18; k++) {
    const x = k * 18 - off + (hash(k, 3) % 6), r = 10 + (hash(k, 4) % 4);
    f.disc(x, top + 12 - (hash(k, 5) % 5), r, 'darkGrey', 'midGrey', null, null);
  }
}
/** A round tree standing at (x, base). */
function tree(f: Frame, x: number, base: number, r: number): void {
  for (let dx = -r + 2; dx <= r - 2; dx++) f.set(x + dx, base, 'midGrey');          // its shadow
  f.rect(x - r + 3, base - 1, 2 * r - 5, 2, 'midGrey');
  f.rect(x - 2, base - 9, 4, 9, 'ink');
  f.disc(x, base - 8 - r + 2, r, 'darkGrey', 'midGrey', null, 'ink');
}
/** Grass from `top` down, a dirt path, tufts; everything scrolls with the camera. */
function ground(f: Frame, top: number, pathY: number, cam: number): void {
  f.rect(0, top, f.w, f.h - top, 'concrete');
  f.rect(0, pathY, f.w, 12, 'midGrey');
  for (let x = 0; x < f.w; x++) {
    const wx = x + cam;
    if (hash(wx, 7) % 5 === 0) f.set(x, pathY - 1, 'midGrey');
    if (hash(wx, 8) % 6 === 0) f.set(x, pathY + 12, 'midGrey');
    if (hash(wx, 9) % 23 === 0) f.set(x, pathY + 4 + (hash(wx, 10) % 6), 'darkGrey');
  }
  for (let k = Math.floor(cam / 13) - 1; k * 13 - cam < f.w; k++) {
    const x = k * 13 - cam + (hash(k, 11) % 9), y = top + 4 + (hash(k, 12) % Math.max(1, f.h - top - 8));
    if (y >= pathY - 3 && y <= pathY + 14) continue;
    f.set(x, y, 'midGrey'); f.set(x + 2, y, 'midGrey'); f.set(x + 1, y + 1, 'midGrey'); f.set(x - 1, y - 1, 'midGrey'); f.set(x + 3, y - 1, 'midGrey');
  }
}
/** A plaque of chalk with its name in ink (truncated to the plaque). */
function plaque(f: Frame, x: number, y: number, w: number, h: number, name: string): void {
  f.rect(x + 1, y + h + 1, w, 1, 'ink');
  f.rect(x, y, w, h, 'chalk'); f.rect(x, y + h - 1, w, 1, 'concrete');
  f.frameRect(x - 1, y - 1, w + 2, h + 2, 1, 'darkGrey');
  let s = name; while (s.length > 1 && textWidth(s, 'small') > w - 4) s = s.slice(0, -1);
  if (s) f.text(s, x + Math.floor((w - textWidth(s, 'small')) / 2), y + Math.floor((h - 5) / 2), 'small', 'ink');
}
/** A row of plaques: either a real row of the wall (wallRow, its 25 panels in place) or the named panels one after another from `from`. */
type PlaqueRow = { y: number; wallRow?: number; from?: number };
type WallSpec = { top: number; cap: number; face: number; cam: number; pitch: number; pw: number; ph: number; rows: PlaqueRow[]; firstCol: number; skip?: Set<number> };
/** The long stone wall in three-quarter view: its top, its face in running bond, its plaques of real names. */
function wall(f: Frame, s: WallSpec): void {
  const { top, cap, face, cam } = s, faceTop = top + cap, bottom = faceTop + face;
  f.rect(0, top, f.w, cap, 'concrete'); f.rect(0, top, f.w, 1, 'chalk'); f.rect(0, faceTop - 1, f.w, 1, 'darkGrey');
  for (let x = 0; x < f.w; x++) if (hash(x + cam, 13) % 9 === 0) f.set(x, top + 2 + (hash(x + cam, 14) % Math.max(1, cap - 3)), 'stone');
  f.rect(0, faceTop, f.w, face, 'stone');
  for (let y = faceTop; y < bottom; y++) {
    const r = y - faceTop, course = Math.floor(r / 8);
    for (let x = 0; x < f.w; x++) {
      const wx = x + cam + (course % 2) * 8;
      if (r % 8 === 7 || wx % 16 === 15) f.set(x, y, 'darkGrey');
      else if (r % 8 === 0 && hash(Math.floor(wx / 16), course, 15) % 3 === 0) f.set(x, y, 'concrete');
    }
  }
  f.rect(0, bottom, f.w, 2, 'darkGrey'); f.rect(0, bottom + 2, f.w, 2, 'midGrey');
  for (const row of s.rows) {
    if (row.from !== undefined) {
      for (let c = Math.floor(cam / s.pitch) - 1; (c - s.firstCol) * s.pitch - cam < f.w; c++) {
        const x = (c - s.firstCol) * s.pitch - cam + Math.floor((s.pitch - s.pw) / 2);
        plaque(f, x, row.y, s.pw, s.ph, namedAt(row.from - 1 + c));
      }
      continue;
    }
    for (let c = 0; c < 25; c++) {
      const x = (c - s.firstCol) * s.pitch - cam + Math.floor((s.pitch - s.pw) / 2);
      if (x + s.pw < 0 || x > f.w) continue;
      const pos = (row.wallRow ?? 0) * 25 + c + 1;
      if (s.skip?.has(pos)) { f.rect(x - 1, row.y - 1, s.pw + 2, s.ph + 2, 'darkGrey'); f.rect(x + 1, row.y + 1, s.pw - 2, s.ph - 2, 'ink'); continue; }
      plaque(f, x, row.y, s.pw, s.ph, nameAt(pos));
    }
  }
}

/* -------------------------------- dialogue box ---------------------------------- */
const BOX_H = 66;
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = []; let line = '';
  for (const word of text.split(' ')) { if (line && (line + ' ' + word).length > maxChars) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word; }
  if (line) lines.push(line);
  if (lines.length > 2) throw new Error(`dialogue: more than two lines: ${text}`);
  return lines;
}
/** Typing speed for a line in a scene of `dur` seconds: the configured speed, faster only if the line would not be readable for long enough. */
const cpsFor = (text: string, dur: number): number => Math.max(CFG.typing.cps, text.length / (dur - CFG.typing.readable - CFG.typing.start));
function dialogue(f: Frame, text: string, t: number, dur: number): void {
  const x = 6, y = f.h - BOX_H - 4, w = f.w - 12, h = BOX_H;
  f.rect(x, y, w, h, 'ink'); f.frameRect(x, y, w, h, 2, 'chalk');
  const lines = wrap(text, Math.floor((w - 24) / 8));
  let left = Math.max(0, Math.floor((t - CFG.typing.start) * cpsFor(text, dur)));
  lines.forEach((line, i) => { const shown = line.slice(0, left); left -= line.length + 1; if (shown) f.text(shown, x + 12, y + 16 + i * 18, 'big', 'chalk'); });
  if (left >= 0 && Math.floor(t * 3) % 2 === 0) f.sprite(['#######', '.#####.', '..###..', '...#...'], x + w - 18, y + h - 12, { '#': 'chalk' });
}

/* ------------------------------------ scenes ------------------------------------ */
// Each scene draws one frame at time t (seconds since the scene began) into a 480 × 270 frame.
const SCENE_DUR = 4;
/** The long wall seen from the path (sequences 1, 3 and 4): sky, forest, round trees peeking over it, two rows of
 *  plaques, the grass and the dirt path at its foot. `cam` is the camera's x along the wall, in whole pixels. */
function longWall(f: Frame, t: number, cam: number, seed: number, from: number): void {
  sky(f, 40, t, seed); forest(f, 26, 56, cam);
  for (let k = Math.floor(cam * 0.8 / 97) - 1; k * 97 - Math.floor(cam * 0.8) < f.w + 20; k++) f.disc(k * 97 - Math.floor(cam * 0.8) + 30, 44, 13, 'darkGrey', 'midGrey', null, 'ink');
  wall(f, { top: 50, cap: 8, face: 56, cam, pitch: 58, pw: 52, ph: 15, firstCol: 0, rows: [{ y: 64, from }, { y: 86, from: from + 120 }] });
  ground(f, 110, 124, cam);
}
/** Sequence 1: along the wall, the camera moving at 15 px/s, the names going by. */
function sceneWall(f: Frame, t: number, line: string): void {
  const cam = Math.floor(t * 15);
  longWall(f, t, cam, 1, CFG.plaques.start);
  for (let k = Math.floor(cam / 160) - 1; k * 160 + 60 - cam < f.w + 40; k++) tree(f, k * 160 + 60 - cam + (hash(k, 61) % 24), 186 + (hash(k, 62) % 9), 13 + (hash(k, 63) % 4));
  hud(f, true); dialogue(f, line, t, SCENE_DUR);
}
/** Sequence 2: eight plaques of one real row leave the wall in turn and fall, by whole steps, into the 8×8 grid at its
 *  foot; the row completes and blinks blue. */
const ROW_GRID = { x: 144, y: 90, cw: 24, ch: 13 };
const ROW_TIMES = { leave: (i: number): number => 0.3 + i * 0.27, loose: 0.13, fall: 0.4 };
function sceneRow(f: Frame, t: number, line: string): void {
  const start = CFG.row.start, wallRow = Math.floor((start - 1) / 25), col0 = (start - 1) % 25;
  const pitch = 56, pw = 50, ph = 14, firstX = Math.floor((f.w - 8 * pitch) / 2), plaqueY = 34;
  const cam = col0 * pitch - firstX, T = ROW_TIMES;
  const gone = new Set<number>(); for (let i = 0; i < 8; i++) if (t >= T.leave(i)) gone.add(start + i);
  sky(f, 14, t, 2); forest(f, 4, 24, cam);
  wall(f, { top: 20, cap: 6, face: 44, cam, pitch, pw, ph, firstCol: 0, rows: [{ y: plaqueY, wallRow }], skip: gone });
  ground(f, 68, 72, cam);
  tree(f, 56, 196, 16); tree(f, 424, 196, 16);
  // the grid at the foot of the wall, in three-quarter
  const G = ROW_GRID, gw = 8 * G.cw, gh = 8 * G.ch;
  f.rect(G.x - 3, G.y - 3, gw + 6, gh + 6, 'darkGrey'); f.rect(G.x - 3, G.y - 3, gw + 6, 1, 'chalk');
  f.rect(G.x, G.y, gw, gh, 'stone');
  for (let i = 0; i <= 8; i++) { f.rect(G.x + i * G.cw, G.y, 1, gh, 'darkGrey'); f.rect(G.x, G.y + i * G.ch, gw, 1, 'darkGrey'); }
  const allDown = T.leave(7) + T.loose + T.fall;
  const blue = t >= allDown && Math.floor((t - allDown) * 7.5) % 2 === 0;
  for (let i = 0; i < 8; i++) {
    const name = nameAt(start + i), px = firstX + i * pitch + Math.floor((pitch - pw) / 2), t0 = T.leave(i);
    if (t < t0) continue;
    if (t < t0 + T.loose) { plaque(f, px, plaqueY + (t < t0 + T.loose / 2 ? 1 : 2), pw, ph, name); continue; }   // it comes loose
    const sx = px + Math.floor((pw - G.cw) / 2), sy = plaqueY + ph + 2, tx = G.x + i * G.cw, ty = G.y + 7 * G.ch;
    const k = Math.min(1, (t - t0 - T.loose) / T.fall), steps = 12, s = Math.floor(k * steps) / steps;   // constant speed, whole steps
    brick(f, Math.round(sx + (tx - sx) * s), Math.round(sy + (ty - sy) * s), name, k >= 1 && blue);
  }
  hud(f, true); dialogue(f, line, t, SCENE_DUR);
}
function brick(f: Frame, x: number, y: number, name: string, painted: boolean): void {
  const G = ROW_GRID;
  f.rect(x, y, G.cw + 1, G.ch + 1, 'ink');
  f.rect(x + 1, y + 1, G.cw - 1, G.ch - 4, painted ? 'blue' : 'ink');
  f.rect(x + 1, y + G.ch - 3, G.cw - 1, 3, painted ? 'ink' : 'darkGrey');
  f.rect(x + 1, y + 1, G.cw - 1, 1, painted ? 'blueLight' : 'darkGrey');
  let s = name.replace(/[^A-Z0-9]/g, '').slice(0, 4); while (s.length > 1 && textWidth(s, 'small') > G.cw - 3) s = s.slice(0, -1);
  f.text(s, x + 1 + Math.floor((G.cw - 1 - textWidth(s, 'small')) / 2), y + 3, 'small', 'chalk');
}
/** Sequence 3: before the wall, a chest opens; coins rise out of it; the hearts blink once. */
function sceneChest(f: Frame, t: number, line: string): void {
  const cam = 700;
  longWall(f, t, cam, 3, CFG.plaques.start + 24);
  tree(f, 44, 194, 16); tree(f, 436, 194, 16);
  const cx = 240, base = 186, open = t >= 0.4;
  chest(f, cx, base, open);
  // coins: one every 0.1 s once the chest is open, rising 45 px/s by whole pixels, swaying a pixel, gone after 1.5 s
  if (open) for (let k = 0; k < 40; k++) {
    const born = 0.45 + k * 0.1, age = t - born; if (age < 0 || age > 1.5) continue;
    const spread = (hash(k, 21) % 41) - 20, x = cx - 3 + Math.round(spread * Math.min(1, age * 2)) + (Math.floor(age * 6) % 2), y = base - 26 - Math.floor(age * 45);
    f.sprite(Math.floor(age * 8) % 3 === 2 ? COIN_EDGE : COIN, x, y, COIN_MAP);
    if (k % 3 === 0 && Math.floor(age * 10) % 2 === 0) f.sprite(SPARK_SMALL, x + 7, y - 3, SPARK_MAP);
  }
  hud(f, !(t >= 1.0 && t < 1.27 && Math.floor((t - 1.0) * 15) % 2 === 0)); dialogue(f, line, t, SCENE_DUR);
}
function chest(f: Frame, cx: number, base: number, open: boolean): void {
  // ink and grey wood, stone bands, a chalk lock; open, the pot glows blue inside
  const w = 40, h = 20, x = cx - w / 2, y = base - h;
  f.rect(x - 2, base, w + 4, 3, 'midGrey');
  if (open) { f.rect(x, y - 13, w, 13, 'ink'); f.rect(x + 1, y - 12, w - 2, 11, 'darkGrey'); f.rect(x + 1, y - 12, w - 2, 1, 'midGrey'); f.rect(x + 2, y - 3, w - 4, 3, 'blue'); f.rect(x + 4, y - 3, w - 8, 1, 'blueLight'); f.rect(x + 6, y - 12, 3, 11, 'stone'); f.rect(x + w - 9, y - 12, 3, 11, 'stone'); }
  f.rect(x, y, w, h, 'ink'); f.rect(x + 1, y + 1, w - 2, h - 2, 'darkGrey');
  f.rect(x + 1, y + 1, w - 2, 1, 'midGrey'); f.rect(x + 1, y + h - 3, w - 2, 2, 'ink');
  for (const bx of [x + 6, x + w - 9]) f.rect(bx, y + 1, 3, h - 2, 'stone');
  if (!open) { f.rect(x, y - 9, w, 10, 'ink'); f.rect(x + 1, y - 8, w - 2, 8, 'darkGrey'); f.rect(x + 1, y - 8, w - 2, 1, 'midGrey'); f.rect(x + 6, y - 8, 3, 8, 'stone'); f.rect(x + w - 9, y - 8, 3, 8, 'stone'); }
  f.rect(cx - 3, y + 3, 6, 7, 'chalk'); f.rect(cx - 1, y + 5, 2, 3, 'ink');
}
/** Sequence 4: at the foot of the wall, an empty game box with a dotted outline, YOUR GAME HERE, filling with bricks. */
function sceneYourGame(f: Frame, t: number, line: string): void {
  const cam = 1400;
  longWall(f, t, cam, 4, CFG.plaques.start + 48);
  tree(f, 52, 194, 16); tree(f, 428, 194, 16);
  // the box: a front face and, in three-quarter, its top and its side, dotted until bricks fill it
  const bw = 144, bh = 52, d = 8, bx = Math.floor((f.w - bw - d) / 2), by = 194 - bh;
  f.rect(bx + 2, by + bh, bw, 2, 'midGrey');
  const cols = Math.ceil(bw / 8) + 1, rows = Math.floor((bh - 2) / 4), total = cols * rows;
  const laid = Math.min(total, Math.floor(total * Math.min(1, t / 3.6)));
  for (let k = 0; k < laid; k++) {
    const r = rows - 1 - Math.floor(k / cols), c = k % cols, off = r % 2 ? 4 : 0;
    const x = bx + 1 + c * 8 - off, y = by + bh - 1 - (rows - r) * 4;
    const x0 = Math.max(x, bx + 1), x1 = Math.min(x + 7, bx + bw - 1);
    if (x1 <= x0) continue;
    f.rect(x0, y, x1 - x0, 3, hash(r, c, 31) % 3 ? 'stone' : 'midGrey'); f.rect(x0, y + 3, x1 - x0 + 1, 1, 'darkGrey');
    if (x + 7 < bx + bw - 1) f.rect(x + 7, y, 1, 3, 'darkGrey');
  }
  for (let i = 1; i < d; i++) if ((i >> 1) % 2 === 0) { f.set(bx + i, by - i, 'chalk'); f.set(bx + bw - 1 + i, by - i, 'chalk'); f.set(bx + bw - 1 + i, by + bh - 1 - i, 'chalk'); }
  f.dotted(bx + d, by - d, bw, 1, 'chalk'); f.dotted(bx + bw - 1 + d, by - d, 1, bh, 'chalk');
  f.dotted(bx, by, bw, bh, 'chalk');
  const label = CFG.yourGame, lw = textWidth(label, 'big');
  f.text(label, bx + Math.floor((bw - lw) / 2), by + 8, 'big', 'chalk', 'ink');
  hud(f, true); dialogue(f, line, t, SCENE_DUR);
}

/* ------------------------------ title and end card ------------------------------- */
// The title is lettered in bricks of 8 × 4 (two per cell of a 5 × 7 letter), chalk and concrete, on ink.
const LETTERS: Record<string, string[]> = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
};
type Brick = { x: number; y: number; tone: Colour; from: [number, number] };
function titleBricks(W: number, top: number): { bricks: Brick[]; box: [number, number, number, number] } {
  const cell = 8, gap = 6, space = 18, lineGap = 10;
  const widthOf = (s: string): number => [...s].reduce((a, ch, i) => a + (ch === ' ' ? space : 5 * cell) + (i ? gap : 0), 0);
  const bricks: Brick[] = [];
  let minX = W, maxX = 0;
  CFG.title.forEach((text, li) => {
    let x = Math.floor((W - widthOf(text)) / 2); const y0 = top + li * (7 * cell + lineGap);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x + widthOf(text));
    [...text].forEach((ch, ci) => {
      if (ci) x += gap;
      if (ch === ' ') { x += space; return; }
      const g = LETTERS[ch]; if (!g) throw new Error(`title: no brick letter for ${ch}`);
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r]?.[c] === '#') for (const half of [0, 1]) {
        const bx = x + c * cell, by = y0 + r * cell + half * 4, k = bricks.length, side = hash(k, 41) % 4;
        const from: [number, number] = side === 0 ? [bx, -8] : side === 1 ? [W + 8, by] : side === 2 ? [bx, 270 + 8] : [-16, by];
        bricks.push({ x: bx, y: by, tone: (hash(r, c, half, ci, li) % 3) ? 'chalk' : 'concrete', from });
      }
      x += 5 * cell;
    });
  });
  return { bricks, box: [minX, top, maxX, top + 2 * 7 * cell + lineGap] };
}
const TITLE = { assemble: 2.9, firstLand: 0.4, speed: 16 };     // bricks land in reading order from 0.4 s to 2.9 s, flying 16 px a frame
function silhouette(f: Frame, top: number): void {
  for (let k = 0; k < 12; k++) { const x = k * 44 + (hash(k, 51) % 16); f.disc(x, top + 4 - (hash(k, 52) % 6), 14 + (hash(k, 53) % 5), 'darkGrey', null, null, null); }
  f.rect(0, top + 12, f.w, f.h - top - 12, 'darkGrey');
  for (let x = 0; x < f.w; x += 16) f.rect(x, top + 8, 10, 4, 'darkGrey');
}
function brickAt(f: Frame, b: Brick, x: number, y: number): void { f.rect(x, y, 7, 3, b.tone); f.rect(x, y + 3, 8, 1, 'midGrey'); f.rect(x + 7, y, 1, 3, 'midGrey'); }
function titleScreen(f: Frame, t: number): void {
  sky(f, f.h, t, 9); silhouette(f, 214);
  const { bricks, box } = titleBricks(f.w, 64);
  const frame = Math.floor(t * 30), first = TITLE.firstLand * 30, last = TITLE.assemble * 30;
  let landed = 0;
  bricks.forEach((b, k) => {
    // its landing frame, in reading order at an even rate; it leaves its edge as many frames before as its flight takes
    const dx = b.x - b.from[0], dy = b.y - b.from[1], dist = Math.hypot(dx, dy);
    const land = Math.round(first + (last - first) * k / Math.max(1, bricks.length - 1)), age = frame - (land - Math.ceil(dist / TITLE.speed));
    if (age < 0) return;
    if (frame >= land) { landed++; f.rect(b.x + 1, b.y + 4, 8, 1, 'darkGrey'); brickAt(f, b, b.x, b.y); return; }
    const travelled = Math.min(dist, age * TITLE.speed);
    brickAt(f, b, Math.round(b.from[0] + dx * travelled / dist), Math.round(b.from[1] + dy * travelled / dist));
  });
  const done = landed === bricks.length;
  if (done && frame === Math.ceil(TITLE.assemble * 30)) { f.rect(0, 0, f.w, f.h, 'chalk'); return; }   // one white frame
  if (done) sparkles(f, box, t);
}
function sparkles(f: Frame, box: [number, number, number, number], t: number): void {
  const [x0, y0, x1, y1] = box, big = Math.floor(t * 6) % 2 === 0;
  for (const [x, y] of [[x0 - 10, y0 - 10], [x1 + 3, y0 - 10], [x0 - 10, y1 + 3], [x1 + 3, y1 + 3]] as [number, number][]) {
    if (big) f.sprite(SPARK, x, y, SPARK_MAP); else f.sprite(SPARK_SMALL, x + 2, y + 2, SPARK_MAP);
  }
}
function endCard(f: Frame, t: number): void {
  sky(f, f.h, t + 4, 9); silhouette(f, 226);
  const { bricks, box } = titleBricks(f.w, 30);
  for (const b of bricks) { f.rect(b.x + 1, b.y + 4, 8, 1, 'darkGrey'); brickAt(f, b, b.x, b.y); }
  sparkles(f, box, t);
  const E = CFG.end, cx = (s: string, font: Font): number => Math.floor((f.w - textWidth(s, font)) / 2);
  f.text(E.line, cx(E.line, 'big'), 166, 'big', 'chalk');
  f.text(E.url, cx(E.url, 'big'), 186, 'big', 'chalk'); f.rect(cx(E.url, 'big'), 196, textWidth(E.url, 'big'), 1, 'midGrey');
  f.text(E.credit, cx(E.credit, 'small'), 208, 'small', 'stone');
}

/* -------------------------------------- run -------------------------------------- */
const STILL_T: Record<Sequence['scene'], number> = { wall: 3.1, row: 1.95, chest: 2.9, yourgame: 3.0 };
const SCENES = { wall: sceneWall, row: sceneRow, chest: sceneChest, yourgame: sceneYourGame } as const;
async function png(f: Frame, scale: number, name: string): Promise<void> {
  const cv = createCanvas(f.w * scale, f.h * scale), g = cv.getContext('2d');
  const img = g.createImageData(f.w * scale, f.h * scale); img.data.set(f.rgba(scale)); g.putImageData(img, 0, 0);
  await mkdir(OUT, { recursive: true }); await writeFile(`${OUT}/${name}`, cv.toBuffer('image/png'));
  console.log(`${OUT}/${name}`);
}
const command = argv[0] ?? 'stills';
if (command === 'stills') {
  for (const seq of CFG.sequences) { const len = seq.line.length, cps = cpsFor(seq.line, SCENE_DUR); console.log(`${seq.scene}: ${len} chars at ${cps.toFixed(1)} cps, written by ${(CFG.typing.start + len / cps).toFixed(2)} s`); }
  const title = new Frame(480, 270, 'ink'); titleScreen(title, 3.4); await png(title, 4, 'board-0-title.png');
  for (const [i, seq] of CFG.sequences.entries()) {
    const f = new Frame(480, 270, 'ink'); SCENES[seq.scene](f, STILL_T[seq.scene], seq.line); await png(f, 4, `board-${i + 1}-scene-${i + 1}.png`);
  }
  const end = new Frame(480, 270, 'ink'); endCard(end, 1); await png(end, 4, 'board-5-end.png');
}
