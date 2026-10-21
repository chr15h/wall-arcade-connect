// The teaser's clips (comms/teaser/clips): after each card, one extract of 2.5 s, the whole game screen, uncropped,
// portrait, recorded at 60 frames a second, 1920 px high:
//
//   unbreakable   an aim, then the volley bouncing and breaking bricks of names         (the game stage)
//   full-row      a piece dragged and placed, the row completes, ROW PAINTED            (the game stage)
//   full-row-jackpot  the FULL ROW clip with the band JACKPOT OF THE WEEK (Anton, chalk on blue) from 0.5 s
//
// The game stages run on the test bench (src/dev/preview.ts: the shipped stage against an in-browser stand-in for the
// coordinator) in Chromium on a virtual clock; the moves are planned with the very engines the verifier runs.
//
//   node --import tsx scripts/teaser-capture.ts [unbreakable,full-row,full-row-jackpot] [--out comms/teaser/clips]
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { ELIG } from '../src/generated/wall.js';
import { scoringConfiguration } from '../src/shell/config.js';
import { createEngine as createUb, FLOOR, GT, CELL, MAX_ANGLE, MIN_ANGLE, R, type UbState } from '../src/games/unbreakable/engine.js';
import { createEngine as createFr, N, PIECES, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const OUT = arg('out', 'comms/teaser/clips');
const WHICH = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'unbreakable,full-row,full-row-jackpot').split(',');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_DAY = new Date('2026-10-22T14:00:00Z');       // FULL ROW's names move with the ISO week: the launch week's
const FPS = 60, CLIP_FRAMES = 150;                          // a clip: 2.5 s at 60 fps
const CLIP_H = 1920;                                         // every clip 1920 px high, its own width

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
    '-vf', `scale=-2:${CLIP_H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', join(OUT, `${name}.mp4`)]);
  console.log(`${OUT}/${name}.mp4`);
}

/* -------------------------------------- the bench ----------------------------------- */
// The stage laid out 504 × 960 css px at device pixel ratio 2 (the canvas draws at 2 too): 1008 × 1920 pixels.
const STAGE_W = 504, STAGE_H = 960;
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
/** Records the whole stage for CLIP_FRAMES frames of virtual time; before each frame, `script(f)` may act. */
async function recordClip(page: Page, name: string, script: (f: number) => Promise<void>): Promise<void> {
  const dir = join(OUT, `.${name}`), arena = page.locator('#arena');
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  let elapsed = 0;
  for (let f = 0; f < CLIP_FRAMES; f++) {
    await script(f);
    const target = Math.round((f + 1) * 1000 / FPS); await page.clock.runFor(target - elapsed); elapsed = target;
    await arena.screenshot({ path: shot(dir, f) });
  }
  encode(dir, name); await rm(dir, { recursive: true, force: true });
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
 *  bricks within its first `earlyTicks` ticks. Searched over a few seeds and up to 14 turns with the engine, then replayed on the bench. */
function planVolley(earlyTicks: number): { seed: number; pre: number[]; angle: number; early: number; bricks: number } {
  const angles = Array.from({ length: 61 }, (_, i) => Math.round(MIN_ANGLE + (MAX_ANGLE - MIN_ANGLE) * i / 60));
  const turn = (s: UbState, angle: number): { s: UbState; broken: number; early: number; over: boolean } => {
    let t = s.tick + 20, x = ub.applyInput(ub.advance(s, t), { action: 'fire', angle }, t), early = -1;
    const b0 = x.sim.broken;
    for (let k = 0; k < 3000 && x.sim.phase === 1 && !x.gameOver; k++) { x = ub.advance(x, ++t); if (k === earlyTicks) early = x.sim.broken - b0; }
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
async function captureUnbreakable(): Promise<void> {
  const FIRE = 40, plan = planVolley(Math.floor((CLIP_FRAMES - FIRE) / 3) - 2);   // a tick is 3 frames
  console.log(`unbreakable: seed ${plan.seed}, ${plan.pre.length} turns first, ${plan.bricks} bricks up, the volley breaks ${plan.early} in the clip`);
  const page = await openBench('unbreakable', plan.seed);
  for (const angle of plan.pre) { await ubReady(page); await send(page, { action: 'fire', angle }); }
  const s = await ubReady(page);
  // the aim sweeps across the field (the guide runs to its first bounce), settles on the shot, fires
  const sweep: Record<number, number> = { 0: 14500, 8: 13000, 16: 11500, 24: 10000, 32: plan.angle };
  await recordClip(page, 'unbreakable', async (f) => {
    if (sweep[f] !== undefined) await ubAim(page, s, Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, sweep[f] as number)));
    if (f === FIRE) await send(page, { action: 'fire', angle: plan.angle });
  });
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
  const d = await dragger(page, await state<FrState>(page), last, 34), DOWN = 8, UP = DOWN + 35;
  console.log(`full-row: ${plan.length} pieces, the last completes a line at row ${last.y + 1}`);
  await recordClip(page, 'full-row', async (f) => {
    if (f === DOWN) await d.down();
    else if (f > DOWN && f < UP) await d.step(f - DOWN);
    if (f === UP) await d.up();
  });
  await page.close();
}

/* ------------------------------------- the jackpot band ------------------------------------- */
/** The FULL ROW clip with the week's jackpot: a band at the bottom, Anton in chalk on blue, from 0.5 s on. */
async function buildFullRowJackpot(): Promise<void> {
  GlobalFonts.register(await readFile('cards/assets/Anton-400.ttf'), 'WallCard Anton');
  const config = JSON.parse(await readFile('comms/teaser/teaser.config.json', 'utf8')) as { jackpot: string };
  const src = join(OUT, 'full-row.mp4'), raw = join(OUT, '.jackpot-src'), dir = join(OUT, '.jackpot');
  for (const d of [raw, dir]) { await rm(d, { recursive: true, force: true }); await mkdir(d, { recursive: true }); }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, join(raw, '%04d.png')]);
  for (let f = 0; f < CLIP_FRAMES; f++) {
    const frame = await loadImage(await readFile(join(raw, `${String(f + 1).padStart(4, '0')}.png`)));
    const W = frame.width, H = frame.height, cv = createCanvas(W, H), g = cv.getContext('2d');
    g.drawImage(frame, 0, 0, W, H);
    if (f >= FPS / 2) {
      const band = Math.round(H * 0.11), m = Math.round(W * 0.05);
      g.fillStyle = '#2E7FD6'; g.fillRect(0, H - band, W, band);
      g.font = '100px "WallCard Anton"'; const size = Math.min(band * 0.62, 100 * (W - 2 * m) / g.measureText(config.jackpot).width);
      g.font = `${size}px "WallCard Anton"`; g.fillStyle = '#F2F0EB'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(config.jackpot, W / 2, H - band / 2 + size * 0.04);
    }
    await writeFile(shot(dir, f), cv.toBuffer('image/png'));
  }
  encode(dir, 'full-row-jackpot');
  for (const d of [raw, dir]) await rm(d, { recursive: true, force: true });
}

await mkdir(OUT, { recursive: true });
try {
  if (WHICH.includes('unbreakable')) await captureUnbreakable();
  if (WHICH.includes('full-row')) await captureFullRow();
  if (WHICH.includes('full-row-jackpot')) await buildFullRowJackpot();
} finally { await browser.close(); for (const s of servers) s.close(); }
