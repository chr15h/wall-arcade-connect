// The hub's game clips (hub/clips/<game>.mp4): 10 seconds of a real run on the test bench (src/dev/preview.ts: the
// shipped stage against an in-browser stand-in for the coordinator), on a virtual clock, 30 frames a second; muted
// H.264, cropped to the 4:3 window the hub's game cards show (the same crop as hub/shots/<game>.jpg, their posters).
//
//   unbreakable   a few volleys first, then an aim and the volley that paints the most bricks within the clip
//   full-row      the pieces dragged onto the grid one by one; the last completes a line: the clip ends on ROW PAINTED
//   nft-invaders  wave 1 filmed: the Nouns sway and dive, the dragon sprays them down
//   cc0-invaders  wave 1 filmed: the Nouns sway and dive
//   signage       a crowd already on the plaza; signs go up under the newcomers and the people of the wall walk home
// The two newer games also write their poster, hub/shots/<game>.jpg: the clip's middle frame, whole stage.
//
//   node --import tsx scripts/capture-hub-clips.ts [unbreakable,full-row,nft-invaders,cc0-invaders,signage]   (Chrome: CHROME_PATH or the usual paths)
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { ELIG } from '../src/generated/wall.js';
import { scoringConfiguration } from '../src/shell/config.js';
import { createEngine as createUb, FLOOR, MAX_ANGLE, MIN_ANGLE, R, type UbState } from '../src/games/unbreakable/engine.js';
import { createEngine as createFr, N, PIECES, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';

const OUT = 'hub/clips';
const WHICH = (process.argv[2] ?? 'unbreakable,full-row').split(',');
const FPS = 30, FRAMES = 10 * FPS;
// the stage 504 × 960 css px at 1080 / 960: 567 × 1080 frames, as the hub's screenshots; the card shows a 4:3 window of
// it, its top at 22% of the spare height (object-position: center 22%): 567 × 425 from y = 144, rounded to even sizes
const STAGE_W = 504, STAGE_H = 960, DPR = 1080 / STAGE_H;
const CROP = 'crop=566:424:0:144';
const CHROMES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean) as string[];
const LAUNCH_DAY = new Date('2026-10-22T14:00:00Z');       // FULL ROW's names move with the ISO week: the launch week's

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };
async function serve(dir: string): Promise<{ origin: string; close(): void }> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    let body: Buffer;
    try { body = await readFile(join(dir, path.endsWith('/') ? `${path}index.html` : path)); } catch { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': TYPES[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

const executablePath = CHROMES.find((path) => existsSync(path));
if (!executablePath) throw new Error('No Chrome found: set CHROME_PATH');
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-preview.ts'], { stdio: 'ignore' });
const bench = await serve('dist/preview');
const browser = await chromium.launch({ executablePath });
await mkdir(OUT, { recursive: true });

async function openBench(game: 'unbreakable' | 'full-row' | 'whitewash' | 'cc0-invaders' | 'signage', seed: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: STAGE_W, height: STAGE_H }, deviceScaleFactor: DPR });
  // a returning player: no first-game hints in the clip
  await page.addInitScript(() => { for (const g of ['unbreakable', 'full-row', 'whitewash', 'signage']) localStorage.setItem(`wall-arcade:${g}:hint`, '1'); });
  await page.clock.install({ time: LAUNCH_DAY }); await page.clock.pauseAt(new Date(LAUNCH_DAY.getTime() + 100));   // frozen: only runFor moves time
  await page.goto(`${bench.origin}/?game=${game}&seed=${seed}`);
  await page.addStyleTag({ content: `html,body{margin:0;background:#DEDBD3} main{margin:0;padding:0} .eyebrow,#status,.ub-sound{display:none!important}
    section.card{margin:0;padding:0;border:0;width:${STAGE_W}px;height:${STAGE_H}px;display:flex;align-items:center;justify-content:center}` });
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.clock.runFor(3000);                          // fonts settle, the stage lays out, the run starts
  return page;
}
const state = <T>(page: Page): Promise<T> => page.evaluate(() => (window as unknown as { __preview: { state: unknown } }).__preview.state) as Promise<T>;
const send = (page: Page, input: unknown): Promise<void> => page.evaluate((i) => (window as unknown as { __preview: { send(i: unknown): void } }).__preview.send(i), input);
const wait = (page: Page, ms: number): Promise<void> => page.clock.runFor(ms);
/** Canvas logical coordinates (420 × 800) → page coordinates. */
async function toPage(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await page.locator('#arena canvas').first().boundingBox(); if (!box) throw new Error('no canvas');
  return [box.x + x / 420 * box.width, box.y + y / 800 * box.height];
}

/** Records FRAMES frames of virtual time; before each frame, `script(f)` may act. Encodes the 4:3 window (and, with
 *  `poster`, writes that frame, whole stage, as hub/shots/<name>.jpg). */
async function record(page: Page, name: string, script: (f: number) => Promise<void>, poster?: number, crop = CROP): Promise<void> {
  const dir = join(OUT, `.${name}`), arena = page.locator('#arena');
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  let elapsed = 0;
  for (let f = 0; f < FRAMES; f++) {
    await script(f);
    const target = Math.round((f + 1) * 1000 / FPS); await page.clock.runFor(target - elapsed); elapsed = target;
    await arena.screenshot({ path: join(dir, `${String(f).padStart(4, '0')}.png`) });
  }
  if (poster !== undefined) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, `${String(poster).padStart(4, '0')}.png`), '-q:v', '4', join('hub/shots', `${name}.jpg`)]);
    console.log(`hub/shots/${name}.jpg: ${(statSync(join('hub/shots', `${name}.jpg`)).size / 1024).toFixed(0)} KB`);
  }
  const file = join(OUT, `${name}.mp4`);
  for (const crf of [26, 29, 32]) {                       // light: under 1.5 MB
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%04d.png'), '-vf', crop,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', file]);
    if (statSync(file).size < 1.5 * 1024 * 1024) break;
  }
  await rm(dir, { recursive: true, force: true });
  console.log(`${file}: ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

/* ------------------------------------- UNBREAKABLE ------------------------------------ */
const ub = createUb(ELIG), UB_CFG = scoringConfiguration('unbreakable');
async function ubReady(page: Page): Promise<UbState> {
  for (let k = 0; k < 400; k++) { const s = await state<UbState>(page); if (s.gameOver || s.sim.phase === 0) { await wait(page, 700); return state<UbState>(page); } await wait(page, 100); }
  throw new Error('UNBREAKABLE: the volley never came back');
}
async function ubAim(page: Page, s: UbState, angle: number): Promise<void> {
  const a = angle / 18000 * Math.PI, c = Math.cos(a), ox = s.sim.originX;
  const d = Math.min(260, c > 0.01 ? (410 - ox) / c : c < -0.01 ? (ox - 10) / -c : 260);
  const [x, y] = await toPage(page, ox + c * d, FLOOR - R - Math.sin(a) * d);
  await page.mouse.move(x, y);
}
/** Middling volleys first (names piled up), then the turn whose volley paints the most bricks within `ticks` ticks. */
function planVolley(ticks: number): { seed: number; pre: number[]; angle: number; early: number } {
  const angles = Array.from({ length: 61 }, (_, i) => Math.round(MIN_ANGLE + (MAX_ANGLE - MIN_ANGLE) * i / 60));
  const turn = (s: UbState, angle: number): { s: UbState; broken: number; early: number; over: boolean } => {
    let t = s.tick + 20, x = ub.applyInput(ub.advance(s, t), { action: 'fire', angle }, t), early = -1;
    const b0 = x.sim.broken;
    for (let k = 0; k < 3000 && x.sim.phase === 1 && !x.gameOver; k++) { x = ub.advance(x, ++t); if (k === ticks) early = x.sim.broken - b0; }
    return { s: x, broken: x.sim.broken - b0, early: early < 0 ? x.sim.broken - b0 : early, over: x.gameOver || x.sim.phase === 2 };
  };
  let best = { seed: 0, pre: [] as number[], angle: 9000, early: -1 };
  for (const seed of [4242, 1001, 2026, 31337, 8080]) {
    let s = ub.applyInput(ub.createRun(seed, UB_CFG), { action: 'start' }, 0); const pre: number[] = [];
    for (let k = 0; k < 10; k++) {
      const tries = angles.map((a) => ({ a, r: turn(s, a) })).filter((o) => !o.r.over);
      for (const o of tries) if (o.r.early > best.early) best = { seed, pre: [...pre], angle: o.a, early: o.r.early };
      if (!tries.length) break;
      const pick = tries.sort((p, q) => p.r.broken - q.r.broken)[Math.floor(tries.length * 0.35)] as { a: number; r: { s: UbState } };
      pre.push(pick.a); s = pick.r.s;
    }
  }
  return best;
}
async function clipUnbreakable(): Promise<void> {
  const FIRE = 36, plan = planVolley(Math.floor((FRAMES - FIRE) * 20 / FPS) - 4);   // 20 ticks a second
  console.log(`unbreakable: seed ${plan.seed}, ${plan.pre.length} volleys first, the filmed volley paints ${plan.early} bricks`);
  const page = await openBench('unbreakable', plan.seed);
  for (const angle of plan.pre) { await ubReady(page); await send(page, { action: 'fire', angle }); }
  const s = await ubReady(page);
  const sweep: Record<number, number> = { 0: 14000, 9: 12500, 18: 11000, 27: plan.angle };
  await record(page, 'unbreakable', async (f) => {
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
const playMove = (s: FrState, m: Move): FrState => fr.applyInput(s, { action: 'place', ...m }, s.tick);
/** The shortest sequence of 4 to 6 moves (beam search on the fullest row) that completes a line, from the start. */
function planRow(seed: number): Move[] {
  const s = fr.applyInput(fr.createRun(seed, FR_CFG), { action: 'start' }, 0);
  type Node = { s: FrState; path: Move[] };
  let beam: Node[] = [{ s, path: [] }];
  for (let depth = 0; depth < 6; depth++) {
    const next: (Node & { v: number })[] = [];
    for (const node of beam) for (const m of movesOf(node.s)) {
      const piece = PIECES[node.s.play.hand[m.slot] as number] as Piece, r = evaluatePlacement(node.s.play.rows, node.s.play.combo, piece, m.x, m.y);
      const after = playMove(node.s, m), path = [...node.path, m];
      if (r.lines > 0 && path.length >= 4) return path;
      const fullest = Math.max(...after.play.rows.map((row) => { let n = 0; for (let i = 0; i < N; i++) n += (row >> i) & 1; return n; }));
      next.push({ s: after, path, v: fullest * 10 + (r.lines ? -50 : 0) - Math.abs(m.y - 4) });
    }
    next.sort((a, b) => b.v - a.v); beam = next.slice(0, 60);
  }
  throw new Error(`FULL ROW: no line within 6 moves for seed ${seed}`);
}
async function clipFullRow(): Promise<void> {
  const seed = 5150, plan = planRow(seed);
  console.log(`full-row: ${plan.length} pieces, the last completes a line`);
  const page = await openBench('full-row', seed);
  // the drags, spread over the clip; the last piece lands 0.7 s before the end: the clip ends on ROW PAINTED
  const STEPS = 18, LAST_UP = FRAMES - Math.round(0.7 * FPS) - 1;
  const gap = Math.floor((LAST_UP - 6) / plan.length);
  const starts = plan.map((_, i) => LAST_UP - STEPS - (plan.length - 1 - i) * gap);
  let drag: { sx: number; sy: number; tx: number; ty: number } | null = null, moveIndex = -1;
  await record(page, 'full-row', async (f) => {
    const i = starts.indexOf(f);
    if (i >= 0) {
      const s = await state<FrState>(page), m = plan[i] as Move, piece = PIECES[s.play.hand[m.slot] as number] as Piece;
      const [sx, sy] = await toPage(page, m.slot * 140 + 70, 650);
      const [tx, ty] = await toPage(page, 18 + m.x * 48 + piece.w * 48 / 2, 100 + m.y * 48 + piece.h * 48 / 2);
      drag = { sx, sy, tx, ty }; moveIndex = i;
      await page.mouse.move(sx, sy); await page.mouse.down();
      return;
    }
    if (drag && moveIndex >= 0) {
      const k = f - (starts[moveIndex] as number);
      if (k > 0 && k <= STEPS) await page.mouse.move(drag.sx + (drag.tx - drag.sx) * k / STEPS, drag.sy + (drag.ty - drag.sy) * k / STEPS);
      if (k === STEPS + 1) { await page.mouse.up(); drag = null; }
    }
  });
  await page.close();
}

/* ------------------------------------ NFT INVADERS ------------------------------------ */
// A player who follows the lowest diver, else the raider nearest its column: a move every 3 ticks at most.
type Ww = { gameOver: boolean; play: { x: number; target: number; wave: number; waveAt: number; cleaners: { x: number; y: number; mode: number }[] } };
async function wwPlay(page: Page): Promise<void> {
  const s = await state<Ww>(page), p = s.play;
  if (s.gameOver) return;
  const diver = p.cleaners.filter((c) => c.mode === 1).sort((a, b) => b.y - a.y)[0];
  const aim = diver ?? [...p.cleaners].sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
  if (aim && Math.abs(aim.x - p.target) > 3) await send(page, { action: 'move', x: Math.max(0, Math.min(420, Math.round(aim.x))) });
}
/** An invader game filmed on wave `wave` (the waves before it played off camera). */
async function clipInvaders(game: 'whitewash' | 'cc0-invaders', name: string, wave: number): Promise<void> {
  for (const seed of [12, 77, 2026, 31337, 4242]) {
    const page = await openBench(game, seed);
    let ok = false;
    for (let k = 0; k < 900; k++) {
      const s = await state<Ww>(page);
      if (s.gameOver) break;
      if (s.play.wave === wave && s.play.waveAt < 0) { ok = true; break; }
      await wwPlay(page); await wait(page, 150);
    }
    if (!ok) { await page.close(); console.log(`${name}: seed ${seed} did not reach wave ${wave}, next seed`); continue; }
    await wait(page, 600);
    console.log(`${name}: seed ${seed}, filming wave ${wave}`);
    await record(page, name, async (f) => { if (f % 5 === 0) await wwPlay(page); }, Math.round(FRAMES * 0.12));   // the poster: the formation still whole
    await page.close();
    return;
  }
  throw new Error(`${name}: no seed reached wave ${wave}`);
}

/* -------------------------------------- SIGNAGE --------------------------------------- */
// A careful player who steers in the middle rows (the hub card's 4:3 window shows the top of the plaza): a walker
// reaching row 6 gets a sign towards its column there; on its column, a sign up.
type Sg = { gameOver: boolean; play: { signs: [number, number][]; walkers: { x: number; y: number; dir: number; to: number }[] } };
async function sgPlay(page: Page): Promise<void> {
  const s = await state<Sg>(page);
  if (s.gameOver) return;
  const signAt = (x: number, y: number): number => s.play.signs.find((g) => g[0] === y * 8 + x)?.[1] ?? -1;
  for (const w of s.play.walkers) {
    const want = w.x === w.to ? 0 : (w.to > w.x ? 1 : 3), head = signAt(w.x, w.y) >= 0 ? signAt(w.x, w.y) : w.dir;
    if ((w.y === 6 || w.x === w.to) && w.y <= 6 && head !== want) { await send(page, { action: 'sign', x: w.x, y: w.y, dir: want }); return; }
  }
}
async function clipSignage(): Promise<void> {
  const page = await openBench('signage', 4242);
  for (let k = 0; k < 900; k++) { await sgPlay(page); await wait(page, 100); }     // 90 s: walkers come every 2 s, a crowd on the plaza
  console.log('signage: seed 4242, filming after 90 s of play');
  // the whole board (wall, plaza, street) fitted in the 4:3 card on the concrete: the top slice alone would miss the play
  const WHOLE = 'crop=567:800:0:120,pad=1066:800:249:0:0xDEDBD3,scale=566:424';
  await record(page, 'signage', async (f) => { if (f % 3 === 0) await sgPlay(page); }, Math.round(FRAMES * 0.6), WHOLE);
  await page.close();
}

try {
  if (WHICH.includes('unbreakable')) await clipUnbreakable();
  if (WHICH.includes('full-row')) await clipFullRow();
  if (WHICH.includes('nft-invaders')) await clipInvaders('whitewash', 'nft-invaders', 1);      // the Nouns, its first wave
  if (WHICH.includes('cc0-invaders')) await clipInvaders('cc0-invaders', 'cc0-invaders', 1);     // the Nouns
  if (WHICH.includes('signage')) await clipSignage();
} finally { await browser.close(); bench.close(); }
