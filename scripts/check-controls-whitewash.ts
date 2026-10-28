// NFT INVADERS: an adversarial check of the dragon's controls (mouse, ← → / A D) on the real stage in Chrome, against the
// in-browser coordinator stand-in (src/dev/preview.ts). The sky is emptied first (no dive, no drip, no stun), then every
// scenario drives the page like a player would and records where the dragon is DRAWN on every frame, next to the
// authoritative state. Usage (builds the preview first):
//   node --import tsx scripts/dev-preview.ts && node --import tsx scripts/check-controls-whitewash.ts [--lag 150]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const lagArg = process.argv.indexOf('--lag');
const LAG = lagArg > 0 ? Number(process.argv[lagArg + 1]) : 0;
const W = 420, EDGE = 22, KEY_NUDGE = 30, KEY_SPEED = 300;
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const port = 5300 + Math.floor(Math.random() * 500);
await new Promise<void>((resolve) => createServer(async (q, s) => {
  const p = new URL(q.url ?? '/', 'http://x').pathname;
  try { const body = await readFile(join('dist/preview', p === '/' ? 'index.html' : p)); s.writeHead(200, { 'Content-Type': types[extname(p)] ?? 'text/html' }); s.end(body); }
  catch { s.writeHead(404); s.end(); }
}).listen(port, resolve));

const CHROMES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'];
const { existsSync } = await import('node:fs');
const executablePath = CHROMES.find((p) => p && existsSync(p));
if (!executablePath) throw new Error('No Chrome found: set CHROME_PATH');
const browser = await chromium.launch({ executablePath });
const page: Page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
// every frame: where the dragon is drawn (logical px), and the authoritative x and target
// (plain JavaScript text: a function would be compiled by tsx with helpers that do not exist in the page)
await page.addInitScript(`
  window.__frames = []; window.__dts = [];
  let last = 0;
  requestAnimationFrame(function loop(t) { if (last) window.__dts.push(t - last); last = t; requestAnimationFrame(loop); });
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (img, ...a) {
    if (img instanceof HTMLImageElement && img.src.startsWith('data:image/jpeg') && a.length === 4 && a[3] < 100) {
      const st = window.__preview && window.__preview.state && window.__preview.state.play;
      window.__lastX = a[0] + a[2] / 2;
      window.__frames.push([performance.now(), window.__lastX, st ? st.x : NaN, st ? st.target : NaN]);
    }
    return draw.call(this, img, ...a);
  };
`);
await page.goto(`http://localhost:${port}/?game=whitewash&seed=5&lag=${LAG}`);
await page.waitForTimeout(800);
// a quiet sky for the whole check: no raider, no next wave, no dive, no drip (display of the controls only)
await page.evaluate(`(() => { const p = window.__preview.state.play; p.cleaners = []; p.drips = []; p.waveAt = 1e9; p.nextDive = 1e9; p.stunUntil = 0; })()`);
const canvas = (await page.locator('canvas.ww-canvas').boundingBox())!;
const px = (x: number): number => canvas.x + (x / W) * canvas.width;        // logical x → page x
const Y = canvas.y + canvas.height * 0.85;
type Frame = [number, number, number, number];
const frames = async (): Promise<Frame[]> => page.evaluate('window.__frames.splice(0)') as Promise<Frame[]>;
const drawn = async (): Promise<number> => page.evaluate('window.__lastX') as Promise<number>;
const wait = (ms: number): Promise<void> => page.waitForTimeout(ms);

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const check = (name: string, ok: boolean, detail: string): void => { results.push({ name, ok, detail }); };
/** Frames where the drawn dragon moved against `dir` (+1 right, -1 left) by more than 0.25 px. */
const backwards = (f: Frame[], dir: number): { n: number; max: number } => {
  let n = 0, max = 0;
  for (let i = 1; i < f.length; i++) { const d = (f[i]![1] - f[i - 1]![1]) * dir; if (d < -0.25) { n++; max = Math.max(max, -d); } }
  return { n, max };
};
/** Moves the mouse to logical x (kept inside the window: past the board's edge, never off the page) and returns the error. */
const settle = async (x: number, ms = 900): Promise<number> => {
  const pageX = Math.max(1, px(x)), want = Math.max(EDGE, Math.min(W - EDGE, ((pageX - canvas.x) / canvas.width) * W));
  await page.mouse.move(pageX, Y); await wait(ms); return Math.abs((await drawn()) - want);
};

/* ---------------------------------- mouse ---------------------------------- */
await settle(60, 1200); await frames();
// 1. a flick across the board: no step backwards, lands on the pixel, no overshoot
await page.mouse.move(px(360), Y);
await wait(1000);
let f = await frames();
const flickBack = backwards(f, 1), flickMax = Math.max(...f.map((x) => x[1]));
check('mouse flick 60 → 360', flickBack.n === 0 && Math.abs(f.at(-1)![1] - 360) < 0.5 && flickMax <= 360.5,
  `lands at ${f.at(-1)![1].toFixed(1)}, overshoot ${(flickMax - 360).toFixed(1)} px, ${flickBack.n} backward frames`);
// time to arrive within 2 px (the dragon walks at 800 px/s: 300 px ≈ 375 ms + input delay)
const t0 = f[0]![0], arrive = f.find((x) => Math.abs(x[1] - 360) < 2);
check('mouse flick arrival time', Boolean(arrive) && arrive![0] - t0 < 600 + LAG, `${arrive ? (arrive[0] - t0).toFixed(0) : '∞'} ms for 300 px`);
// 2. a slow creep, 1 px per event at ~60 events/s: smooth, follows within a few px, never steps back
for (let x = 360; x >= 200; x--) { await page.mouse.move(px(x), Y); await wait(16); }
await wait(400);
f = await frames();
const creepBack = backwards(f, -1);
const steps = f.slice(1).map((x, i) => Math.abs(x[1] - f[i]![1]));
const bigStep = Math.max(...steps);
check('mouse slow creep 360 → 200', creepBack.n === 0 && bigStep <= 6 && Math.abs(f.at(-1)![1] - 200) < 0.5,
  `${creepBack.n} backward frames, largest per-frame step ${bigStep.toFixed(1)} px, ends at ${f.at(-1)![1].toFixed(1)}`);
// 3. single-pixel adjustments are honoured
let worstPixel = 0;
for (const x of [201, 203, 202, 207, 206]) worstPixel = Math.max(worstPixel, await settle(x, 350));
check('mouse 1–5 px adjustments', worstPixel < 0.5, `worst error ${worstPixel.toFixed(2)} px`);
// 4. hand tremor: ±6 px at 25 Hz around 210 for 1.5 s, then still: the dragon stays near, settles exactly
await frames();
for (let i = 0; i < 38; i++) { await page.mouse.move(px(210 + (i % 2 ? 6 : -6)), Y); await wait(40); }
await page.mouse.move(px(210), Y); await wait(700);
f = await frames();
const tremorSpread = Math.max(...f.map((x) => x[1])) - Math.min(...f.map((x) => x[1]));
check('mouse tremor ±6 px', tremorSpread <= 14 && Math.abs(f.at(-1)![1] - 210) < 0.5, `spread ${tremorSpread.toFixed(1)} px, settles at ${f.at(-1)![1].toFixed(1)}`);
// 5. off the board, both sides: pinned to the edges
const offLeft = await settle(-200), offRight = await settle(W + 300);
check('mouse past the edges', offLeft < 0.5 && offRight < 0.5, `left error ${offLeft.toFixed(2)}, right error ${offRight.toFixed(2)} px`);
// 6. at rest, the drawn dragon is where the authority says (shots leave from there)
await settle(150, 1200);
const rest = (await frames()).slice(-20);
const gap = Math.max(...rest.map((x) => Math.abs(x[1] - x[2])));
check('drawn = authoritative at rest', gap < 0.5, `largest gap ${gap.toFixed(2)} px over the last 20 frames`);

/* --------------------------------- keyboard --------------------------------- */
const tapAt = await drawn();
// 7. one tap = one 30 px nudge, ten fast taps = 300 px (clamped at the edge)
await page.keyboard.press('KeyD'); await wait(500);
const oneTap = (await drawn()) - tapAt;
check('key tap D', Math.abs(oneTap - KEY_NUDGE) < 0.5, `moved ${oneTap.toFixed(1)} px (want ${KEY_NUDGE})`);
await settle(300, 900); await frames();                                   // room for six nudges left
const before10 = await drawn();
for (let i = 0; i < 6; i++) { await page.keyboard.press('KeyA'); await wait(30); }
await wait(600);
const sixTaps = before10 - (await drawn());
check('six fast taps A', Math.abs(sixTaps - 6 * KEY_NUDGE) < 0.5, `moved ${sixTaps.toFixed(1)} px (want ${6 * KEY_NUDGE})`);
// 8. hold D 1 s with OS auto-repeat (repeat keydowns every 33 ms): steady 300 px/s, smooth, stops dead on release
await settle(60, 900); await frames();
await page.keyboard.down('KeyD');
for (let i = 0; i < 30; i++) { await wait(33); await page.keyboard.down('KeyD'); }        // repeat = true
const heldAt = await drawn();
await page.keyboard.up('KeyD');
await wait(500);
f = await frames();
const startX = f[0]![1], release = f.findIndex((x) => x[1] >= heldAt - 0.01 && x[0] > f[0]![0] + 900);
const moving = f.filter((x) => x[0] > f[0]![0] + 150 && x[0] < f[0]![0] + 900);
const speed = moving.length > 2 ? (moving.at(-1)![1] - moving[0]![1]) / ((moving.at(-1)![0] - moving[0]![0]) / 1000) : 0;
const holdSteps = moving.slice(1).map((x, i) => x[1] - moving[i]![1]);
const jerk = Math.max(...holdSteps) - Math.min(...holdSteps);
const after = f.slice(release > 0 ? release : f.length - 10).map((x) => x[1]);
const overshoot = Math.max(...after) - heldAt;
check('hold D: speed', Math.abs(speed - KEY_SPEED) < KEY_SPEED * 0.12, `${speed.toFixed(0)} px/s (want ${KEY_SPEED})`);
check('hold D: smooth', backwards(f, 1).n === 0 && jerk < 9, `per-frame step range ${jerk.toFixed(1)} px, ${backwards(f, 1).n} backward frames`);
check('hold D: release', overshoot < 2 && Math.abs(f.at(-1)![1] - after.at(-1)!) < 0.5,
  `${overshoot.toFixed(1)} px past the release point, rests at ${f.at(-1)![1].toFixed(1)} (from ${startX.toFixed(0)})`);
// 9. A and D together: no motion; let go of D, it goes left
const both = await drawn();
await page.keyboard.down('KeyA'); await page.keyboard.down('KeyD'); await wait(400);
const bothDrift = Math.abs((await drawn()) - both);
await page.keyboard.up('KeyD'); await wait(400); await page.keyboard.up('KeyA'); await wait(300);
const leftAfter = both - (await drawn());
check('A + D together', bothDrift < 31 && leftAfter > 60, `drift while both held ${bothDrift.toFixed(1)} px (one nudge allowed), then ${leftAfter.toFixed(0)} px left`);
// 10. hold into the wall: stops at the edge, no shake
await page.keyboard.down('ArrowLeft'); await wait(1600); await frames(); await wait(500);
f = await frames(); await page.keyboard.up('ArrowLeft'); await wait(200);
const wallSpread = Math.max(...f.map((x) => x[1])) - Math.min(...f.map((x) => x[1]));
check('hold ← into the wall', Math.abs(f.at(-1)![1] - EDGE) < 0.5 && wallSpread < 0.5, `rests at ${f.at(-1)![1].toFixed(1)}, spread ${wallSpread.toFixed(2)} px`);
// 11. the window loses focus while a key is held: it stops
await page.keyboard.down('KeyD'); await wait(300);
await page.evaluate('window.dispatchEvent(new Event("blur"))');
const blurAt = await drawn(); await wait(600);
const blurDrift = (await drawn()) - blurAt;
await page.keyboard.up('KeyD');
check('focus lost while holding D', blurDrift < 25, `kept going ${blurDrift.toFixed(1)} px after the blur`);

/* ---------------------------------- mixed ---------------------------------- */
// 12. a resting hand on the mouse while a key is held: the mouse is ignored
await settle(300, 900); await frames();
await page.keyboard.down('KeyA');
for (let i = 0; i < 20; i++) { await page.mouse.move(px(300 + (i % 2 ? 3 : -3)), Y); await wait(30); }
await page.keyboard.up('KeyA'); await wait(400);
f = await frames();
check('mouse tremor while A held', backwards(f, -1).n === 0, `${backwards(f, -1).n} frames pulled back towards the mouse`);
// 13. right after a key, a small mouse twitch is ignored, a real move takes over
const k = await drawn();
await page.mouse.move(px(301), Y); await wait(300);
const twitch = Math.abs((await drawn()) - k);
const takeover = await settle(120, 900);
check('mouse after a key', twitch < 0.5 && takeover < 0.5, `twitch moved it ${twitch.toFixed(1)} px, a real move lands within ${takeover.toFixed(2)} px`);

/* ---------------------------------- report ---------------------------------- */
const dts = (await page.evaluate('window.__dts') as number[]).sort((a, b) => a - b);
const q = (p: number): number => dts[Math.floor(dts.length * p)] ?? 0;
const slow = q(0.5) > 25;
const pad = Math.max(...results.map((r) => r.name.length));
console.log(`frame interval: median ${q(0.5).toFixed(1)} ms, p95 ${q(0.95).toFixed(1)} ms, worst ${q(0.999).toFixed(0)} ms${slow ? '  (SLOW machine: timing results are not meaningful)' : ''}`);
console.log(`NFT INVADERS controls, adversarial check${LAG ? ` (network lag ${LAG} ms each way)` : ''}:`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
if (errors.length) console.log(`page errors:\n${errors.join('\n')}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
