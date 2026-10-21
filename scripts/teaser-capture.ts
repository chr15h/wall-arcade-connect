// The teaser's flashes (comms/teaser/flashes): after each card, three moments of 0.5 s, full frame, nothing over them.
//
//   unbreakable   the aim / the shot / the bricks of names breaking          (the game stage, recorded)
//   full-row      the piece sliding / the placement / ROW PAINTED            (the game stage, recorded)
//   screens       the game page's top 5 / the leaderboard card / the buy screen / the hub's games / its artists link /
//                 its kit for artists                                        (the real pages, as screens)
//
// The game stages run on the test bench (src/dev/preview.ts: the shipped stage against an in-browser stand-in for the
// coordinator) in Chromium on a virtual clock, 60 frames a second, each moment cropped to 16:9 at 1920 px wide; the
// moves are planned with the very engines the verifier runs. The game page runs with the fake Connect SDK of the dev
// flow (scripts/dev-flow.ts): its scores, wallets and balance are the bench's, never anyone's.
//
//   node --import tsx scripts/teaser-capture.ts [unbreakable,full-row,screens] [--out comms/teaser/flashes]
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import wall from '../src/generated/wall.json' with { type: 'json' };
import { ELIG } from '../src/generated/wall.js';
import { scoringConfiguration } from '../src/shell/config.js';
import { boardCard, type CardEnv, type DragonImage } from '../src/share/card-draw.js';
import { createEngine as createUb, FLOOR, GT, CELL, MAX_ANGLE, MIN_ANGLE, R, type UbState } from '../src/games/unbreakable/engine.js';
import { createEngine as createFr, N, PIECES, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const OUT = arg('out', 'comms/teaser/flashes');
const WHICH = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'unbreakable,full-row,screens').split(',');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_DAY = new Date('2026-10-22T14:00:00Z');       // FULL ROW's names move with the ISO week: the launch week's
const FPS = 60, FLASH_FRAMES = 30;                          // a flash: 0.5 s at 60 fps
const OUT_W = 1920, OUT_H = 1080;

/* ------------------------------------- servers ------------------------------------- */
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.jpg': 'image/jpeg' };
const servers: ReturnType<typeof createServer>[] = [];
/** Serves a folder at its root (the game page reads /config.json); returns its origin. */
async function serve(dir: string): Promise<string> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    let body: Buffer;
    try { body = await readFile(join(dir, path.endsWith('/') ? `${path}index.html` : path)); } catch { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': TYPES[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const browser = await chromium.launch({ executablePath: CHROME });
const shot = (dir: string, f: number): string => join(dir, `${String(f).padStart(4, '0')}.png`);
function encode(dir: string, name: string): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%04d.png'),
    '-vf', `scale=${OUT_W}:${OUT_H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', join(OUT, `${name}.mp4`)]);
  console.log(`${OUT}/${name}.mp4`);
}

/* -------------------------------------- the bench ----------------------------------- */
// The stage laid out 960 css px wide (the canvas draws at device pixel ratio 2): a 16:9 crop of its whole width is
// 1920 × 1080 pixels.
const STAGE_W = 960, STAGE_H = Math.round(STAGE_W * 800 / 420);
let bench = '';
async function openBench(game: 'unbreakable' | 'full-row', seed: number): Promise<Page> {
  if (!bench) { execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-preview.ts'], { stdio: 'inherit' }); bench = await serve('dist/preview'); }
  const page = await browser.newPage({ viewport: { width: STAGE_W + 40, height: STAGE_H + 40 }, deviceScaleFactor: 2 });
  await page.clock.install({ time: LAUNCH_DAY }); await page.clock.pauseAt(new Date(LAUNCH_DAY.getTime() + 100));   // frozen: only runFor moves time
  await page.goto(`${bench}/?game=${game}&seed=${seed}`);
  await page.addStyleTag({ content: `html,body{margin:0;background:#0B0B0B} main{margin:0;padding:0} .eyebrow,#status{display:none!important}
    section.card{margin:0;padding:0;border:0;background:#0B0B0B;width:${STAGE_W}px;height:${STAGE_H}px}` });
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.clock.runFor(3000);                          // fonts settle, the stage lays out, the run starts
  return page;
}
const state = <T>(page: Page): Promise<T> => page.evaluate(() => (window as unknown as { __preview: { state: unknown } }).__preview.state) as Promise<T>;
const send = (page: Page, input: unknown): Promise<void> => page.evaluate((i) => (window as unknown as { __preview: { send(i: unknown): void } }).__preview.send(i), input);
const wait = (page: Page, ms: number): Promise<void> => page.clock.runFor(ms);
async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('#arena canvas').first().boundingBox(); if (!box) throw new Error('no canvas'); return box;
}
/** Logical canvas point → page point. */
async function toPage(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await canvasBox(page); return [box.x + x / 420 * box.width, box.y + y / 800 * box.height];
}
type Window = { name: string; from: number; top: number };      // a flash: 30 frames from `from`, the crop's top in logical px
/** Plays `frames` frames of virtual time; before each, `script(f)` may act; the windows are shot as they pass. */
async function recordWindows(page: Page, frames: number, script: (f: number) => Promise<void>, windows: Window[]): Promise<void> {
  const box = await canvasBox(page), cropH = box.width * 9 / 16;
  for (const w of windows) { await rm(join(OUT, `.${w.name}`), { recursive: true, force: true }); await mkdir(join(OUT, `.${w.name}`), { recursive: true }); }
  let elapsed = 0;
  for (let f = 0; f < frames; f++) {
    await script(f);
    const target = Math.round((f + 1) * 1000 / FPS); await page.clock.runFor(target - elapsed); elapsed = target;
    for (const w of windows) if (f >= w.from && f < w.from + FLASH_FRAMES) {
      const top = Math.max(0, Math.min(800 - 420 * 9 / 16, w.top));
      await page.screenshot({ path: shot(join(OUT, `.${w.name}`), f - w.from), clip: { x: box.x, y: box.y + top / 800 * box.height, width: box.width, height: cropH } });
    }
  }
  for (const w of windows) { encode(join(OUT, `.${w.name}`), w.name); await rm(join(OUT, `.${w.name}`), { recursive: true, force: true }); }
}

/* ------------------------------------- UNBREAKABLE ------------------------------------ */
const ub = createUb(ELIG), UB_CFG = scoringConfiguration('unbreakable');
/** Waits until the stage can aim again (the volley is back and the rows have come down). */
async function ubReady(page: Page): Promise<UbState> {
  for (let k = 0; k < 400; k++) { const s = await state<UbState>(page); if (s.gameOver || s.sim.phase === 0) { await wait(page, 700); return state<UbState>(page); } await wait(page, 100); }
  throw new Error('UNBREAKABLE: the volley never came back');
}
/** Moves the mouse onto an aim line: the stage draws its guide. */
async function ubAim(page: Page, s: UbState, angle: number): Promise<void> {
  // a point on the line, inside the canvas (a pointer that leaves it stops the aim)
  const a = angle / 18000 * Math.PI, c = Math.cos(a), ox = s.sim.originX;
  const d = Math.min(260, c > 0.01 ? (410 - ox) / c : c < -0.01 ? (ox - 10) / -c : 260);
  const [x, y] = await toPage(page, ox + c * d, FLOOR - R - Math.sin(a) * d);
  await page.mouse.move(x, y);
}
/** A run to film: middling volleys pile the names up (no board swept clean), then the turn whose volley breaks the most
 *  bricks within its first 3.2 s. Searched over a few seeds and up to 14 turns with the engine, then replayed on the bench. */
function planVolley(): { seed: number; pre: number[]; angle: number; early: number; bricks: number } {
  const angles = Array.from({ length: 61 }, (_, i) => Math.round(MIN_ANGLE + (MAX_ANGLE - MIN_ANGLE) * i / 60));
  const turn = (s: UbState, angle: number): { s: UbState; broken: number; early: number; over: boolean } => {
    let t = s.tick + 20, x = ub.applyInput(ub.advance(s, t), { action: 'fire', angle }, t), early = -1;
    const b0 = x.sim.broken;
    for (let k = 0; k < 3000 && x.sim.phase === 1 && !x.gameOver; k++) { x = ub.advance(x, ++t); if (k === 64) early = x.sim.broken - b0; }
    return { s: x, broken: x.sim.broken - b0, early: early < 0 ? x.sim.broken - b0 : early, over: x.gameOver || x.sim.phase === 2 };
  };
  const bricks = (s: UbState): number => s.sim.rows.reduce((a, r) => a + r.cells.filter((c) => c && c.t === 1).length, 0);
  let best = { seed: 0, pre: [] as number[], angle: 9000, early: -1, bricks: 0 };
  for (const seed of [4242, 1001, 2026, 31337, 8080]) {
    let s = ub.applyInput(ub.createRun(seed, UB_CFG), { action: 'start' }, 0); const pre: number[] = [];
    for (let k = 0; k < 14; k++) {
      const tries = angles.map((a) => ({ a, r: turn(s, a) })).filter((o) => !o.r.over);
      for (const o of tries) if (o.r.early > best.early || (o.r.early === best.early && bricks(s) > best.bricks)) best = { seed, pre: [...pre], angle: o.a, early: o.r.early, bricks: bricks(s) };
      if (!tries.length) break;
      const pick = tries.sort((p, q) => p.r.broken - q.r.broken)[Math.floor(tries.length * 0.35)] as { a: number; r: { s: UbState } };
      pre.push(pick.a); s = pick.r.s;
    }
  }
  return best;
}
/** When, after the shot, bricks break, and where: per tick, the rows of the bricks gone. */
function breaks(s: UbState, angle: number): { tick: number; rows: number[] }[] {
  const out: { tick: number; rows: number[] }[] = [];
  let t = s.tick, x = ub.applyInput(s, { action: 'fire', angle }, t);
  const posRow = (st: UbState): Map<number, number> => { const m = new Map<number, number>(); st.sim.rows.forEach((row, r) => row.cells.forEach((c) => { if (c && c.t === 1) m.set(c.pos * 100 + r, r); })); return m; };
  for (let k = 1; k < 400 && x.sim.phase === 1; k++) {
    const before = posRow(x), b0 = x.sim.broken; x = ub.advance(x, ++t);
    if (x.sim.broken > b0) { const after = new Set(posRow(x).keys()); out.push({ tick: k, rows: [...before].filter(([key]) => !after.has(key)).map(([, r]) => r) }); }
  }
  return out;
}
async function captureUnbreakable(): Promise<void> {
  const plan = planVolley();
  console.log(`unbreakable: seed ${plan.seed}, ${plan.pre.length} turns first, ${plan.bricks} bricks up, the volley breaks ${plan.early} in 3.2 s`);
  const page = await openBench('unbreakable', plan.seed);
  for (const angle of plan.pre) { await ubReady(page); await send(page, { action: 'fire', angle }); }
  const s = await ubReady(page), FIRE = 30;
  // the 0.5 s with the most bricks breaking (a tick is 3 frames), cropped on their rows
  const bs = breaks(s, plan.angle);
  let bestFrom = FIRE + 30, bestN = -1, rows: number[] = [];
  for (let from = FIRE + 6; from < FIRE + 200; from += 3) {
    const inside = bs.filter((b) => FIRE + b.tick * 3 >= from && FIRE + b.tick * 3 < from + FLASH_FRAMES - 6);
    const n = inside.reduce((a, b) => a + b.rows.length, 0);
    if (n > bestN) { bestN = n; bestFrom = from; rows = inside.flatMap((b) => b.rows); }
  }
  const cy = rows.length ? GT + (rows.reduce((a, r) => a + r, 0) / rows.length + 0.5) * CELL : 300;
  console.log(`unbreakable: ${bestN} bricks break in the flash from frame ${bestFrom}`);
  await recordWindows(page, bestFrom + FLASH_FRAMES, async (f) => {
    // the aim sweeps across the field (the guide runs to its first bounce), then settles on the shot
    const sweep: Record<number, number> = { 0: 14500, 6: 13000, 12: 11500, 18: 10000, 24: plan.angle };
    if (sweep[f] !== undefined) await ubAim(page, s, Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, sweep[f] as number)));
    if (f === FIRE) await send(page, { action: 'fire', angle: plan.angle });
  }, [
    { name: 'unbreakable-aim', from: 0, top: FLOOR + 40 - 420 * 9 / 16 },
    { name: 'unbreakable-fire', from: FIRE - 2, top: FLOOR - 160 },
    { name: 'unbreakable-break', from: bestFrom, top: cy - 420 * 9 / 32 },
  ]);
  await page.close();
}

/* --------------------------------------- FULL ROW -------------------------------------- */
const fr = createFr(), FR_CFG = scoringConfiguration('full-row');
type Move = { slot: number; x: number; y: number };
const movesOf = (s: FrState): Move[] => {
  const out: Move[] = [];
  s.play.hand.forEach((id, slot) => { if (id < 0) return; const p = PIECES[id] as Piece; for (let y = 0; y <= N - p.h; y++) for (let x = 0; x <= N - p.w; x++) if (fits(s.play.rows, p, x, y)) out.push({ slot, x, y }); });
  return out;
};
const play = (s: FrState, m: Move): FrState => fr.applyInput(s, { action: 'place', ...m }, s.tick);
/** The shortest sequence (≤ 6 moves, beam search on the fullest row) that completes a line, from the run's start. */
function planRow(seed: number): Move[] {
  let s = fr.createRun(seed, FR_CFG); s = fr.applyInput(s, { action: 'start' }, 0);
  type Node = { s: FrState; path: Move[] };
  let beam: Node[] = [{ s, path: [] }];
  for (let depth = 0; depth < 6; depth++) {
    const next: (Node & { v: number })[] = [];
    for (const node of beam) for (const m of movesOf(node.s)) {
      const piece = PIECES[node.s.play.hand[m.slot] as number] as Piece, r = evaluatePlacement(node.s.play.rows, node.s.play.combo, piece, m.x, m.y);
      const after = play(node.s, m), path = [...node.path, m];
      if (r.lines > 0 && path.length >= 4) return path;                 // a few pieces already on the grid: names around the row
      const fullest = Math.max(...after.play.rows.map((row) => { let n = 0; for (let i = 0; i < N; i++) n += (row >> i) & 1; return n; }));
      next.push({ s: after, path, v: fullest * 10 + (r.lines ? -50 : 0) - Math.abs(m.y - 7) });
    }
    next.sort((a, b) => b.v - a.v); beam = next.slice(0, 60);
  }
  throw new Error(`FULL ROW: no line within 6 moves for seed ${seed}`);
}
/** A mouse drag of the piece in `slot` onto (x, y): pressed on the tray, moved in `steps` equal steps, released. */
async function dragger(page: Page, s: FrState, m: Move, steps: number): Promise<{ down(): Promise<void>; step(k: number): Promise<void>; up(): Promise<void> }> {
  const piece = PIECES[s.play.hand[m.slot] as number] as Piece;
  const [sx, sy] = await toPage(page, m.slot * 140 + 70, 650);
  const [tx, ty] = await toPage(page, 18 + m.x * 48 + piece.w * 48 / 2, 100 + m.y * 48 + piece.h * 48 / 2);
  return {
    down: async () => { await page.mouse.move(sx, sy); await page.mouse.down(); },
    step: (k) => page.mouse.move(sx + (tx - sx) * k / steps, sy + (ty - sy) * k / steps),
    up: () => page.mouse.up(),
  };
}
async function captureFullRow(): Promise<void> {
  const seed = 5150, plan = planRow(seed), last = plan.at(-1) as Move;
  const page = await openBench('full-row', seed);
  for (const m of plan.slice(0, -1)) {
    const d = await dragger(page, await state<FrState>(page), m, 4);
    await d.down(); for (let k = 1; k <= 4; k++) { await d.step(k); await wait(page, 16); } await d.up(); await wait(page, 350);
  }
  const s = await state<FrState>(page), d = await dragger(page, s, last, 30), DOWN = 6, UP = DOWN + 31;
  const target = 100 + last.y * 48;
  console.log(`full-row: ${plan.length} pieces, the last completes a line at row ${last.y + 1}`);
  await recordWindows(page, UP + 50, async (f) => {
    if (f === DOWN) await d.down();
    else if (f > DOWN && f < UP) await d.step(f - DOWN);
    if (f === UP) await d.up();
  }, [
    { name: 'full-row-slide', from: DOWN + 2, top: 640 - 420 * 9 / 16 + 30 },
    { name: 'full-row-place', from: UP - 26, top: target + 24 - 420 * 9 / 32 },
    { name: 'full-row-painted', from: UP + 12, top: 96 },
  ]);
  await page.close();
}

/* ---------------------------------------- screens --------------------------------------- */
/** A page shot at 16:9: the viewport itself, or a box of `width` css px centred on an element, at 1920 px wide. */
async function screen(url: string, name: string, opts: { width?: number; around?: string; top?: string; before?: (page: Page) => Promise<void> } = {}): Promise<void> {
  const width = opts.width ?? 1280, page = await browser.newPage({ viewport: { width: Math.max(1280, width), height: 900 }, deviceScaleFactor: OUT_W / width });
  await page.goto(url);
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  await opts.before?.(page);
  await page.waitForTimeout(600);
  const h = width * 9 / 16;
  if (opts.around) {
    const el = page.locator(opts.around).first(); await el.scrollIntoViewIfNeeded();
    await page.evaluate((sel) => { const e = document.querySelector(sel); if (e) window.scrollBy(0, e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2 - window.innerHeight / 2); }, opts.around);
    await page.waitForTimeout(300);
    const box = await el.boundingBox(); if (!box) throw new Error(`${name}: ${opts.around} not shown`);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: Math.max(0, cx - width / 2), y: Math.max(0, cy - h / 2), width, height: h } });
  } else if (opts.top) {                                  // the box's top on the element's top, centred across
    const el = page.locator(opts.top).first(); await el.scrollIntoViewIfNeeded();
    await page.evaluate((sel) => { const e = document.querySelector(sel); if (e) window.scrollBy(0, e.getBoundingClientRect().top - 24); }, opts.top);
    await page.waitForTimeout(300);
    const box = await el.boundingBox(); if (!box) throw new Error(`${name}: ${opts.top} not shown`);
    await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: Math.max(0, box.x + box.width / 2 - width / 2), y: Math.max(0, box.y - 24), width, height: h } });
  } else await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width, height: h } });
  console.log(`${OUT}/${name}.png`);
  await page.close();
}
/** The leaderboard card of FULL ROW, drawn by the card service's own code, cropped 16:9 on its rows and the rank line.
 *  The rows are the test bench's (fake Connect): two wallets, the first one as "me". */
async function leaderboardCard(): Promise<void> {
  GlobalFonts.register(await readFile('cards/assets/Anton-400.ttf'), 'WallCard Anton');
  GlobalFonts.register(await readFile('cards/assets/IBMPlexMono-400.ttf'), 'WallCard Mono');
  GlobalFonts.register(await readFile('cards/assets/IBMPlexMono-500.ttf'), 'WallCard Mono');
  const dragon = await loadImage(await readFile('cards/assets/dragon.jpg')) as unknown as DragonImage;
  const env: CardEnv = { createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement };
  const fake = await readFile('src/dev/fake-connect.ts', 'utf8');
  const rows = [...fake.matchAll(/\{ name: '(0x[0-9a-f]{40})', score: (\d+) \}/g)].map((m, i) => ({ rank: i + 1, name: `${(m[1] as string).slice(0, 6)}…${(m[1] as string).slice(-4)}`, score: Number(m[2]), me: i === 0 }));
  const card = boardCard(env, { game: 'FULL ROW', url: 'https://yfq52eu3.srstudio.dev/', wallNames: wall.positions.map((p) => p.n), dragon }, { rows, caption: 'SERVER-VERIFIED · ALL TIME' });
  const crop = createCanvas(1080, 608), g = crop.getContext('2d');
  g.drawImage(card as unknown as Parameters<typeof g.drawImage>[0], 0, -296);
  await writeFile(join(OUT, 'card.png'), crop.toBuffer('image/png'));
  console.log(`${OUT}/card.png`);
}
async function captureScreens(): Promise<void> {
  // the game page with the fake Connect SDK (scripts/dev-flow.ts), signed in, no credits
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-flow.ts', 'dist/teaser-game', 'full-row'], { stdio: 'inherit' });
  const game = await serve('dist/teaser-game');
  await screen(`${game}/?signed=1&credits=0`, 'board', { width: 760, around: '#overlay-board' });
  await screen(`${game}/?signed=1&credits=0`, 'buy', { width: 760, around: '#buy-panel .panel-body', before: async (page) => {
    await page.evaluate(() => (document.getElementById('buy-panel') as HTMLDialogElement | null)?.showModal());
  } });
  await leaderboardCard();
  // the hub, with the wall of the snapshot in its grid
  const rows = Array.from({ length: 550 }, (_, i) => wall.positions.find((p) => p.p === i + 1)?.n ?? 0);
  const html = (await readFile('hub/src.html', 'utf8')).replace(/\/\*SNAPSHOT:START\*\/.*?\/\*SNAPSHOT:END\*\//s, () => `/*SNAPSHOT:START*/${JSON.stringify(rows)}/*SNAPSHOT:END*/`);
  await mkdir('dist/teaser-hub', { recursive: true });
  await writeFile('dist/teaser-hub/index.html', html); await copyFile('hub/dragon.jpg', 'dist/teaser-hub/dragon.jpg');
  const hub = await serve('dist/teaser-hub');
  await screen(`${hub}/`, 'hub-games', { width: 1280, top: '#games' });
  await screen(`${hub}/`, 'hub-artists', { width: 440, around: '.cta-row a.link-u' });
  await screen(`${hub}/`, 'hub-kit', { width: 1280, around: '#how .steps' });
}

await mkdir(OUT, { recursive: true });
try {
  if (WHICH.includes('unbreakable')) await captureUnbreakable();
  if (WHICH.includes('full-row')) await captureFullRow();
  if (WHICH.includes('screens')) await captureScreens();
} finally { await browser.close(); for (const s of servers) s.close(); }
