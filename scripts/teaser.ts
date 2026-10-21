// THE WALL ARCADE teaser, 16 bits: a pixel world at 480 × 270, drawn in the 8 tones of NFC (comms/teaser/palette.json) into an
// indexed frame buffer, scaled 4× nearest-neighbour (crisp pixels, never smoothed). Every text, the gameplay order and
// sources, the names on the plaques come from comms/teaser/teaser.config.json; the names are the wall's snapshot
// (src/generated/wall.json). Fonts: Press Start 2P and Silkscreen (SIL OFL, comms/teaser/assets), rendered then
// thresholded so every glyph pixel is a whole pixel. No generated imagery, nothing from an existing game.
//
//   node --import tsx scripts/teaser.ts stills [--out comms/teaser/out]     the board of six stills (title, 4 scenes, end)
//   node --import tsx scripts/teaser.ts video  [--formats 16x9,9x16,1x1]     teaser-<format>.mp4 (31 s, 30 fps, H.264 + AAC)
//   node --import tsx scripts/teaser.ts kit                                   title-16x9/1x1, scene-1..4 (1080 × 1350), end-card-16x9, holders
//   node --import tsx scripts/teaser.ts gif    [--out comms/teaser/out]     title-assembly.gif (the first 4 s)
//
// Every movement is a whole number of pixels per frame (30 fps); the stills are frames of the same functions.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GlobalFonts, createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import snapshot from '../src/generated/wall.json' with { type: 'json' };

const root = new URL('../', import.meta.url);
const argv = process.argv.slice(2);
const arg = (name: string, fallback = ''): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const OUT = arg('out', 'comms/teaser/out');

/* ------------------------------- palette, config ------------------------------ */
const paletteJson = JSON.parse(await readFile(new URL(arg('palette', 'comms/teaser/palette.json'), root), 'utf8')) as Record<string, string>;
const NAMES = ['ink', 'darkGrey', 'midGrey', 'stone', 'concrete', 'chalk', 'blue', 'blueLight'] as const;
type Colour = typeof NAMES[number];
type Paint = Colour | 'clear';
const C = { ...Object.fromEntries(NAMES.map((n, i) => [n, i])), clear: 255 } as Record<Paint, number>;   // clear: an overlay's transparent pixel
const RGB = NAMES.map((n) => {
  const hex = paletteJson[n]; if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`palette: ${n} missing`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] as const;
});
type Sequence = { scene: 'wall' | 'row' | 'chest' | 'yourgame'; line: string; card: string; clip: string; clipDuration?: number };
type Config = {
  title: [string, string]; hudNames: number | null; plaques: { start: number; skip?: string[] }; row: { start: number };
  sequences: Sequence[]; end: { line: string; url: string; credit: string }; yourGame: string;
  typing: { cps: number; readable: number; start: number }; card: { duration: number; lineGap: number }; clip: number; holders: string[];
  opening: { duration: number; logos: [string, string]; present: string }; jackpot: string;
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
  constructor(readonly w: number, readonly h: number, bg: Paint) { this.px = new Uint8Array(w * h).fill(C[bg]); }
  set(x: number, y: number, c: Paint): void { x |= 0; y |= 0; if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = C[c]; }
  rect(x: number, y: number, w: number, h: number, c: Paint): void {
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
        const i = this.px[y * this.w + x] as number, [r, g, b] = (RGB[i] ?? [0, 0, 0]) as readonly [number, number, number], a = i === 255 ? 0 : 255;
        for (let k = 0; k < scale; k++) { const o = (x * scale + k) * 4; line[o] = r; line[o + 1] = g; line[o + 2] = b; line[o + 3] = a; }
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
function titleBricks(W: number, top: number, H = 270): { bricks: Brick[]; box: [number, number, number, number] } {
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
        const from: [number, number] = side === 0 ? [bx, -8] : side === 1 ? [W + 8, by] : side === 2 ? [bx, H + 8] : [-16, by];
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
  sky(f, f.h, t, 9); silhouette(f, f.h - 56);
  const { bricks, box } = titleBricks(f.w, Math.round(f.h * 0.237), f.h);
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
/** The end card's block: title (122) · line · link · the logos (END_LOGOS) · credit; centred. */
const END_TOP = (H: number): number => Math.max(4, Math.round((H - 226) / 2) - 6);
const END_LOGOS = { top: 170, height: 38 };
function endCard(f: Frame, t: number): void {
  sky(f, f.h, t + 4, 9); silhouette(f, f.h - 14);
  const y0 = END_TOP(f.h);                                      // the title, its line, the link, the logos, the credit
  const { bricks, box } = titleBricks(f.w, y0, f.h);
  for (const b of bricks) { f.rect(b.x + 1, b.y + 4, 8, 1, 'darkGrey'); brickAt(f, b, b.x, b.y); }
  sparkles(f, box, t);
  const E = CFG.end, cx = (s: string, font: Font): number => Math.floor((f.w - textWidth(s, font)) / 2);
  f.text(E.line, cx(E.line, 'big'), y0 + 136, 'big', 'chalk');
  f.text(E.url, cx(E.url, 'big'), y0 + 156, 'big', 'chalk'); f.rect(cx(E.url, 'big'), y0 + 166, textWidth(E.url, 'big'), 1, 'midGrey');
  f.text(E.credit, cx(E.credit, 'small'), y0 + 214, 'small', 'stone');
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
/* ---------------------------------- timeline ---------------------------------- */
// the opening (the two logos, "present") · the title (4 s) · for each sequence its card (3.5 s), then its clip (2.5 s,
// or its own clipDuration) · the end card (3 s). Hard cuts only.
const FPS = 30, OPEN_DUR = CFG.opening.duration, TITLE_DUR = 4, END_DUR = 3, CARD_DUR = CFG.card.duration;
const clipDur = (i: number): number => (CFG.sequences[i] as Sequence).clipDuration ?? CFG.clip;
const SEQ_STARTS = CFG.sequences.map((_, i) => OPEN_DUR + TITLE_DUR + CFG.sequences.slice(0, i).reduce((a, __, j) => a + CARD_DUR + clipDur(j), 0));
const SEQS_END = OPEN_DUR + TITLE_DUR + CFG.sequences.reduce((a, _, j) => a + CARD_DUR + clipDur(j), 0);
const TOTAL = SEQS_END + END_DUR;
type Shot = { kind: 'open' | 'title' | 'end'; t: number } | { kind: 'card' | 'clip'; t: number; i: number };
function shotAt(time: number): Shot {
  if (time < OPEN_DUR) return { kind: 'open', t: time };
  if (time < OPEN_DUR + TITLE_DUR) return { kind: 'title', t: time - OPEN_DUR };
  if (time >= SEQS_END) return { kind: 'end', t: time - SEQS_END };
  let i = SEQ_STARTS.length - 1; while (i > 0 && (SEQ_STARTS[i] as number) > time) i--;
  const v = time - (SEQ_STARTS[i] as number);
  return v < CARD_DUR ? { kind: 'card', t: v, i } : { kind: 'clip', t: v - CARD_DUR, i };
}
const seqStart = (i: number): number => SEQ_STARTS[i] as number;

/* ------------------------------------ cards ------------------------------------- */
// Ink, the line in chalk in the pixel font, as large as it goes (a whole number of screen pixels per font pixel),
// centred, two lines at most, the *starred* words in blue. Each line appears with a one-frame blink (the line in
// reverse), the first at once, the second `lineGap` later; the whole line stays at least 3 s.
type CardLine = { text: string; blue: boolean[] };
function cardLines(src: string, maxChars = Infinity): CardLine[] {
  const plain = src.replace(/\*/g, ''), blue: boolean[] = [];
  let on = false; for (const ch of src) { if (ch === '*') { on = !on; continue; } blue.push(on); }
  // two lines cut between words, never inside a blue span; the most even cut, or a cut after a sentence when it is
  // nearly as even (a fifth longer at most); one line when it is short enough for the frame
  if (plain.length <= maxChars) return [{ text: plain, blue }];
  const words = plain.split(' '), cuts: { lines: string[]; w: number; sentence: boolean }[] = [];
  let at = 0;
  for (let cut = 1; cut < words.length; cut++) {
    at += (words[cut - 1] as string).length + 1;
    if (blue[at - 1] && blue[at]) continue;
    const lines = [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
    cuts.push({ lines, w: Math.max(...lines.map((l) => l.length)), sentence: /[.?!]$/.test(lines[0] as string) });
  }
  const even = cuts.reduce((m, c) => Math.min(m, c.w), Infinity);
  const best = cuts.filter((c) => c.sentence && c.w <= even * 1.2).sort((p, q) => p.w - q.w)[0] ?? cuts.sort((p, q) => p.w - q.w)[0] ?? { lines: [plain] };
  let from = 0;
  return best.lines.map((text) => { const line = { text, blue: blue.slice(from, from + text.length) }; from += text.length + 1; return line; });
}
const rgbOf = (c: Colour): readonly number[] => RGB[C[c]] as readonly number[];
/** The card at time t, drawn into a PW × PH ink buffer. */
function cardFrame(src: string, t: number, PW: number, PH: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PW * PH * 4), ink = rgbOf('ink');
  for (let o = 0; o < out.length; o += 4) { out[o] = ink[0] as number; out[o + 1] = ink[1] as number; out[o + 2] = ink[2] as number; out[o + 3] = 255; }
  const lines = cardLines(src, 0), margin = Math.round(Math.min(PW, PH) * 0.06);
  const longest = Math.max(...lines.map((l) => l.text.length));
  const p = Math.max(1, Math.min(Math.floor((PW - 2 * margin) / (longest * 8)), Math.floor((PH - 2 * margin) / (lines.length * 8 + (lines.length - 1) * 5))));
  const lineH = 8 * p, gap = 5 * p, blockH = lines.length * lineH + (lines.length - 1) * gap, y0 = Math.floor((PH - blockH) / 2);
  const frame = Math.floor(t * FPS);
  const paint = (x: number, y: number, w: number, h: number, rgb: readonly number[]): void => {
    for (let yy = Math.max(0, y); yy < Math.min(PH, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(PW, x + w); xx++) { const o = (yy * PW + xx) * 4; out[o] = rgb[0] as number; out[o + 1] = rgb[1] as number; out[o + 2] = rgb[2] as number; }
  };
  lines.forEach((line, li) => {
    const shownAt = Math.round(li * CFG.card.lineGap * FPS); if (frame < shownAt) return;
    const blink = frame === shownAt, m = mask(line.text, 'big'), x0 = Math.floor((PW - line.text.length * 8 * p) / 2), y = y0 + li * (lineH + gap);
    if (blink) paint(x0 - p, y - p, line.text.length * 8 * p + 2 * p, lineH + p, rgbOf('chalk'));
    for (let yy = 0; yy < Math.min(m.h, 9); yy++) for (let xx = 0; xx < m.w; xx++) {
      if (!m.bits[yy * m.w + xx]) continue;
      const ci = Math.min(line.text.length - 1, Math.floor(xx / 8));
      paint(x0 + xx * p, y + yy * p, p, p, rgbOf(blink ? 'ink' : line.blue[ci] ? 'blue' : 'chalk'));
    }
  });
  return out;
}

/* ------------------------------------- clips ------------------------------------- */
// The whole game screen, uncropped: the portrait recording fitted to the frame's height, centred on ink, nothing over it.
function clipFrames(src: string, PW: number, PH: number, n: number): Uint8ClampedArray[] {
  const path = new URL(src, root).pathname;
  if (!existsSync(path)) throw new Error(`clip: ${src} missing (node --import tsx scripts/teaser-capture.ts)`);
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', path, '-vf',
    `fps=${FPS},scale=${PW}:${PH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2:color=${paletteJson.ink?.replace('#', '0x')}`,
    '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: PW * PH * 4 * (n + 2) });
  const size = PW * PH * 4, frames: Uint8ClampedArray[] = [];
  for (let o = 0; o + size <= raw.length; o += size) frames.push(new Uint8ClampedArray(raw.buffer, raw.byteOffset + o, size));
  return frames;
}

/* ------------------------------------ sound ------------------------------------- */
// One piece of music, looped over the whole film: Korobeiniki (the Russian song of 1861, public domain), synthesized
// here as chiptune (a square wave for the tune, a triangle for the bass) at 140 beats a minute, moderate, a little
// lower under the clips; a soft blip as each line of a card appears; a last chord on the end card's title. No
// recording, no impact. The teaser reads without it.
const RATE = 48000, BEAT = 60 / 140;
// the tune, in beats: [midi, length]; null is a rest
const TUNE: [number | null, number][] = [
  [76, 1], [71, 0.5], [72, 0.5], [74, 1], [72, 0.5], [71, 0.5],
  [69, 1], [69, 0.5], [72, 0.5], [76, 1], [74, 0.5], [72, 0.5],
  [71, 1.5], [72, 0.5], [74, 1], [76, 1],
  [72, 1], [69, 1], [69, 1], [null, 1],
  [null, 0.5], [74, 1], [77, 0.5], [81, 1], [79, 0.5], [77, 0.5],
  [76, 1.5], [72, 0.5], [76, 1], [74, 0.5], [72, 0.5],
  [71, 1], [71, 0.5], [72, 0.5], [74, 1], [76, 1],
  [72, 1], [69, 1], [69, 1], [null, 1],
];
const BASS = [40, 45, 40, 45, 38, 36, 40, 45];          // a root per bar, in eighths alternating with its octave
function synth(): Float32Array {
  const n = Math.ceil(TOTAL * RATE), out = new Float32Array(n);
  const tone = (wave: 'square' | 'triangle', freq: number, t0: number, dur: number, vol: number, release = 0.03): void => {
    const i0 = Math.max(0, Math.floor(t0 * RATE)), i1 = Math.min(n, Math.floor((t0 + dur) * RATE));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / RATE, ph = (t * freq) % 1;
      const v = wave === 'triangle' ? 1 - 4 * Math.abs(ph - 0.5) : (ph < 0.5 ? 1 : -1);
      const env = Math.min(1, t / 0.005) * Math.min(1, (dur - t) / release) * (1 - 0.25 * t / dur);
      out[i] = (out[i] as number) + v * vol * env;
    }
  };
  const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
  const musicEnd = TOTAL - END_DUR, loop = 32 * BEAT;
  for (let start = 0; start < musicEnd; start += loop) {
    let beat = 0;
    for (const [m, len] of TUNE) {
      const t = start + beat * BEAT, d = len * BEAT * 0.9;
      if (m !== null && t < musicEnd) tone('square', hz(m), t, Math.min(d, musicEnd - t), 0.06 * gainAt(t));
      beat += len;
    }
    BASS.forEach((root, bar) => { for (let e = 0; e < 8; e++) { const t = start + (bar * 4 + e * 0.5) * BEAT; if (t < musicEnd) tone('triangle', hz(root + (e % 2 ? 12 : 0)), t, Math.min(BEAT * 0.45, musicEnd - t), 0.13 * gainAt(t)); } });
  }
  // a soft blip per line of each card
  CFG.sequences.forEach((seq, i) => cardLines(seq.card, 0).forEach((_, li) => tone('square', hz(93 + li * 2), seqStart(i) + li * CFG.card.lineGap, 0.05, 0.025)));
  // the last chord, under the end card's title: A minor
  for (const m of [45, 57, 60, 64, 69]) tone(m === 45 ? 'triangle' : 'square', hz(m), musicEnd, END_DUR - 0.05, m === 45 ? 0.13 : 0.035, 1.2);
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) * 0.6 / peak;                 // moderate: peak at -4.4 dB
  return out;
}
/** The music's level: a little lower under the clips. */
function gainAt(t: number): number { return shotAt(t).kind === 'clip' ? 0.7 : 1; }
function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => { const x = Math.max(-1, Math.min(1, v)) * 32767; data.writeInt16LE(x | 0, i * 4); data.writeInt16LE(x | 0, i * 4 + 2); });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/* ------------------------------------ the logos ------------------------------------ */
// NFC SUMMIT (the design system's logo, chalk on transparency) × SUPERRARE STUDIO (its wordmark, turned chalk on
// transparency), never distorted, a pixel × between them and "present" under them in the pixel font. Full size on the
// opening card; small under the end card's link.
type Logos = { nfc: Image; sr: Image };
async function loadLogos(): Promise<Logos> {
  const [a, b] = CFG.opening.logos;
  return { nfc: await loadImage(await readFile(new URL(a, root))), sr: await loadImage(await readFile(new URL(b, root))) };
}
/** Sizes for an NFC block `h` high: the wordmark at 20 % of it, the ×, the gaps, "present" under them. */
function logoLayout(logos: Logos, h: number): { nfcW: number; srH: number; srW: number; gap: number; p: number; pp: number; w: number; rowH: number; total: number } {
  const nfcW = h * logos.nfc.width / logos.nfc.height, srH = h * 0.2, srW = srH * logos.sr.width / logos.sr.height, gap = h * 0.2;
  const p = Math.max(2, Math.round(h * 0.15 / 7)), pp = Math.max(2, Math.round(h * 0.11 / 7));
  const w = nfcW + gap + 7 * p + gap + srW, rowH = h, total = h + gap * 0.7 + 8 * pp;
  return { nfcW, srH, srW, gap, p, pp, w, rowH, total };
}
/** Pixel-font text at `p` screen pixels per font pixel, chalk, centred on cx, its cap top at y. */
function pixelText(g: ReturnType<ReturnType<typeof createCanvas>['getContext']>, text: string, cx: number, y: number, p: number): void {
  const m = mask(text, 'big'), x0 = Math.round(cx - m.w * p / 2);
  g.fillStyle = paletteJson.chalk as string;
  for (let yy = 0; yy < Math.min(m.h, 9); yy++) for (let xx = 0; xx < m.w; xx++) if (m.bits[yy * m.w + xx]) g.fillRect(x0 + xx * p, Math.round(y) + yy * p, p, p);
}
/** Draws the logo block in the box (x, y, w, h), as large as fits, centred. */
function drawLogos(g: ReturnType<ReturnType<typeof createCanvas>['getContext']>, logos: Logos, x: number, y: number, w: number, h: number): void {
  const unit = logoLayout(logos, 100), nfcH = 100 * Math.min(w / unit.w, h / unit.total), L = logoLayout(logos, nfcH);
  const left = x + (w - L.w) / 2, top = y + (h - L.total) / 2, mid = top + nfcH / 2;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(logos.nfc, Math.round(left), Math.round(top), Math.round(L.nfcW), Math.round(nfcH));
  pixelText(g, '×', left + L.nfcW + L.gap + 3.5 * L.p, mid - 3.5 * L.p, L.p);
  g.drawImage(logos.sr, Math.round(left + L.nfcW + L.gap + 7 * L.p + L.gap), Math.round(mid - L.srH / 2), Math.round(L.srW), Math.round(L.srH));
  pixelText(g, CFG.opening.present, x + w / 2, top + nfcH + L.gap * 0.7, L.pp);
}
/** The opening card: ink and the logo block. */
function openingFrame(PW: number, PH: number, logos: Logos): Uint8ClampedArray {
  const cv = createCanvas(PW, PH), g = cv.getContext('2d');
  g.fillStyle = paletteJson.ink as string; g.fillRect(0, 0, PW, PH);
  const w = PW * 0.8, h = Math.min(PH * 0.42, w);
  drawLogos(g, logos, (PW - w) / 2, (PH - h) / 2, w, h);
  return g.getImageData(0, 0, PW, PH).data;
}
/** The end card with the logo block, small, in the room left for it under the link. */
function withEndLogos(buf: Uint8ClampedArray, W: number, H: number, scale: number, logos: Logos): Uint8ClampedArray {
  const PW = W * scale, PH = H * scale, cv = createCanvas(PW, PH), g = cv.getContext('2d'), img = g.createImageData(PW, PH);
  img.data.set(buf); g.putImageData(img, 0, 0);
  const top = (END_TOP(H) + END_LOGOS.top) * scale, h = END_LOGOS.height * scale, w = Math.min(PW * 0.6, 200 * scale);
  drawLogos(g, logos, (PW - w) / 2, top, w, h);
  return g.getImageData(0, 0, PW, PH).data;
}

/* ------------------------------------ video ------------------------------------- */
// Three frames: 16:9 (the pixel world at 480 × 270, × 4), 9:16 and 1:1 (at 360 × 640 and 360 × 360, × 3).
const FORMATS = { '16x9': { W: 480, H: 270, scale: 4 }, '9x16': { W: 360, H: 640, scale: 3 }, '1x1': { W: 360, H: 360, scale: 3 } } as const;
type Format = keyof typeof FORMATS;
/** One frame of the pixel world (title, end) at time `time`. */
function pixelFrame(time: number, W: number, H: number): Frame | null {
  const s = shotAt(time), f = new Frame(W, H, 'ink');
  if (s.kind === 'title') titleScreen(f, s.t);
  else if (s.kind === 'end') endCard(f, s.t);
  else return null;
  return f;
}
async function renderVideo(format: Format): Promise<void> {
  const { W, H, scale } = FORMATS[format], PW = W * scale, PH = H * scale, name = `teaser-${format}.mp4`;
  const tmp = await mkdtemp(join(tmpdir(), 'teaser-'));
  try {
    const clips = CFG.sequences.map((seq, i) => clipFrames(seq.clip, PW, PH, Math.round(clipDur(i) * FPS)));
    const logos = await loadLogos();
    await writeFile(join(tmp, 'audio.wav'), wav(synth()));
    await mkdir(OUT, { recursive: true });
    const out = join(OUT, name);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${PW}x${PH}`, '-r', String(FPS), '-i', '-',
      '-i', join(tmp, 'audio.wav'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise<void>((resolve, reject) => ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
    for (let k = 0; k < Math.round(TOTAL * FPS); k++) {
      const time = k / FPS, s = shotAt(time);
      let buf: Uint8ClampedArray;
      if (s.kind === 'card') buf = cardFrame((CFG.sequences[s.i] as Sequence).card, s.t, PW, PH);
      else if (s.kind === 'clip') { const frames = clips[s.i] as Uint8ClampedArray[]; buf = frames[Math.min(frames.length - 1, Math.round(s.t * FPS))] as Uint8ClampedArray; }
      else if (s.kind === 'open') buf = openingFrame(PW, PH, logos);
      else if (s.kind === 'end') buf = withEndLogos((pixelFrame(time, W, H) as Frame).rgba(scale), W, H, scale, logos);
      else buf = (pixelFrame(time, W, H) as Frame).rgba(scale);
      if (!ff.stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end(); await done;
    console.log(`${out} (${TOTAL} s, ${PW} × ${PH})`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
async function renderGif(name: string): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'teaser-gif-'));
  try {
    for (let k = 0; k < TITLE_DUR * FPS; k++) {
      const f = pixelFrame(OPEN_DUR + k / FPS, 480, 270) as Frame, cv = createCanvas(960, 540), g = cv.getContext('2d'), img = g.createImageData(960, 540);
      img.data.set(f.rgba(2)); g.putImageData(img, 0, 0); await writeFile(join(tmp, `${String(k).padStart(4, '0')}.png`), cv.toBuffer('image/png'));
    }
    await mkdir(OUT, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(tmp, '%04d.png'),
      '-vf', 'split[a][b];[a]palettegen=max_colors=16:reserve_transparent=0[p];[b][p]paletteuse=dither=none', '-loop', '0', join(OUT, name)]);
    console.log(join(OUT, name));
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/* ------------------------------------ kit stills ------------------------------------ */
async function pngRaw(data: Uint8ClampedArray, PW: number, PH: number, name: string): Promise<void> {
  const cv = createCanvas(PW, PH), g = cv.getContext('2d'), img = g.createImageData(PW, PH); img.data.set(data); g.putImageData(img, 0, 0);
  await mkdir(OUT, { recursive: true }); await writeFile(join(OUT, name), cv.toBuffer('image/png')); console.log(join(OUT, name));
}
/** scene-N.png, 1080 × 1350: the card's line on top, the clip's telling frame under it. */
const STILL_AT = [1.9, 1.2, 2.45, 2.45];
async function sceneStill(i: number): Promise<void> {
  const seq = CFG.sequences[i] as Sequence, PW = 1080, PH = 1350, top = 400;
  const card = cardFrame(seq.card, 3, PW, top);
  const n = Math.round((STILL_AT[i] ?? 2) * FPS) + 1, clip = clipFrames(seq.clip, PW, PH - top, n).at(-1) as Uint8ClampedArray;
  const out = new Uint8ClampedArray(PW * PH * 4); out.set(card, 0); out.set(clip, PW * top * 4);
  await pngRaw(out, PW, PH, `scene-${i + 1}.png`);
}
/** holders.png, 1080 × 1080: the wall, three hearts, the dialogue box. */
async function holders(): Promise<void> {
  const f = new Frame(360, 360, 'ink');
  longWall(f, 0, 300, 5, CFG.plaques.start + 72);
  tree(f, 40, 230, 15); tree(f, 320, 230, 15);
  for (let k = 0; k < 3; k++) {                                     // three hearts, three times the HUD's size
    const x0 = 180 - Math.floor((3 * 33 + 2 * 10) / 2) + k * 43, y0 = 160;
    HEART.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const c = ({ '#': 'ink', b: 'blue', w: 'blueLight' } as Record<string, Colour>)[row[i] as string]; if (c) f.rect(x0 + i * 3, y0 + j * 3, 3, 3, c); } });
  }
  const lines = CFG.holders, bh = 24 + lines.length * 18, x = 6, y = f.h - bh - 6, w = f.w - 12;
  f.rect(x, y, w, bh, 'ink'); f.frameRect(x, y, w, bh, 2, 'chalk');
  lines.forEach((line, i) => f.text(line, x + 12, y + 14 + i * 18, 'big', i === 0 ? 'blue' : 'chalk'));
  await png(f, 3, 'holders.png');
}
async function kit(): Promise<void> {
  const title = new Frame(480, 270, 'ink'); titleScreen(title, 3.4); await png(title, 4, 'title-16x9.png');
  const sq = new Frame(360, 360, 'ink'); titleScreen(sq, 3.4); await png(sq, 3, 'title-1x1.png');
  for (let i = 0; i < CFG.sequences.length; i++) await sceneStill(i);
  const end = new Frame(480, 270, 'ink'); endCard(end, 1); await pngRaw(withEndLogos(end.rgba(4), 480, 270, 4, await loadLogos()), 1920, 1080, 'end-card-16x9.png');
  await holders();
}

const command = argv[0] ?? 'stills';
if (command === 'stills') {
  for (const seq of CFG.sequences) { const len = seq.line.length, cps = cpsFor(seq.line, SCENE_DUR); console.log(`${seq.scene}: ${len} chars at ${cps.toFixed(1)} cps, written by ${(CFG.typing.start + len / cps).toFixed(2)} s`); }
  const title = new Frame(480, 270, 'ink'); titleScreen(title, 3.4); await png(title, 4, 'board-0-title.png');
  for (const [i, seq] of CFG.sequences.entries()) {
    const f = new Frame(480, 270, 'ink'); SCENES[seq.scene](f, STILL_T[seq.scene], seq.line); await png(f, 4, `board-${i + 1}-scene-${i + 1}.png`);
  }
  const end = new Frame(480, 270, 'ink'); endCard(end, 1); await png(end, 4, 'board-5-end.png');
} else if (command === 'video') {
  for (const f of (arg('formats', '16x9') as string).split(',')) await renderVideo(f as Format);
} else if (command === 'kit') {
  await kit();
} else if (command === 'gif') {
  await renderGif('title-assembly.gif');
}
