// SIGNAGE: the browser side. The page shows the platform's authoritative plaza (advanced to the current server tick by
// the very module the verifier runs, with the player's own queued signs applied) and turns a swipe, a tap or a key into
// ONE ordered input: { action: 'sign', x, y, dir } or { action: 'clear', x, y }. It never sends a score, a time or a state.
//
// The names of the wall are a skin, never a rule: the 8 bricks carry 8 real neighbours of the painted wall (names.ts),
// and every walker is the person of the brick it is heading for, drawn with their walking sprite when they made one.
import type { GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { HitFeed } from '../../shell/hits.js';
import { allNames, infoOf, wallIsLive } from '../../shell/wall-data.js';
import { scoringConfiguration } from '../../shell/config.js';
import dragonUrl from '../../assets/dragon.jpg';
import { loadPeople, onPeople, sheetOfName, sheetOfWallet } from '../../shell/people.js';
import { drawSprite, stepAt } from '../../share/sprite.js';
import { bricksFor } from './names.js';
import {
  BOTTOM, COLS, DELIVERED, GAVE_UP, RULES, createEngine, inputSchema, snapshotSchema, stateSchema,
  type SgState, type Walker,
} from './engine.js';

const engine = createEngine();
const TICK_MS = 50;
const W = 420, H = 800;
const CELL = 50, BX = (W - COLS * CELL) / 2;                       // the plaza: 8 × 10 cells of 50 logical px
const WALL_Y = 96, WALL_H = 64, PY = WALL_Y + WALL_H + 6;          // the wall's bricks, then plaza row 1
const PLAZA_BOTTOM = PY + BOTTOM * CELL;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', LABEL = '#6B685F', LABEL_LT = '#B0ACA2', BLUE = '#2E7FD6';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
const fmtClock = (ticks: number): string => { const s = Math.max(0, Math.ceil(ticks * TICK_MS / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const multOf = (streak: number): number => 1 + Math.min(RULES.multCap - 1, Math.floor(streak / RULES.streakPerMult));
const ticksLeft = (S: SgState, tick: number): number =>
  Math.max(0, S.startTick === null ? S.rules.roundTicks : S.rules.roundTicks - (tick - S.startTick));
type Mode = 'idle' | 'play' | 'end';
type Spark = { x: number; y: number; vx: number; vy: number; life: number; sz: number };

function createStage(host: HTMLElement, io: StageIO): Stage {
  const hits = new HitFeed('signage');
  host.classList.add('sg-arena');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas sg-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'SIGNAGE plaza. Swipe on a cell to put up a sign pointing that way, tap a sign to take it down. Keyboard: arrows move the cursor, W A S D put up a sign, X takes it down.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  host.append(canvas, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let base: SgState | null = null;            // the authoritative view the local copy was cloned from
  let local: SgState | null = null;           // that view, stepped to the current server tick
  let tickNow = 0;
  let bricks = bricksFor(0);
  let prevPos = new Map<number, { x: number; y: number }>();   // where each walker stood before the last step
  let shownSteps = -1, stepSeenAt = 0, stepMs = 350;
  let seen = new Set<number>();               // outcomes (log entries) already played
  let targetOf = new Map<number, number>();   // walker id -> brick, kept after the walker is gone
  let brickFlash: number[] = Array.from({ length: COLS }, () => 0);
  let sparks: Spark[] = [];
  let nowText = '', nowT = 0, missT = 0, shake = 0;
  let kb = { x: 3, y: 5, on: false };
  const ptr = { id: -1, sx: 0, sy: 0, cell: null as { x: number; y: number } | null, dir: -1 };
  let dirty = true, DPRc = 1;

  /* ------------------------------ text helpers ----------------------------- */
  function mono(s: string, x: number, y: number, size: number, col: string, align: 'left' | 'center' | 'right', sp = 0.16, weight = 400): number {
    const adv = size * 0.6 + size * sp, w = s.length * adv - size * sp;
    ctx.font = `${weight} ${size}px ${F_MONO}`; ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const sx = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
    for (let i = 0; i < s.length; i++) ctx.fillText(s[i] as string, sx + i * adv, y);
    return w;
  }
  const anton = (s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left'): void => {
    ctx.font = `${size}px ${F_ANTON}`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  };
  function fitAnton(s: string, maxW: number, maxSize: number): number {
    ctx.font = `100px ${F_ANTON}`; const w = ctx.measureText(s).width || 1; return Math.min(maxSize, 100 * maxW / w);
  }

  /* ------------------------------ backgrounds ------------------------------ */
  let wmCanvas: HTMLCanvasElement | null = null;
  function buildWatermark(): void {
    const cv = document.createElement('canvas'); cv.width = Math.round(W * DPRc); cv.height = Math.round(H * DPRc);
    const g = cv.getContext('2d') as CanvasRenderingContext2D; g.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    const names = allNames();
    if (names.length) {
      g.font = `400 9px ${F_MONO}`; g.textBaseline = 'middle'; g.fillStyle = 'rgba(11,11,11,0.055)';
      let k = 0;
      for (let y = 14; y < H; y += 17) {
        let x = -((y * 7) % 60);
        while (x < W) { const nm = `${(names[(k++ * 7 + y) % names.length] as string).toUpperCase()}  ·  `; g.fillText(nm, x, y); x += g.measureText(nm).width; }
      }
    }
    wmCanvas = cv;
  }

  /* --------------------------------- audio --------------------------------- */
  let AC: AudioContext | null = null, noiseBuf: AudioBuffer | null = null, sndBudget = 0, muted = false;
  try { muted = localStorage.getItem('otw_arcade_muted') === '1'; } catch { /* storage unavailable */ }
  const syncSound = (): void => { soundButton.textContent = muted ? 'SOUND OFF' : 'SOUND ON'; };
  soundButton.addEventListener('click', () => { muted = !muted; try { localStorage.setItem('otw_arcade_muted', muted ? '1' : '0'); } catch { /* ignore */ } syncSound(); initAudio(); });
  syncSound();
  function initAudio(): void {
    try {
      if (!AC) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        AC = new Ctor(); const n = AC.sampleRate * 0.25; noiseBuf = AC.createBuffer(1, n, AC.sampleRate);
        const d = noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      }
      if (AC.state === 'suspended') void AC.resume();
    } catch { /* no audio */ }
  }
  function tone(f: number, d: number, type: OscillatorType, vol: number, slide?: number): void {
    if (muted || !AC || sndBudget <= 0) return; sndBudget--;
    const t0 = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0); if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + d);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g).connect(AC.destination); o.start(t0); o.stop(t0 + d + 0.02);
  }
  function thud(d: number, vol: number, freq: number): void {
    if (muted || !AC || !noiseBuf || sndBudget <= 0) return; sndBudget--;
    const t0 = AC.currentTime, s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = freq; g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    s.connect(f).connect(g).connect(AC.destination); s.start(t0); s.stop(t0 + d + 0.02);
  }
  const SND = {
    sign: () => tone(330, 0.04, 'triangle', 0.05, 260),
    clear: () => tone(220, 0.04, 'triangle', 0.04, 160),
    paint: () => { thud(0.12, 0.22, 700); tone(70, 0.15, 'triangle', 0.15, 45); tone(520, 0.06, 'square', 0.04, 700); },
    miss: () => { tone(110, 0.35, 'sawtooth', 0.07, 55); },
    over: () => { tone(90, 0.5, 'sawtooth', 0.09, 40); thud(0.3, 0.2, 400); },
  };
  const buzz = (ms: number): void => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

  /* ------------------------------- run memory ------------------------------ */
  const posMap = (S: SgState): Map<number, { x: number; y: number }> => new Map(S.play.walkers.map((w) => [w.id, { x: w.x, y: w.y }]));
  /** A new local copy (a fresh snapshot, or the old one advanced): starts the walk animation when a step happened,
   *  plays the outcomes not played yet. */
  function follow(before: SgState | null, next: SgState): void {
    for (const w of next.play.walkers) targetOf.set(w.id, w.to);
    if (next.play.steps !== shownSteps) {
      prevPos = before ? posMap(before) : new Map();
      shownSteps = next.play.steps; stepSeenAt = performance.now();
      stepMs = Math.max(1, next.play.nextStep - next.play.lastStep) * TICK_MS;
    }
    for (const entry of next.play.log) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      outcome(Math.floor(entry / 4), entry % 4);
    }
    if (next.gameOver && !before?.gameOver && next.play.missed >= RULES.strikes) SND.over();
  }
  function outcome(id: number, code: number): void {
    const to = targetOf.get(id) ?? 0, panel = bricks[to] ?? 0, info = infoOf(panel), name = info.name || `BRICK ${to + 1}`;
    if (code === DELIVERED) {
      brickFlash[to] = 1;
      if (!practice && panel) hits.add(panel);
      nowText = `PAINTED · ${name.toUpperCase()}${info.handle ? ` · @${info.handle}` : ''}`; nowT = 1.4;
      SND.paint(); buzz(8); shake = Math.max(shake, 1.5);
      const x = BX + (to + 0.5) * CELL, y = WALL_Y + WALL_H / 2;
      for (let i = 0; i < 8; i++) { const an = Math.random() * 6.283, sp = 60 + Math.random() * 170; sparks.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 60, life: 0.45 + Math.random() * 0.35, sz: 2 + Math.random() * 4 }); }
      if (!practice && local && local.play.delivered % 10 === 0) hits.flush();
    } else {
      nowText = `${name.toUpperCase()} ${code === GAVE_UP ? 'GAVE UP' : 'WENT HOME'}`; nowT = 1.6; missT = 1;
      SND.miss(); buzz(30); shake = Math.max(shake, 3);
    }
  }
  function resetRunMemory(seed: number): void {
    bricks = bricksFor(seed); prevPos = new Map(); shownSteps = -1; seen = new Set(); targetOf = new Map();
    brickFlash = Array.from({ length: COLS }, () => 0); sparks = []; nowText = ''; nowT = 0; missT = 0; shake = 0;
    ptr.id = -1; ptr.cell = null; ptr.dir = -1;
  }

  /* -------------------------------- drawing -------------------------------- */
  const cellX = (x: number): number => BX + x * CELL, cellY = (y: number): number => PY + (y - 1) * CELL;
  /* names on bricks: Anton capitals fitted to the brick, cut in two lines when one line would be too small */
  const nameCache = new Map<string, { lines: string[]; size: number }>();
  function brickName(name: string, cx: number, cy: number, col: string): void {
    const nm = (name || '—').toUpperCase(), avail = CELL - 8;
    let L = nameCache.get(nm);
    if (!L) {
      const one = fitAnton(nm, avail, 17);
      if (one >= 11 || nm.length < 6) L = { lines: [nm], size: Math.max(8, one) };
      else {
        const cut = Math.ceil(nm.length / 2), a = nm.slice(0, cut), b = nm.slice(cut);
        L = { lines: [a, b], size: Math.max(7, Math.min(fitAnton(a, avail, 15), fitAnton(b, avail, 15))) };
      }
      nameCache.set(nm, L);
    }
    if (L.lines.length === 1) anton(L.lines[0] as string, cx, cy, L.size, col, 'center');
    else { anton(L.lines[0] as string, cx, cy - L.size * 0.52, L.size, col, 'center'); anton(L.lines[1] as string, cx, cy + L.size * 0.52, L.size, col, 'center'); }
  }
  function drawWall(): void {
    for (let c = 0; c < COLS; c++) {
      const x = cellX(c) + 2, y = WALL_Y, w = CELL - 4, h = WALL_H, fl = brickFlash[c] as number;
      ctx.fillStyle = fl > 0.5 ? BLUE : INK; ctx.fillRect(x, y, w, h);
      const info = infoOf(bricks[c] ?? 0), sheet = info.name ? sheetOfName(info.name) : null;
      if (sheet) drawSprite(ctx, sheet, x + (w - 26) / 2, y + 4, 26, 0);
      brickName(info.name, x + w / 2, y + (sheet ? 42 : 30), CHALK);
      mono(String(c + 1), x + w / 2, y + h - 9, 11, fl > 0.5 ? INK : LABEL_LT, 'center', 0.02, 500);
    }
  }
  function drawArrow(cx: number, cy: number, dir: number, size: number, col: string): void {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(dir * Math.PI / 2);
    ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    ctx.beginPath(); ctx.moveTo(0, size * 0.42); ctx.lineTo(0, -size * 0.38);
    ctx.moveTo(-size * 0.3, -size * 0.08); ctx.lineTo(0, -size * 0.4); ctx.lineTo(size * 0.3, -size * 0.08); ctx.stroke();
    ctx.restore();
  }
  function drawPlaza(S: SgState): void {
    ctx.strokeStyle = 'rgba(11,11,11,0.13)'; ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(cellX(x) + 0.5, PY); ctx.lineTo(cellX(x) + 0.5, PLAZA_BOTTOM); ctx.stroke(); }
    for (let y = 1; y <= BOTTOM + 1; y++) { ctx.beginPath(); ctx.moveTo(BX, cellY(y) + 0.5); ctx.lineTo(BX + COLS * CELL, cellY(y) + 0.5); ctx.stroke(); }
    ctx.fillStyle = INK; ctx.fillRect(BX, PLAZA_BOTTOM, COLS * CELL, 2);
    const full = S.play.signs.length >= RULES.maxSigns;
    S.play.signs.forEach(([cell, dir], i) => {
      const x = cell % COLS, y = Math.floor(cell / COLS);
      ctx.globalAlpha = full && i === 0 ? 0.4 : 1;                 // the next sign to come down when a new one goes up
      ctx.fillStyle = BLUE; ctx.fillRect(cellX(x) + 3, cellY(y) + 3, CELL - 6, CELL - 6);
      drawArrow(cellX(x) + CELL / 2, cellY(y) + CELL / 2, dir, 30, CHALK);
      ctx.globalAlpha = 1;
    });
    if (ptr.cell && ptr.dir >= 0) {                                 // the sign being swiped
      ctx.globalAlpha = 0.55; ctx.fillStyle = BLUE; ctx.fillRect(cellX(ptr.cell.x) + 3, cellY(ptr.cell.y) + 3, CELL - 6, CELL - 6); ctx.globalAlpha = 1;
      drawArrow(cellX(ptr.cell.x) + CELL / 2, cellY(ptr.cell.y) + CELL / 2, ptr.dir, 30, CHALK);
    }
    if (kb.on) { ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(cellX(kb.x) + 1, cellY(kb.y) + 1, CELL - 2, CELL - 2); }
  }
  function drawWalker(w: Walker, now: number): void {
    const prev = prevPos.get(w.id) ?? { x: w.x, y: BOTTOM + 1 };          // a newcomer walks in from the street
    const t = Math.max(0, Math.min(1, (now - stepSeenAt) / Math.min(stepMs, 260)));
    const gx = prev.x + (w.x - prev.x) * t, gy = prev.y + (w.y - prev.y) * t;
    const cx = BX + (gx + 0.5) * CELL, cy = PY + (gy - 1 + 0.5) * CELL;
    const info = infoOf(bricks[w.to] ?? 0), sheet = info.name ? sheetOfName(info.name) : null;
    const size = 44, moving = t < 1 && (prev.x !== w.x || prev.y !== w.y);
    if (sheet) drawSprite(ctx, sheet, cx - size / 2, cy - size / 2 - 2, size, moving ? stepAt(now) : 0, w.dir);
    else {                                                               // no character yet: an ink figure that walks
      const stride = moving ? (stepAt(now) % 2 ? 3 : -3) : 0, side = w.dir === 1 || w.dir === 3;
      ctx.fillStyle = INK;
      ctx.beginPath(); ctx.arc(cx, cy - 12, 7, 0, 6.283); ctx.fill();
      ctx.fillRect(cx - 6, cy - 4, 12, 13);
      if (side) { ctx.fillRect(cx - 3 + stride, cy + 9, 4, 8); ctx.fillRect(cx - 1 - stride, cy + 9, 4, 8); }
      else { ctx.fillRect(cx - 5, cy + 9 + (stride > 0 ? -2 : 0), 4, 8); ctx.fillRect(cx + 1, cy + 9 + (stride < 0 ? -2 : 0), 4, 8); }
      if (w.dir !== 0) {                                                 // eyes, unless it walks away from you
        const ex = w.dir === 1 ? 3 : w.dir === 3 ? -3 : 0;
        ctx.fillStyle = CHALK; ctx.fillRect(cx + ex - 3, cy - 13, 2, 2); ctx.fillRect(cx + ex + 1, cy - 13, 2, 2);
      }
    }
    // the brick it wants, on a tag over its head; ink when its patience runs low
    const low = w.life <= 10, tx = cx + 12, ty = cy - 20;
    ctx.fillStyle = low ? INK : CHALK; ctx.fillRect(tx - 8, ty - 8, 16, 16);
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(tx - 7.5, ty - 7.5, 15, 15);
    mono(String(w.to + 1), tx, ty + 1, 12, low ? CHALK : INK, 'center', 0, 500);
  }
  function drawHud(S: SgState): void {
    const p = S.play;
    anton(fmtScore(p.score), W / 2, 36, Math.min(fitAnton(fmtScore(p.score), W - 170, 46), 46), INK, 'center');
    mono(fmtClock(ticksLeft(S, tickNow)), W - 16, 30, 16, INK, 'right', 0.08, 500);
    for (let i = 0; i < RULES.strikes; i++) {                           // the strikes, under the clock: one box per walker you may lose
      const x = W - 16 - 12 - (RULES.strikes - 1 - i) * 16, y = 46;
      if (i < p.missed) { ctx.fillStyle = INK; ctx.fillRect(x, y, 12, 12); } else { ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, 11, 11); }
    }
    const mult = multOf(p.streak);                                       // left, under the page's PRACTICE tag
    if (mult > 1) anton(`×${mult}`, 16, 62, 26, BLUE, 'left');
    if (nowT > 0 && nowText) {
      let s = nowText; const fit = Math.floor((W - 24) / (13 * 0.76)); if (s.length > fit) s = `${s.slice(0, fit - 1)}…`;
      mono(s, W / 2, 74, 13, missT > 0 ? INK : BLUE, 'center', 0.06, 500);
    }
  }
  let hintSeen = false;
  try { hintSeen = localStorage.getItem('wall-arcade:signage:hint') === '1'; } catch { /* storage unavailable */ }
  function drawStreet(S: SgState | null): void {
    const y = PLAZA_BOTTOM + 22;
    mono('THE STREET', BX, y, 11, LABEL, 'left', 0.2, 500);
    if (S) mono(`SIGNS ${S.play.signs.length}/${RULES.maxSigns}`, BX + COLS * CELL, y, 11, LABEL, 'right', 0.12, 500);
    if (!hintSeen && S && S.started) {
      if (S.play.signs.length >= 2) { hintSeen = true; try { localStorage.setItem('wall-arcade:signage:hint', '1'); } catch { /* storage unavailable */ } }
      mono(COARSE ? 'SWIPE A CELL TO PUT UP A SIGN' : 'DRAG ON A CELL TO PUT UP A SIGN', BX, y + 30, 13, INK, 'left', 0.06, 500);
      mono('TAP A SIGN TO TAKE IT DOWN', BX, y + 52, 13, INK, 'left', 0.06, 500);
      mono('WALK EACH PERSON TO THEIR NUMBER', BX, y + 74, 13, INK, 'left', 0.06, 500);
    }
  }
  const dragon = new Image(); let dragonReady = false;
  dragon.onload = () => { dragonReady = true; dirty = true; }; dragon.src = dragonUrl;
  function drawIdle(now: number): void {
    drawWall();
    const mine = sheetOfWallet(io.playerAddress?.());
    if (mine) drawSprite(ctx, mine, W / 2 - 48, PY + 4 * CELL, 96, stepAt(now), 0);   // the player's own character, walking to the wall
    else if (dragonReady && dragon.naturalWidth) {
      const w = 260; ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(dragon, W - w + 40, H - 380, w, w * dragon.naturalHeight / dragon.naturalWidth); ctx.restore();
    }
  }
  function draw(now: number): void {
    const pw = Math.round(W * DPRc), ph = Math.round(H * DPRc);
    if (!wmCanvas || wmCanvas.width !== pw || wmCanvas.height !== ph) buildWatermark();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(wmCanvas as HTMLCanvasElement, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (mode === 'idle' || !local) { drawIdle(now); return; }
    drawHud(local);
    drawWall();
    drawPlaza(local);
    for (const w of local.play.walkers) drawWalker(w, now);
    ctx.fillStyle = BLUE; for (const p of sparks) ctx.fillRect(p.x, p.y, p.sz, p.sz);
    drawStreet(local);
    if (missT > 0) { ctx.fillStyle = `rgba(11,11,11,${0.12 * missT})`; ctx.fillRect(0, 0, W, H); }
  }

  /* --------------------------------- input --------------------------------- */
  const point = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const cellAt = (x: number, y: number): { x: number; y: number } | null => {
    if (x < BX || x >= BX + COLS * CELL || y < PY || y >= PLAZA_BOTTOM) return null;
    return { x: Math.floor((x - BX) / CELL), y: 1 + Math.floor((y - PY) / CELL) };
  };
  const canPlay = (): boolean => mode === 'play' && local !== null && local.started && !local.gameOver && io.canInput();
  const hasSign = (x: number, y: number): boolean => Boolean(local && engine.signAt(local.play, y * COLS + x) >= 0);
  function putSign(x: number, y: number, dir: number): void {
    if (!canPlay() || (local && engine.signAt(local.play, y * COLS + x) === dir)) return;
    io.sendInput({ action: 'sign', x, y, dir }); SND.sign();
  }
  function takeDown(x: number, y: number): void {
    if (!canPlay() || !hasSign(x, y)) return;
    io.sendInput({ action: 'clear', x, y }); SND.clear();
  }
  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (!canPlay()) return;
    const [x, y] = point(e);
    e.preventDefault(); ptr.id = e.pointerId; ptr.sx = x; ptr.sy = y; ptr.cell = cellAt(x, y); ptr.dir = -1; kb.on = false;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== ptr.id || !ptr.cell) return;
    const [x, y] = point(e), dx = x - ptr.sx, dy = y - ptr.sy;
    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) { ptr.dir = -1; return; }
    ptr.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerId !== ptr.id) return;
    const cell = ptr.cell, dir = ptr.dir;
    ptr.id = -1; ptr.cell = null; ptr.dir = -1;
    if (!cell) return;
    if (dir >= 0) putSign(cell.x, cell.y, dir);
    else if (hasSign(cell.x, cell.y)) takeDown(cell.x, cell.y);
  });
  canvas.addEventListener('pointercancel', () => { ptr.id = -1; ptr.cell = null; ptr.dir = -1; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.tabIndex = 0;
  const KEY_DIR: Record<string, number> = { KeyW: 0, KeyD: 1, KeyS: 2, KeyA: 3 };
  canvas.addEventListener('keydown', (e) => {
    initAudio();
    if (!canPlay()) return;
    const move: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1], ArrowLeft: [-1, 0] };
    const m = move[e.code];
    if (m) { e.preventDefault(); kb = { x: Math.max(0, Math.min(COLS - 1, kb.x + m[0])), y: Math.max(1, Math.min(BOTTOM, kb.y + m[1])), on: true }; return; }
    const dir = KEY_DIR[e.code];
    if (dir !== undefined) { e.preventDefault(); kb.on = true; putSign(kb.x, kb.y, dir); return; }
    if (e.code === 'KeyX' || e.code === 'Backspace' || e.code === 'Delete') { e.preventDefault(); kb.on = true; takeDown(kb.x, kb.y); }
  });

  /* ---------------------------- layout and main loop ------------------------ */
  // Full frame: the largest board that fits the space the page gives the game (its parent), ratio preserved.
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || 420, availH = frameEl.clientHeight || 800;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    DPRc = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * DPRc); canvas.height = Math.round(cssH * DPRc);
    wmCanvas = null; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { nameCache.clear(); wmCanvas = null; dirty = true; }).catch(() => undefined);
  void loadPeople();
  onPeople(() => { dirty = true; });

  let liveSeen = wallIsLive(), lastFrame = performance.now(), idleStep = -1;
  function frame(t: number): void {
    requestAnimationFrame(frame);
    if (wallIsLive() !== liveSeen) { liveSeen = wallIsLive(); nameCache.clear(); wmCanvas = null; dirty = true; }   // the live names arrived
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t; sndBudget = 8;
    for (const p of sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt; }
    sparks = sparks.filter((p) => p.life > 0);
    for (let c = 0; c < COLS; c++) brickFlash[c] = Math.max(0, (brickFlash[c] as number) - dt / 0.5);
    if (shake > 0.2) shake *= Math.pow(0.01, dt); else shake = 0;
    if (nowT > 0) nowT -= dt;
    if (missT > 0) missT = Math.max(0, missT - dt / 0.4);
    if (mode === 'play' && local) {
      tickNow = Math.max(local.tick, io.estimatedTick());
      if (tickNow > local.tick && !local.gameOver) {
        const before = engine.clone(local);
        engine.advanceInPlace(local, tickNow);
        follow(before, local);
        if (local.gameOver && !practice) hits.flush();
      }
      draw(t);
    } else {
      if (mode === 'idle' && stepAt(t) !== idleStep && sheetOfWallet(io.playerAddress?.())) { idleStep = stepAt(t); dirty = true; }   // the sprite walks
      if (dirty || sparks.length || shake > 0) { draw(t); dirty = false; }
    }
  }
  requestAnimationFrame(frame);
  addEventListener('pagehide', () => { if (!practice) hits.flush(); });

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      if (extra?.idle) { mode = 'idle'; return; }
      if (extra && typeof extra.final === 'number') {
        practice = Boolean(extra.practice);
        if (!local && extra.view && typeof extra.view === 'object') local = engine.clone(extra.view as SgState);
        mode = 'end'; if (!practice) hits.flush();
      } else if (mode !== 'end') mode = 'idle';
    },
    hideRun(): void { if (mode === 'play') { mode = local && local.gameOver ? 'end' : 'idle'; dirty = true; } },
    showRun(view: SgState, info?: { practice?: boolean }): void {
      const nextPractice = Boolean(info?.practice);
      if (mode !== 'play' || nextPractice !== practice || (local && local.seed !== view.seed)) {
        resetRunMemory(view.seed); mode = 'play'; practice = nextPractice; base = null; local = null;
        // a run picked up mid-way (a reconnect, a reload): what it already shows is not played again, nor sent again to
        // the Survivor feed (the walkers delivered before are gone: their bricks are not known any more)
        for (const entry of view.play.log) seen.add(entry);
      }
      if (view !== base) {                                           // a new authoritative snapshot (or a new queued sign)
        const shown = local;
        base = view; local = engine.clone(view); tickNow = Math.max(local.tick, io.estimatedTick());
        if (tickNow > local.tick && !local.gameOver) engine.advanceInPlace(local, tickNow);
        follow(shown, local);
      }
    },
  };
}

export const signageAdapter: GameAdapter = {
  id: 'signage',
  title: 'SIGNAGE',
  by: { name: 'AIporium', url: 'https://x.com/AIporium_' },
  heading: 'Walk the people of the wall to their names',
  tagline: 'Rush hour at the wall: put up signs and walk every person to their own name.',
  lede: 'People of the wall walk in from the street, each one looking for their own brick. Swipe on the plaza to put up a sign: everyone who steps on it turns that way. Eight signs at most, the oldest comes down. Deliver people in a row for a bigger multiplier; five lost walkers and the run is over. Four minutes on the server clock, one credit per run.',
  howTo: [
    { title: 'How to play', text: 'People of the wall walk in from the street, each heading for their own name on the wall (the number on their tag). Left alone they walk straight up, to the wrong one: put up signs to steer them home.' },
    { title: 'Controls', text: 'Swipe (or drag) on a cell of the plaza to put up a sign pointing that way; tap a sign to take it down. Keyboard: the arrows move the cursor, W A S D put up a sign, X takes it down. Eight signs at most: a ninth takes down the oldest (shown faded).' },
    { title: 'Scoring', text: 'A person delivered to their own name: 50 + 5 for every step of patience they had left, × your streak (×1, then +1 for every 5 delivered in a row, up to ×5). A lost walker resets the streak.' },
    { title: 'The end', text: 'A walker is lost if they walk back out to the street or run out of patience. The fifth one ends the run, or 4 minutes on the server clock. They come faster and faster.' },
  ],
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: SgState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: SgState) => state.play.score,
  statusLine(state: SgState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    return `${state.play.delivered} delivered · ${state.play.missed}/${RULES.strikes} lost · ${fmtClock(ticksLeft(state, tick))} left on the server clock`;
  },
  createStage,
  diagSummary: (state: SgState) => ({ tick: state.tick, started: state.started, gameOver: state.gameOver, walkers: state.play.walkers.length, delivered: state.play.delivered, missed: state.play.missed, score: state.play.score }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('signage')),
    advance: (state: SgState, tick: number) => engine.advance(state, tick),
  },
};
