// UNBREAKABLE: the browser side. The canvas, the names painted on the wall and the sounds are the v5.1 game; what is
// new is who runs the clock. The page never simulates "for real": it shows the platform's authoritative state, advanced
// to the current server tick with the very module the verifier runs, and a shot is one ordered input sent to the server.
import type { GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { HitFeed } from '../../shell/hits.js';
import { allNames, infoOf, namedPanelCount, wallIsLive } from '../../shell/wall-data.js';
import { ELIG } from '../../generated/wall.js';
import { scoringConfiguration } from '../../shell/config.js';
import dragonUrl from '../../assets/dragon.jpg';
import type { EndStats } from '../../shell/adapter.js';
import { renderEndScreen } from '../../share/end-screen.js';
import { fitTweet, tag } from '../../share/post.js';
import {
  COLS, CELL, END_ROW, FLOOR, GT, HDR, MAX_ANGLE, MIN_ANGLE, NOW_Y, R, RULES, TICK_MS, W,
  createEngine, inputSchema, snapshotSchema, stateSchema, type Cell, type SimEvent, type UbState,
} from './engine.js';

const engine = createEngine(ELIG);
const H = 800;
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', LABEL = '#6B685F', LABEL_LT = '#B0ACA2', BLUE = '#2E7FD6';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace', F_INTER = 'Inter, system-ui, sans-serif';
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
const fmtClock = (ticks: number): string => { const s = Math.max(0, Math.ceil(ticks * TICK_MS / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

type Painted = { pos: number; name: string; handle: string };
type Mode = 'idle' | 'play' | 'end';

function createStage(host: HTMLElement, io: StageIO): Stage {
  const hits = new HitFeed('unbreakable-connect');
  host.classList.add('ub-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'UNBREAKABLE game board. Aim with the pointer or the arrow keys, fire with a click, a release or Space.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  // end of a run: one screen (src/share/end-screen.ts) above the canvas, the page's PLAY AGAIN bar under it
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your run');
  host.append(canvas, endPanel, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;                       // a practice run: nothing recorded, no hit reported to the Survivor feed
  let message = 'Start a round to play.';
  let final: { score: number } | null = null;
  let base: UbState | null = null;           // the authoritative view the local copy was cloned from
  let local: UbState | null = null;           // that view, stepped to the current server tick
  let tickNow = 0;
  let particles: { x: number; y: number; vx: number; vy: number; life: number; sz: number }[] = [];
  let shake = 0, nowText = '', nowT = 0, desc = 0, aimA100 = 9000, aiming = false, fireLock = 0, tSec = 0, lastFrame = performance.now();
  let painted: Painted[] = [], paintedSet = new Set<number>();
  let bounced = new Set<number>();            // every panel a ball hit this run (the share card's "people of the wall")
  let scoreHigh = 0, turnHigh = 1, brokenHigh = 0, firedHigh = 0, plusHigh = 0;   // cumulative counters: events replayed after a rebuild are not new
  let dirty = true, DPRc = 1, scale = 1;
  const ptr = { id: -1, sx: 0, sy: 0, moved: 0, drag: false };

  /* ------------------------------ text helpers ----------------------------- */
  function mono(s: string, x: number, y: number, size: number, col: string, align: string, sp = 0.16, weight = 400): number {
    const adv = size * 0.6 + size * sp, w = s.length * adv - size * sp;
    ctx.font = `${weight} ${size}px ${F_MONO}`; ctx.fillStyle = col; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const sx = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
    for (let i = 0; i < s.length; i++) ctx.fillText(s[i] as string, sx + i * adv, y);
    return w;
  }
  const anton = (s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left'): void => {
    ctx.font = `${size}px ${F_ANTON}`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  };
  const inter = (s: string, x: number, y: number, size: number, col: string): void => {
    ctx.font = `300 ${size}px ${F_INTER}`; ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  };
  function fitAnton(s: string, maxW: number, maxSize: number): number {
    ctx.font = `100px ${F_ANTON}`; const w = ctx.measureText(s).width || 1; return Math.min(maxSize, 100 * maxW / w);
  }
  function wrap(text: string, maxChars: number): string[] {
    const lines: string[] = []; let line = '';
    for (const word of text.toUpperCase().split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars) { if (line) lines.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    if (line) lines.push(line);
    return lines;
  }

  /* names on bricks: Anton capitals fitted to the brick, two lines if needed, "…" as a last resort */
  const nameCache = new Map<string, { lines: string[]; size: number }>();
  function nameLayout(name: string): { lines: string[]; size: number } {
    const hit = nameCache.get(name); if (hit) return hit;
    const avail = CELL - 2 * RULES.brickInset - 6, nm = (name || '?').toUpperCase();
    ctx.font = `100px ${F_ANTON}`;
    const w100 = (s: string): number => ctx.measureText(s).width;
    const s1 = Math.min(24, 100 * avail / w100(nm));
    let layout: { lines: string[]; size: number };
    if (s1 >= 13) layout = { lines: [nm], size: s1 };
    else {
      let bestI = -1, bestW = 1e9, bestScore = 1e9;
      for (let i = 2; i <= nm.length - 2; i++) {
        const m = Math.max(w100(nm.slice(0, i)), w100(nm.slice(i))), sc = m * (/[-.]/.test(nm[i - 1] as string) ? 0.88 : 1);
        if (sc < bestScore) { bestScore = sc; bestW = m; bestI = i; }
      }
      if (bestI < 0) layout = { lines: [nm], size: Math.max(9, s1) };
      else {
        const l1 = nm.slice(0, bestI), l2 = nm.slice(bestI), s2 = Math.min(17, 100 * avail / bestW);
        if (s2 >= 9.5) layout = { lines: [l1, l2], size: s2 };
        else { let t = l2; while (t.length > 1 && w100(t + '…') * 9.5 / 100 > avail) t = t.slice(0, -1); layout = { lines: [l1, t + '…'], size: 9.5 }; }
      }
    }
    nameCache.set(name, layout); return layout;
  }

  /* ------------------------------ backgrounds ------------------------------ */
  let wmCanvas: HTMLCanvasElement | null = null, paintCv: HTMLCanvasElement | null = null, paintG: CanvasRenderingContext2D | null = null;
  let paintCur = { x: 10, y: GT + 250 };
  function offscreen(): { cv: HTMLCanvasElement; g: CanvasRenderingContext2D } {
    const cv = document.createElement('canvas'); cv.width = Math.round(W * DPRc); cv.height = Math.round(H * DPRc);
    const g = cv.getContext('2d') as CanvasRenderingContext2D; g.setTransform(cv.width / W, 0, 0, cv.height / H, 0, 0);
    g.fillStyle = CONCRETE; g.fillRect(0, 0, W, H);
    return { cv, g };
  }
  function buildWatermark(): void {
    const { cv, g } = offscreen(); wmCanvas = cv;
    const names = allNames();
    if (names.length) {
      g.font = `400 9px ${F_MONO}`; g.textBaseline = 'middle'; g.fillStyle = 'rgba(11,11,11,0.055)';
      let k = 0;
      for (let y = 14; y < H; y += 17) {
        let x = -((y * 7) % 60);
        while (x < W) { const nm = `${(names[(k++ * 7 + y) % names.length] as string).toUpperCase()}  ·  `; g.fillText(nm, x, y); x += g.measureText(nm).width; }
      }
    }
  }
  function newPaintCanvas(): void {
    const { cv, g } = offscreen(); paintCv = cv; paintG = g; paintCur = { x: 10, y: GT + 250 };
  }
  function stamp(name: string): void {
    if (!paintG) return;
    const t = (name || '?').toUpperCase(), w = t.length * 6.2;
    if (paintCur.x + w > W - 8) { paintCur.y += 19; paintCur.x = 10 + (paintCur.y * 5) % 26; if (paintCur.y > H - 26 || paintCur.y > FLOOR + 40) paintCur.y = GT + 12; }
    paintG.font = `500 10.5px ${F_MONO}`; paintG.textBaseline = 'middle'; paintG.fillStyle = 'rgba(11,11,11,0.20)'; paintG.fillText(t, paintCur.x, paintCur.y);
    paintCur.x += w + 16;
  }
  function rebuildPaint(): void { newPaintCanvas(); for (const p of painted) stamp(p.name); }

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
    fire: () => tone(190, 0.05, 'triangle', 0.05, 130),
    brick: (hp: number) => { tone(120 + (hp % 5) * 12, 0.05, 'triangle', 0.09, 80); thud(0.03, 0.08, 900); },
    paint: () => { thud(0.12, 0.24, 700); tone(70, 0.15, 'triangle', 0.17, 45); tone(420, 0.05, 'square', 0.04, 300); },
    plus: () => tone(520, 0.05, 'triangle', 0.06, 780),
    over: () => { tone(90, 0.5, 'sawtooth', 0.09, 40); thud(0.3, 0.2, 400); },
    turn: () => tone(160, 0.05, 'triangle', 0.04, 110),
  };
  const buzz = (ms: number): void => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

  /* ------------------------------ sim events ------------------------------- */
  // The local copy is only ever advanced with this sink; every counter below is cumulative, so an event that was
  // already shown before the copy was rebuilt from a fresh server snapshot is recognised and ignored.
  const sink = (type: SimEvent, a?: number, b?: number, c?: number): void => {
    if (!local) return;
    const S = local.sim;
    if (type === 'brick') {
      if (S.score <= scoreHigh) return;
      scoreHigh = S.score;
      if (c) bounced.add(c);
      if (c && !practice) hits.add(c);
      const cell = a !== undefined && b !== undefined ? S.rows[a]?.cells[b] : null;
      SND.brick(cell && cell.t === 1 ? cell.hp : 0);
    } else if (type === 'break') {
      if (c === undefined || a === undefined || b === undefined) return;
      if (paintedSet.has(c) && S.broken <= brokenHigh) return;
      brokenHigh = Math.max(brokenHigh, S.broken);
      paintName(c, a, b);
    } else if (type === 'plus') {
      const key = S.turn * 1000 + S.plusGot; if (key > plusHigh) { plusHigh = key; SND.plus(); }
    } else if (type === 'fire') {
      const key = S.shots * 1_000_000 + (S.nBalls - S.toFire); if (key > firedHigh) { firedHigh = key; SND.fire(); }
    } else if (type === 'turn') {
      if (S.turn <= turnHigh) return;
      turnHigh = S.turn; if (!practice) hits.flush(); desc = 1; SND.turn();
      if (S.phase === 2) SND.over();
    }
  };

  function paintName(pos: number, row: number, col: number): void {
    if (paintedSet.has(pos)) return;
    paintedSet.add(pos);
    const info = infoOf(pos);
    painted.push({ pos, name: info.name, handle: info.handle }); stamp(info.name);
    nowText = `PAINTED · PANEL #${pos} · ${info.name || '—'}${info.handle ? ` · @${info.handle}` : ''}`; nowT = 0.6;
    SND.paint(); shake = Math.max(shake, 2.5); buzz(8);
    const x = (col + 0.5) * CELL, y = GT + (row + 0.5) * CELL;
    for (let i = 0; i < 8; i++) { const an = Math.random() * 6.283, sp = 60 + Math.random() * 190; particles.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 80, life: 0.5 + Math.random() * 0.4, sz: 2 + Math.random() * 4 }); }
  }

  // Hits that happened on the server between two snapshots never ran through the local copy, so they fired no
  // event: find them by comparing what was on screen with the new snapshot (bricks matched by panel), then paint
  // the broken names and report the hits, within the score the server actually recorded.
  function bricksByPos(view: UbState): Map<number, { hp: number; r: number; c: number }[]> {
    const map = new Map<number, { hp: number; r: number; c: number }[]>();
    view.sim.rows.forEach((row, r) => row?.cells.forEach((cell, c) => {
      if (cell && cell.t === 1) { const list = map.get(cell.pos) ?? []; list.push({ hp: cell.hp, r, c }); map.set(cell.pos, list); }
    }));
    return map;
  }
  function catchUp(shown: UbState, next: UbState): void {
    const S = next.sim;
    if (S.score <= scoreHigh) return;
    let budget = S.score - scoreHigh;
    const after = bricksByPos(next);
    for (const [pos, list] of bricksByPos(shown)) {
      const remaining = after.get(pos) ?? [];
      list.forEach((old, i) => {
        const now = remaining[i];
        const drop = now ? Math.max(0, old.hp - now.hp) : old.hp;
        if (drop > 0) bounced.add(pos);
        for (let k = 0; k < drop && budget > 0; k++, budget--) if (!practice) hits.add(pos);
        if (!now && S.broken > brokenHigh) paintName(pos, old.r, old.c);
      });
    }
    scoreHigh = S.score; brokenHigh = Math.max(brokenHigh, S.broken);
    SND.brick(0);
  }

  /* -------------------------------- drawing -------------------------------- */
  function header(right: string): void {
    mono('UNBREAKABLE', 16, 22, 11, INK, 'left', 0.2, 500);
    if (right) mono(right, W - 16, 22, 11, INK, 'right', 0.2, 500);
    ctx.fillStyle = INK; ctx.fillRect(0, HDR, W, 1);
  }
  const brickTone = (c: Cell & { t: 1 }): [string, string] => { const f = c.hp / c.hp0; return f > 0.66 ? [INK, CHALK] : (f > 0.33 ? [LABEL, CHALK] : [LABEL_LT, INK]); };
  const flash = new WeakMap<object, number>();
  function drawBrick(cell: Cell & { t: 1 }, r: number, c: number, yOff: number, step: number): void {
    const i = RULES.brickInset, x = c * CELL + i, y = GT + r * CELL + yOff + i, w = CELL - 2 * i, h = CELL - 2 * i;
    const fl = step - (flash.get(cell) ?? -1e9) < 8, tone = brickTone(cell), bg = fl ? CHALK : tone[0], fg = fl ? INK : tone[1];
    ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
    if (fl) { ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
    const info = infoOf(cell.pos), L = nameLayout(info.name), cx = x + w / 2;
    ctx.fillStyle = fg;
    if (L.lines.length === 1) anton(L.lines[0] as string, cx, y + h / 2 + 5, L.size, fg, 'center');
    else { anton(L.lines[0] as string, cx, y + h / 2 + 5 - L.size * 0.46, L.size, fg, 'center'); anton(L.lines[1] as string, cx, y + h / 2 + 5 + L.size * 0.5, L.size, fg, 'center'); }
    mono(String(cell.hp), x + w - 3, y + 7, 7.5, fg, 'right', 0.05, 500);
  }
  let stepNo = 0;
  const seenHp = new WeakMap<object, number>();
  function drawBoard(S: UbState, view: UbState): void {
    stepNo++;
    const sim = view.sim;
    header(`ROW ${sim.turn} · BALLS ${sim.nBalls}`);
    mono(`NAMES PAINTED ${sim.broken}`, 16, NOW_Y + 10, 8.5, LABEL, 'left', 0.2);
    const left = S.started && S.startTick !== null ? Math.max(0, S.rules.roundTicks - (tickNow - S.startTick)) : S.rules.roundTicks;
    mono(`TIME ${fmtClock(left)} · SCORE ${sim.score}`, W - 16, NOW_Y + 10, 8.5, LABEL, 'right', 0.2);
    let s = nowText || '—'; if (s.length > 44) s = `${s.slice(0, 43)}…`;
    const w = mono(s, 16, NOW_Y + 26, 10.5, INK, 'left', 0.06, 500);
    if (nowT > 0) { ctx.fillStyle = INK; ctx.fillRect(16, NOW_Y + 34, w, 2); }
    ctx.fillStyle = INK; ctx.fillRect(0, GT - 4, W, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(0, GT, W, H - GT); ctx.clip();
    const yOff = -CELL * desc * desc;
    for (let r = 0; r < sim.rows.length; r++) {
      const row = sim.rows[r]; if (!row) continue;
      for (let c = 0; c < COLS; c++) {
        const cell = row.cells[c]; if (!cell) continue;
        if (cell.t === 1) {
          const prev = seenHp.get(cell); if (prev !== undefined && prev !== cell.hp) flash.set(cell, stepNo); seenHp.set(cell, cell.hp);
          drawBrick(cell, r, c, yOff, stepNo);
        } else anton('+1', (c + 0.5) * CELL, GT + (r + 0.5) * CELL + yOff + 1, 24, BLUE, 'center');
      }
    }
    ctx.restore();
    const ey = GT + END_ROW * CELL;
    ctx.fillStyle = INK; ctx.fillRect(0, ey, W, 1); mono('END LINE', 12, ey + 10, 7.5, LABEL, 'left', 0.2);
    ctx.fillRect(0, FLOOR, W, 1);
    ctx.fillStyle = INK; for (const p of particles) ctx.fillRect(p.x, p.y, p.sz, p.sz);
    ctx.fillStyle = BLUE;
    for (const b of sim.balls) if (b.land) { ctx.beginPath(); ctx.arc(b.x, FLOOR - R, R, 0, 6.283); ctx.fill(); }
    const waiting = sim.phase === 1 ? sim.toFire : sim.nBalls;
    if (sim.phase !== 1 || sim.toFire > 0) { ctx.beginPath(); ctx.arc(sim.originX, FLOOR - R, R, 0, 6.283); ctx.fill(); }
    if (waiting > 0) mono(`×${waiting}`, sim.originX + (sim.originX > W - 70 ? -14 : 14), FLOOR - 9, 9, INK, sim.originX > W - 70 ? 'right' : 'left', 0.1, 500);
    for (const b of sim.balls) if (!b.land) { ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, 6.283); ctx.fill(); }
    if (canAim() && aiming) {
      const p = engine.probe(sim, aimA100), ox = sim.originX, oy = FLOOR - R;
      ctx.strokeStyle = BLUE; ctx.lineWidth = 2; ctx.setLineDash([2, 7]); ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(p[0], p[1]); ctx.stroke(); ctx.setLineDash([]);
    } else if (canAim() && !aiming && sim.turn <= 2) {
      mono(COARSE ? 'DRAG TO AIM · RELEASE TO FIRE' : 'MOVE TO AIM · CLICK TO FIRE', 16, FLOOR + 40, 8.5, LABEL, 'left', 0.18);
    }
    if (sim.phase === 1) mono('THE SERVER RUNS THE BALLS: NO FAST-FORWARD', 16, FLOOR + 40, 8, LABEL, 'left', 0.14);
  }
  const dragon = new Image(); let dragonReady = false;
  dragon.onload = () => { dragonReady = true; dirty = true; }; dragon.src = dragonUrl;
  function drawDragon(x: number, y: number, w: number): void {
    if (!dragonReady || !dragon.naturalWidth) return;
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(dragon, x, y, w, w * dragon.naturalHeight / dragon.naturalWidth); ctx.restore();
  }
  function drawIdle(): void {
    // The page's overlay carries the words (title, PLAY, PRACTICE, top 5): the canvas shows the wall behind it.
    header(wallIsLive() ? `LIVE · ${namedPanelCount()} NAMES` : 'SNAPSHOT');
    const size = fitAnton('UNBREAKABLE', W - 32, 120);
    anton('UNBREAKABLE', 16, 118, size, 'rgba(11,11,11,0.10)');
    drawDragon(W - 205, H - 300, 300);
  }
  function drawEnd(view: UbState | null): void {
    // the words are the end screen's (DOM, above): the canvas keeps the header and one big dragon cut by the edges
    const score = final ? final.score : (view ? view.sim.score : 0);
    header(`ROW ${view ? Math.max(1, view.sim.turn) : 1} · SCORE ${score}`);
    drawDragon(W - 260, H - 330, 420);
  }
  function draw(): void {
    const pw = Math.round(W * DPRc), ph = Math.round(H * DPRc);
    if (!wmCanvas || wmCanvas.width !== pw || wmCanvas.height !== ph) buildWatermark();
    if (paintCv && (paintCv.width !== pw || paintCv.height !== ph)) rebuildPaint();
    const bg = (mode !== 'play' || !paintCv) ? wmCanvas : paintCv;    // the stamped names belong to the run, not to the end screen
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg as HTMLCanvasElement, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (mode === 'play' && local) { drawDragon(W - 130, H - 170, 190); drawBoard(local, local); }
    else if (mode === 'end') drawEnd(local);
    else drawIdle();
  }

  /* --------------------------------- input --------------------------------- */
  const point = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  const angleFromVec = (dx: number, dyUp: number): number => {
    if (dyUp <= 0) return dx >= 0 ? MIN_ANGLE : MAX_ANGLE;
    const a = Math.round(Math.atan2(dyUp, dx) * 18000 / Math.PI); return Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, a));
  };
  function canAim(): boolean {
    return mode === 'play' && local !== null && local.started && !local.gameOver && local.sim.phase === 0 && desc <= 0 && io.canInput() && performance.now() > fireLock;
  }
  function fireNow(): void {
    if (!canAim()) return;
    aiming = false; fireLock = performance.now() + 400;
    io.sendInput({ action: 'fire', angle: Math.max(MIN_ANGLE, Math.min(MAX_ANGLE, Math.round(aimA100))) });
  }
  const aimFromPoint = (x: number, y: number): void => { if (local) aimA100 = angleFromVec(x - local.sim.originX, (FLOOR - R) - y); };
  canvas.addEventListener('pointerdown', (e) => {
    initAudio(); const [x, y] = point(e);
    if (mode === 'end') {
      return;
    }
    if (mode !== 'play') return;
    e.preventDefault(); ptr.id = e.pointerId; ptr.sx = x; ptr.sy = y; ptr.moved = 0; ptr.drag = false;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (canAim()) { if (e.pointerType === 'mouse') { aimFromPoint(x, y); aiming = true; } else ptr.drag = true; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = point(e);
    if (e.pointerType === 'mouse') { if (canAim()) { aimFromPoint(x, y); aiming = true; } return; }
    if (e.pointerId !== ptr.id || !ptr.drag || !canAim()) return;
    const vx = ptr.sx - x, vyUp = y - ptr.sy;                     // slingshot: finger goes down => shot goes up
    ptr.moved = Math.max(ptr.moved, Math.hypot(x - ptr.sx, y - ptr.sy));
    if (ptr.moved >= 14) { aimA100 = angleFromVec(vx, vyUp); aiming = true; } else aiming = false;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') { if (canAim() && aiming && ptr.id === e.pointerId) fireNow(); ptr.id = -1; return; }
    if (e.pointerId === ptr.id && ptr.drag && aiming && canAim()) fireNow();
    aiming = false; ptr.drag = false; ptr.id = -1;
  });
  canvas.addEventListener('pointercancel', () => { aiming = false; ptr.drag = false; ptr.id = -1; });
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') aiming = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (e.repeat) return; initAudio(); if (canAim()) { aiming = true; fireNow(); } }
    else if (e.code === 'ArrowLeft' && canAim()) { aimA100 = Math.min(MAX_ANGLE, aimA100 + 150); aiming = true; e.preventDefault(); }
    else if (e.code === 'ArrowRight' && canAim()) { aimA100 = Math.max(MIN_ANGLE, aimA100 - 150); aiming = true; e.preventDefault(); }
  });

  /* ---------------------------- layout and main loop ------------------------ */
  // Full frame: the largest board that fits the space the page gives the game (its parent), ratio preserved.
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || 420, availH = frameEl.clientHeight || 800;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    DPRc = Math.min(window.devicePixelRatio || 1, 2); scale = cssW / W;
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * DPRc); canvas.height = Math.round(cssH * DPRc);
    host.style.setProperty('--fr-scale', String(cssW / W));      // the end screen's top margin follows the canvas header
    wmCanvas = null; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"'), document.fonts.load('300 20px Inter')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { nameCache.clear(); wmCanvas = null; dirty = true; }).catch(() => undefined);

  let liveSeen = wallIsLive();
  function frame(t: number): void {
    requestAnimationFrame(frame);
    if (wallIsLive() !== liveSeen) { liveSeen = wallIsLive(); nameCache.clear(); wmCanvas = null; dirty = true; }   // the live names arrived
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t; tSec += dt; sndBudget = 8; void tSec;
    for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt; }
    particles = particles.filter((p) => p.life > 0);
    if (shake > 0.2) shake *= Math.pow(0.01, dt); else shake = 0;
    if (nowT > 0) nowT -= dt;
    if (desc > 0) desc = Math.max(0, desc - dt / 0.22);
    if (mode === 'play' && local) {
      tickNow = Math.max(local.tick, io.estimatedTick());
      if (tickNow > local.tick && !local.gameOver) engine.advanceInPlace(local, tickNow, sink);
      draw();
    } else if (dirty || particles.length || shake > 0) { draw(); dirty = false; }
  }
  requestAnimationFrame(frame);
  addEventListener('pagehide', () => { if (!practice) hits.flush(); });

  /* -------------------------------- Stage API ------------------------------- */
  function resetRunMemory(): void {
    painted = []; paintedSet = new Set(); bounced = new Set(); endStats = null; postMemo.key = ''; postMemo.anchor = null; endPanel.hidden = true; scoreHigh = 0; turnHigh = 1; brokenHigh = 0; firedHigh = 0; plusHigh = 0;
    particles = []; nowText = ''; nowT = 0; desc = 0; aimA100 = 9000; aiming = false; newPaintCanvas(); final = null;
  }
  /* ------------------------------- end screen -------------------------------- */
  let endStats: EndStats | null = null;
  const postMemo: { key: string; anchor: HTMLAnchorElement | null } = { key: '', anchor: null };
  function renderEnd(): void {
    const score = final ? final.score : (local ? local.sim.score : 0);
    // painted (broken) names first, then the ones only hit
    const order = [...painted.map((p) => p.pos), ...[...bounced].filter((pos) => !paintedSet.has(pos))];
    const names = order.map((pos) => (infoOf(pos).name || '').toUpperCase()).filter(Boolean);
    const people = bounced.size, shown = names.slice(0, 16);
    renderEndScreen(endPanel, {
      practice, score, stats: endStats,
      label: 'Your run',
      headline: `I bounced off ${people} ${people === 1 ? 'person' : 'people'} of the wall`,
      names: names.length > shown.length ? [...shown, `+ ${names.length - shown.length} more`] : shown,
      card: people > 0 && names.length ? { kind: 'bounce', names: names.slice(0, 60), people: Math.max(people, new Set(names.slice(0, 60)).size), score, ...(practice ? { practice: true } : {}) } : null,
      tweet: (link) => fitTweet(order.map((pos) => tag(infoOf(pos).name || '', infoOf(pos).handle)).filter(Boolean),
        (list, more) => `I bounced off ${people} people of the wall: ${list}${more ? ' …' : '.'} Beat me: ${link}`, link),
      postLabel: 'Post your run on X', cabinet: `${location.origin}/`,
    }, postMemo);
    endPanel.hidden = false;
  }

  return {
    setMessage(text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      message = text; dirty = true;
      if (extra?.idle) { mode = 'idle'; endPanel.hidden = true; return; }
      if (extra && typeof extra.final === 'number') {
        final = { score: extra.final };
        practice = Boolean(extra.practice);
        if (extra.view && typeof extra.view === 'object' && !local) { local = engine.clone(extra.view as UbState); }
        mode = 'end'; if (!practice) hits.flush();
        renderEnd();
      } else if (mode !== 'end') mode = 'idle';
    },
    hideRun(): void { if (mode === 'play') { mode = local && local.gameOver ? 'end' : 'idle'; if (mode === 'end') renderEnd(); dirty = true; } },
    endStats(stats: EndStats): void { endStats = stats; if (mode === 'end') renderEnd(); },
    showRun(view: UbState, info?: { practice?: boolean }): void {
      const nextPractice = Boolean(info?.practice);
      if (mode !== 'play' || nextPractice !== practice) { resetRunMemory(); mode = 'play'; base = null; practice = nextPractice; endPanel.hidden = true; }
      if (view !== base) {                                           // a new authoritative snapshot (or a new queued shot)
        const shown = base === null ? null : local;
        base = view; local = engine.clone(view); tickNow = Math.max(local.tick, io.estimatedTick());
        if (shown) catchUp(shown, local);
      }
    },
  };
}

export const unbreakableAdapter: GameAdapter = {
  id: 'unbreakable',
  title: 'UNBREAKABLE',
  heading: 'Aim, fire, paint the names',
  tagline: 'Every brick carries a name of the wall. Aim, fire, break it and the name gets painted. Three minutes on the server clock.',
  lede: 'Every brick carries the name of a real panel of the wall. Aim and fire a burst of balls; when a brick reaches zero its name gets painted. Three minutes on the server clock, one credit per run. Your score is the hit points you remove.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: UbState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: UbState) => state.sim.score,
  statusLine(state: UbState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    const left = state.startTick === null ? 0 : Math.max(0, state.rules.roundTicks - (tick - state.startTick));
    return `Row ${state.sim.turn} · ${fmtClock(left)} left on the server clock`;
  },
  createStage,
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('unbreakable')),
    advance: (state: UbState, tick: number) => engine.advance(state, tick),
  },
};
