// The hub's game screenshots (hub/shots/<id>.jpg): the game screen in the middle of a run, portrait, 1080 px high.
// Taken again at every hub build (scripts/build-hub.ts), so a game added to hub/games.json always has one.
//
//   our games         on the test bench (src/dev/preview.ts: the shipped stage against an in-browser stand-in for the
//                     coordinator), a few moves planned with the very engines the verifier runs
//   SuperRare's games their live page, as it opens (with its local Practice started when the page offers one)
//
//   node --import tsx scripts/capture-shots.ts [id,id]        (Chrome: CHROME_PATH, else the usual install paths)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { MAX_ANGLE, MIN_ANGLE } from '../src/games/unbreakable/engine.js';
import { N, PIECES, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';

export type HubGame = { id: string; title: string; pitch: string; url: string; appId: string; bench?: 'full-row' | 'unbreakable'; featured?: boolean };

// the stage laid out 504 × 960 css px at a device pixel ratio of 1.125: 567 × 1080 pixels
const STAGE_W = 504, STAGE_H = 960, DPR = 1080 / STAGE_H;
const CHROMES = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean) as string[];

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

const benchState = <T>(page: Page): Promise<T> => page.evaluate(() => (window as unknown as { __preview: { state: unknown } }).__preview.state) as Promise<T>;
const benchSend = (page: Page, input: unknown): Promise<void> => page.evaluate((i) => (window as unknown as { __preview: { send(i: unknown): void } }).__preview.send(i), input);

/** FULL ROW: greedy placements (most lines, then the lowest cells) until a row is painted and the grid looks played. */
async function playFullRow(page: Page): Promise<void> {
  for (let move = 0; move < 9; move++) {
    const s = await benchState<FrState>(page);
    let best: { slot: number; x: number; y: number; score: number } | null = null;
    s.play.hand.forEach((id, slot) => {
      if (id < 0) return;
      const piece = PIECES[id] as Piece;
      for (let y = 0; y + piece.h <= N; y++) for (let x = 0; x + piece.w <= N; x++) {
        if (!fits(s.play.rows, piece, x, y)) continue;
        const score = evaluatePlacement(s.play.rows, s.play.combo, piece, x, y).lines * 100 + y + piece.h;
        if (!best || score > best.score) best = { slot, x, y, score };
      }
    });
    if (!best) break;
    const b = best as { slot: number; x: number; y: number };
    await benchSend(page, { action: 'place', slot: b.slot, x: b.x, y: b.y });
    await page.waitForTimeout(move === 8 ? 250 : 650);
  }
}
/** UNBREAKABLE: a few volleys, then the shot is taken while the balls are in the air. */
async function playUnbreakable(page: Page): Promise<void> {
  const angles = [7600, 10400, 8800];
  for (const angle of angles) {
    await benchSend(page, { action: 'fire', angle: Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, angle)) });
    await page.waitForTimeout(angle === angles.at(-1) ? 1200 : 4200);
  }
}

async function benchShot(browser: Browser, origin: string, game: 'full-row' | 'unbreakable', file: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: STAGE_W, height: STAGE_H }, deviceScaleFactor: DPR });
  try {
    await page.goto(`${origin}/?game=${game}&seed=${game === 'full-row' ? 2207 : 4242}`);
    await page.addStyleTag({ content: `html,body{margin:0;background:#DEDBD3} main{margin:0;padding:0} .eyebrow,#status,.ub-sound{display:none!important}
      section.card{margin:0;padding:0;border:0;width:${STAGE_W}px;height:${STAGE_H}px;display:flex;align-items:center;justify-content:center}` });
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);                                  // the wall's live names arrive, the run starts
    if (game === 'full-row') await playFullRow(page); else await playUnbreakable(page);
    await page.locator('section.card').screenshot({ path: file, type: 'jpeg', quality: 84 });
  } finally { await page.close(); }
}

async function liveShot(browser: Browser, url: string, file: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: STAGE_W, height: STAGE_H }, deviceScaleFactor: DPR });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined);
    const practice = page.getByRole('button', { name: /practice/i }).first();
    if (await practice.isVisible().catch(() => false)) { await practice.click().catch(() => undefined); await page.waitForTimeout(1800); }
    else await page.waitForTimeout(1500);
    await page.screenshot({ path: file, type: 'jpeg', quality: 84 });
  } finally { await page.close(); }
}

/** Takes every game's screenshot into `outDir` (<id>.jpg). Throws if a game could not be captured. */
export async function captureShots(games: HubGame[], outDir: string): Promise<void> {
  const executablePath = CHROMES.find((path) => existsSync(path));
  if (!executablePath) throw new Error('No Chrome found for the hub screenshots: set CHROME_PATH (or build with --no-shots to reuse hub/shots).');
  await mkdir(outDir, { recursive: true });
  let bench: { origin: string; close(): void } | null = null;
  const browser = await chromium.launch({ executablePath });
  try {
    for (const game of games) {
      const file = join(outDir, `${game.id}.jpg`);
      if (game.bench) {
        if (!bench) { execFileSync(process.execPath, ['--import', 'tsx', 'scripts/dev-preview.ts'], { stdio: 'ignore' }); bench = await serve('dist/preview'); }
        await benchShot(browser, bench.origin, game.bench, file);
      } else await liveShot(browser, game.url, file);
      process.stdout.write(`Shot: ${file}\n`);
    }
  } finally { await browser.close(); bench?.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const games = JSON.parse(await readFile('hub/games.json', 'utf8')) as HubGame[];
  const only = process.argv[2]?.split(',');
  await captureShots(only ? games.filter((g) => only.includes(g.id)) : games, 'hub/shots');
}
