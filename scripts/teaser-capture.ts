// The teaser's gameplay inserts: real recordings of the shipped game stages on the test bench (src/dev/preview.ts, the
// stage against an in-browser stand-in for the coordinator), 4 s at 60 fps, 1080 px high. Chromium runs on a virtual
// clock: the page advances exactly 1/60 s between two screenshots, so the recording is smooth whatever the machine.
// The moves are planned with the very engines the verifier runs, so each clip shows a readable moment:
//
//   unbreakable       a volley that breaks several bricks of names
//   full-row          a placement that completes a row: the ROW PAINTED moment
//   full-row-end      the last pieces of a run, NO PIECE FITS ANY MORE, the end screen
//   unbreakable-end   the last volley of a run and the "I bounced off" end screen
//
//   node --import tsx scripts/teaser-capture.ts [unbreakable,full-row,full-row-end,unbreakable-end] [--out comms/teaser/clips]
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { ELIG } from '../src/generated/wall.js';
import { scoringConfiguration } from '../src/shell/config.js';
import { createEngine as createUb, FLOOR, MAX_ANGLE, MIN_ANGLE, R, type UbState } from '../src/games/unbreakable/engine.js';
import { createEngine as createFr, N, PIECES, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] ?? fallback : fallback; };
const OUT = arg('out', 'comms/teaser/clips');
const WHICH = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'unbreakable,full-row,full-row-end,unbreakable-end').split(',');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LAUNCH_DAY = new Date('2026-10-22T14:00:00Z');       // FULL ROW's names move with the ISO week: the launch week's
const FPS = 60, SECONDS = 4, CSS_H = 1080;

/* ------------------------------------ the bench ------------------------------------ */
execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-preview.ts'], { stdio: 'inherit' });
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://x').pathname;
  let body: Buffer;
  try { body = await readFile(join('dist/preview', path === '/' ? 'index.html' : path)); } catch { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': TYPES[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: CHROME });

/** The stage alone, 1080 px high, on ink: the bench's own labels hidden. */
const CSS = `html,body{margin:0;background:#0B0B0B} main{margin:0;padding:0} .eyebrow,#status{display:none!important}
  section.card{margin:0;padding:0;border:0;background:#0B0B0B;width:${Math.ceil(CSS_H * 420 / 800)}px;height:${CSS_H}px}`;
async function open(game: 'unbreakable' | 'full-row', seed: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: Math.ceil(CSS_H * 420 / 800) + 40, height: CSS_H + 40 }, deviceScaleFactor: 1 });
  await page.clock.install({ time: LAUNCH_DAY }); await page.clock.pauseAt(new Date(LAUNCH_DAY.getTime() + 100));   // frozen: only runFor moves time
  await page.goto(`http://127.0.0.1:${port}/?game=${game}&seed=${seed}`);
  await page.addStyleTag({ content: CSS });
  await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.clock.runFor(3000);                          // fonts settle, the stage lays out, the run starts
  return page;
}
const state = <T>(page: Page): Promise<T> => page.evaluate(() => (window as unknown as { __preview: { state: unknown } }).__preview.state) as Promise<T>;
const send = (page: Page, input: unknown): Promise<void> => page.evaluate((i) => (window as unknown as { __preview: { send(i: unknown): void } }).__preview.send(i), input);
/** Logical canvas point → page point. */
async function toPage(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = await page.locator('#arena canvas').first().boundingBox();
  if (!box) throw new Error('no canvas');
  return [box.x + x / 420 * box.width, box.y + y / 800 * box.height];
}

/** Records `SECONDS` seconds: before each frame, `script(frame)` may act (instantly, in virtual time). */
async function record(page: Page, name: string, script: (frame: number) => Promise<void>): Promise<void> {
  const dir = join(OUT, `.${name}-frames`);
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  const arena = page.locator('#arena');
  let elapsed = 0;
  for (let f = 0; f < FPS * SECONDS; f++) {
    await script(f);
    const target = Math.round((f + 1) * 1000 / FPS);
    await page.clock.runFor(target - elapsed); elapsed = target;
    await arena.screenshot({ path: join(dir, `${String(f).padStart(4, '0')}.png`) });
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%04d.png'),
    '-vf', `scale=-2:${CSS_H}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', join(OUT, `${name}.mp4`)]);
  await rm(dir, { recursive: true, force: true });
  console.log(`${OUT}/${name}.mp4`);
}
/** Lets virtual time run (not recorded). */
const wait = (page: Page, ms: number): Promise<void> => page.clock.runFor(ms);

/* ----------------------------------- UNBREAKABLE ----------------------------------- */
const ub = createUb(ELIG), UB_CFG = scoringConfiguration('unbreakable');
/** One turn simulated with the engine (from now): how many bricks a volley at `angle` breaks, and whether the run survives it. */
function ubTurn(s: UbState, angle: number): { broken: number; over: boolean; ticks: number } {
  let t = s.tick, x = ub.applyInput(s, { action: 'fire', angle }, t);
  const before = x.sim.broken;
  for (let k = 0; k < 2000 && x.sim.phase === 1 && !x.gameOver; k++) x = ub.advance(x, ++t);
  return { broken: x.sim.broken - before, over: x.gameOver || x.sim.phase === 2, ticks: t - s.tick };
}
const ANGLES = Array.from({ length: 81 }, (_, i) => Math.round(MIN_ANGLE + (MAX_ANGLE - MIN_ANGLE) * i / 80));
function bestAngle(s: UbState, worst = false): { angle: number; broken: number } {
  let best = { angle: 9000, broken: worst ? 1e9 : -1 };
  for (const angle of ANGLES) {
    const r = ubTurn(s, angle);
    if (!worst && !r.over && r.broken > best.broken) best = { angle, broken: r.broken };
    if (worst && r.broken < best.broken) best = { angle, broken: r.broken };
  }
  return best;
}
/** Waits until the stage can aim again (the volley is back and the rows have come down). */
async function ubReady(page: Page): Promise<UbState> {
  for (let k = 0; k < 400; k++) { const s = await state<UbState>(page); if (s.gameOver || s.sim.phase === 0) { await wait(page, 700); return state<UbState>(page); } await wait(page, 100); }
  throw new Error('UNBREAKABLE: the volley never came back');
}
/** Moves the mouse onto the aim line (the stage draws its guide), then fires that exact angle through the bench. */
async function ubAim(page: Page, s: UbState, angle: number): Promise<void> {
  const a = angle / 18000 * Math.PI, [x, y] = await toPage(page, s.sim.originX + Math.cos(a) * 260, FLOOR - R - Math.sin(a) * 260);
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
async function captureUnbreakable(): Promise<void> {
  const plan = planVolley();
  console.log(`unbreakable: seed ${plan.seed}, ${plan.pre.length} turns first, ${plan.bricks} bricks up, the volley breaks ${plan.early} in 3.2 s`);
  const page = await open('unbreakable', plan.seed);
  for (const angle of plan.pre) { await ubReady(page); await send(page, { action: 'fire', angle }); }
  const s = await ubReady(page);
  await record(page, 'unbreakable', async (f) => {
    if (f === 0) await ubAim(page, s, Math.min(MAX_ANGLE, plan.angle + 1500));
    if (f === 10) await ubAim(page, s, plan.angle);
    if (f === 24) await send(page, { action: 'fire', angle: plan.angle });
  });
  await page.close();
}
async function captureUnbreakableEnd(): Promise<void> {
  const page = await open('unbreakable', 777);
  // the worst volley every turn, until the next one ends the run; then that last volley and the end screen
  for (let turn = 0; turn < 40; turn++) {
    const s = await ubReady(page); const w = bestAngle(s, true);
    if (ubTurn(s, w.angle).over) break;
    await send(page, { action: 'fire', angle: w.angle });
  }
  const s = await ubReady(page), last = bestAngle(s, true);
  await record(page, 'unbreakable-end', async (f) => {
    if (f === 0) await ubAim(page, s, last.angle);
    if (f === 12) await send(page, { action: 'fire', angle: last.angle });
  });
  await page.close();
}

/* ------------------------------------- FULL ROW ------------------------------------- */
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
/** Plays a move at once (not recorded): a quick drag. */
async function quickDrag(page: Page, m: Move): Promise<void> {
  const d = await dragger(page, await state<FrState>(page), m, 4);
  await d.down(); for (let k = 1; k <= 4; k++) { await d.step(k); await wait(page, 16); } await d.up(); await wait(page, 350);
}
/** A drag spread over recorded frames [from, from + steps]. */
function dragDuring(d: { down(): Promise<void>; step(k: number): Promise<void>; up(): Promise<void> }, from: number, steps: number) {
  return async (f: number): Promise<void> => {
    if (f === from) await d.down();
    else if (f > from && f <= from + steps) await d.step(f - from);
    if (f === from + steps + 1) await d.up();
  };
}
async function captureFullRow(): Promise<void> {
  const seed = 5150, plan = planRow(seed);
  const page = await open('full-row', seed);
  for (const m of plan.slice(0, -1)) await quickDrag(page, m);
  const s = await state<FrState>(page), last = plan.at(-1) as Move;
  console.log(`full-row: ${plan.length} pieces, the last completes a line`);
  const first = dragDuring(await dragger(page, s, last, 26), 14, 26);
  let second: ((f: number) => Promise<void>) | null = null;
  await record(page, 'full-row', async (f) => {
    await first(f);
    if (f === 140) {                                   // after the moment: one more piece, next to what is on the grid
      const now = await state<FrState>(page), moves = movesOf(now);
      const touching = (m: Move): number => { const p = PIECES[now.play.hand[m.slot] as number] as Piece; let n = 0; for (const [dx, dy] of p.cells) for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const x = m.x + dx + ex, y = m.y + dy + ey; if (x >= 0 && y >= 0 && x < N && y < N && ((now.play.rows[y] as number) >> x) & 1) n++; } return n; };
      const m = moves.sort((a, b) => touching(b) - touching(a))[0];
      if (m) second = dragDuring(await dragger(page, now, m, 26), 150, 26);
    }
    if (second) await second(f);
  });
  await page.close();
}
async function captureFullRowEnd(): Promise<void> {
  const seed = 9090, page = await open('full-row', seed);
  // place pieces where they clear nothing and leave the least room, until the next move is the one after which nothing fits
  for (let k = 0; k < 60; k++) {
    const s = await state<FrState>(page); const moves = movesOf(s); if (!moves.length || s.play.stuckTick !== null) break;
    if (moves.some((m) => play(s, m).play.stuckTick !== null)) break;
    const scored = moves.map((m) => { const a = play(s, m); return { m, v: (a.play.lines > s.play.lines ? -100 : 0) - movesOf(a).length }; }).sort((p, q) => q.v - p.v);
    await quickDrag(page, (scored[0] as { m: Move }).m);
  }
  const s = await state<FrState>(page), moves = movesOf(s);
  const end = moves.find((m) => play(s, m).play.stuckTick !== null) ?? moves[0];
  if (!end) throw new Error('FULL ROW: the run ended before the recording');
  await record(page, 'full-row-end', dragDuring(await dragger(page, s, end, 22), 6, 22));
  await page.close();
}

await mkdir(OUT, { recursive: true });
try {
  if (WHICH.includes('unbreakable')) await captureUnbreakable();
  if (WHICH.includes('full-row')) await captureFullRow();
  if (WHICH.includes('full-row-end')) await captureFullRowEnd();
  if (WHICH.includes('unbreakable-end')) await captureUnbreakableEnd();
} finally { await browser.close(); server.close(); }
