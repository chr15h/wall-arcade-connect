// FULL ROW: the browser side. The page shows the platform's authoritative board (with the player's own queued
// placements applied by the very module the verifier runs) and turns a drag, a tap or a key into ONE ordered input:
// { action: 'place', slot, x, y }. It never sends a score, a time or a state.
//
// The names of the wall are a skin, never a rule: piece number k of a run (its draw index, the same for everyone with the
// same seed) carries the k-th name of the wall's snapshot, starting from a point that moves every ISO week. A full line
// "associates" the names of the pieces it is made of. COUPLE, REAL NEIGHBORS and YOUR NAME are flashes and sounds only.
import type { EndStats, GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { allNames, infoOf, panelsOwnedBy, wallIsLive } from '../../shell/wall-data.js';
import { scoringConfiguration } from '../../shell/config.js';
import { rankOf, renderEndScreen, type EndMemo } from '../../share/end-screen.js';
import { fitTweet, tag } from '../../share/post.js';
import dragonUrl from '../../assets/dragon.jpg';
import { fmtClock, lastMinute, ticksLeft } from './clock.js';
import { COUPLES, holderDrawOf, isoWeekKey, panelForDraw, wallNeighbors, weekOffset } from './names.js';
import {
  N, PIECES, createEngine, evaluatePlacement, fits, fitsAnywhere, inputSchema, snapshotSchema, stateSchema,
  type FrState, type Piece,
} from './engine.js';

const engine = createEngine();
const W = 420, H = 800;
const GX = 18, GY = 100, CELL = 48, GRID = CELL * N;                 // the grid: 384 × 384 logical px
const TRAY_Y = 615, SLOT_W = W / 3, TC = 26;                         // the tray: three slots, pieces at 26 px a cell
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', LABEL = '#6B685F', LABEL_LT = '#B0ACA2', BLUE = '#2E7FD6';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
type LineInfo = { label: string; draws: number[]; value: number };
type Mode = 'idle' | 'play' | 'end';
type Shard = { x: number; y: number; vx: number; vy: number; life: number; sz: number };
type Flash = { cells: number[]; t: number };

function createStage(host: HTMLElement, io: StageIO): Stage {
  host.classList.add('fr-arena', 'own-end');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas fr-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'FULL ROW board. Drag a piece from the tray onto the grid, or tap a piece then a cell. Keyboard: 1, 2, 3 pick a piece, arrows move it, Enter places it.');
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  const endPanel = document.createElement('section');
  endPanel.className = 'end-panel'; endPanel.hidden = true; endPanel.setAttribute('aria-label', 'Your run');
  host.append(canvas, endPanel, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let finalScore: number | null = null;
  let view: FrState | null = null;            // the latest authoritative (or predicted) state shown
  let seen: FrState | null = null;            // the state the cell owners were last reconciled with
  let owner: number[] = Array.from({ length: N * N }, () => -1);   // draw index of the piece that painted each cell
  let effectsUpTo = 0;                        // placements whose effects were already played (no replay after a rebuild)
  let offset = 0, holder: { draw: number; pos: number } | null = null, holderAnnounced = false;
  let best: LineInfo | null = null;
  const neighborPairs = new Set<string>();
  let rowText = '', rowT = 0, refText = '', refT = 0, combo = { n: 0, t: 0 }, shake = 0;
  let shards: Shard[] = [], flashes: Flash[] = [];
  let selected = -1;                          // tap-tap: the tray slot picked, or -1
  let kb = { x: 3, y: 3, on: false };         // keyboard cursor (top-left cell of the piece)
  let hover: { x: number; y: number } | null = null;
  let drag: { slot: number; id: number; pointerId: number; x0: number; y0: number; x: number; y: number; moved: boolean; touch: boolean; grow: number } | null = null;
  let back: { slot: number; x: number; y: number; t: number } | null = null;   // a dropped piece flying back to the tray
  let touched: { draw: number; t: number } | null = null;   // a placed piece touched: its full name, outlined
  let painted: number[] = [];                 // draw indices placed this run, in order (effects only: not after a reload)
  let moment: { until: number; label: string; draws: number[] } | null = null;   // the first full row of a run: a short pause (on the clock)
  const momentLeft = (): number => (moment ? Math.max(0, (moment.until - performance.now()) / 1000) : 0);
  let endStats: EndStats | null = null;
  let dirty = true, DPRc = 1;

  /* ------------------------------ text helpers ----------------------------- */
  function mono(s: string, x: number, y: number, size: number, col: string, align: 'left' | 'center' | 'right', sp = 0.16, weight = 400, g: CanvasRenderingContext2D = ctx): number {
    const adv = size * 0.6 + size * sp, w = s.length * adv - size * sp;
    g.font = `${weight} ${size}px ${F_MONO}`; g.fillStyle = col; g.textBaseline = 'middle'; g.textAlign = 'left';
    const sx = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
    for (let i = 0; i < s.length; i++) g.fillText(s[i] as string, sx + i * adv, y);
    return w;
  }
  const monoWidth = (len: number, size: number, sp: number): number => len * (size * 0.6 + size * sp) - size * sp;
  const anton = (s: string, x: number, y: number, size: number, col: string, align: CanvasTextAlign = 'left'): void => {
    ctx.font = `${size}px ${F_ANTON}`; ctx.fillStyle = col; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(s, x, y);
  };
  function fitAnton(s: string, maxW: number, maxSize: number): number {
    ctx.font = `100px ${F_ANTON}`; const w = ctx.measureText(s).width || 1; return Math.min(maxSize, 100 * maxW / w);
  }

  /* ------------------------------ names helpers ---------------------------- */
  const panelOf = (draw: number): number => panelForDraw(draw, offset, holder);
  const nameOfDraw = (draw: number): string => (infoOf(panelOf(draw)).name || '?').toUpperCase();
  const handleOfDraw = (draw: number): string => infoOf(panelOf(draw)).handle;
  const isHolderDraw = (draw: number): boolean => holder !== null && draw === holder.draw;

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
      if (AC.state === 'suspended' && document.visibilityState === 'visible') void AC.resume();
    } catch { /* no audio */ }
  }
  // pause: no sound while the page is hidden or loses focus (nothing else runs on a clock here)
  const suspend = (): void => { try { if (AC && AC.state === 'running') void AC.suspend(); } catch { /* ignore */ } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') suspend(); });
  addEventListener('blur', suspend);
  addEventListener('focus', () => { if (AC && !muted) initAudio(); });
  function tone(f: number, d: number, type: OscillatorType, vol: number, slide?: number, delay = 0): void {
    if (muted || !AC || sndBudget <= 0) return; sndBudget--;
    const t0 = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
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
    pick: () => tone(240, 0.04, 'triangle', 0.05, 200),
    place: () => { thud(0.06, 0.16, 500); tone(110, 0.07, 'triangle', 0.08, 80); },
    nope: () => tone(95, 0.08, 'triangle', 0.06, 70),
    clear: (lines: number) => { thud(0.16, 0.26, 700); tone(70, 0.18, 'triangle', 0.17, 45); tone(380 + lines * 60, 0.06, 'square', 0.035, 300); },
    combo: (n: number) => tone(260 + n * 40, 0.09, 'triangle', 0.07, 320 + n * 50),
    ref: () => { tone(523, 0.12, 'triangle', 0.07); tone(784, 0.16, 'triangle', 0.06, undefined, 0.11); },
    over: () => { tone(90, 0.5, 'sawtooth', 0.08, 40); thud(0.3, 0.18, 400); },
  };
  const buzz = (ms: number): void => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

  /* ------------------------- following the board ---------------------------- */
  function resetRunMemory(seed: number): void {
    owner = Array.from({ length: N * N }, () => -1);
    seen = null; effectsUpTo = 0; best = null; neighborPairs.clear();
    rowText = ''; rowT = 0; refText = ''; refT = 0; combo = { n: 0, t: 0 }; shards = []; flashes = [];
    selected = -1; drag = null; back = null; hover = null; kb = { x: 3, y: 3, on: false }; finalScore = null;
    offset = weekOffset(isoWeekKey(new Date()));
    const mine = panelsOwnedBy(io.playerAddress?.());
    holder = mine.length ? { draw: holderDrawOf(seed), pos: mine[0] as number } : null;
    holderAnnounced = false; painted = []; moment = null; endStats = null; postMemo.key = ''; postMemo.anchor = null; postMemo.drawn = '';
  }
  const say = (text: string): void => { rowText = text; rowT = 2.2; };   // the names line shows on an event only
  const flashRef = (text: string): void => { refText = text; refT = 1; SND.ref(); buzz(12); };

  /** The cells of a placement, as cell indices. */
  const cellsOf = (piece: Piece, x: number, y: number): number[] => piece.cells.map(([dx, dy]) => (y + dy) * N + x + dx);

  /** One new placement seen (prev → next): give its cells to its piece, then play what it did. */
  function applyMove(prev: FrState, next: FrState): void {
    const last = next.play.last;
    if (!last) return;
    const [slot, x, y] = last;
    const id = prev.play.hand[slot];
    if (id === undefined || id < 0) return;
    const piece = PIECES[id] as Piece, draw = prev.play.drawn - 3 + slot;
    const cells = cellsOf(piece, x, y);
    for (const c of cells) owner[c] = draw;
    const result = evaluatePlacement(prev.play.rows, prev.play.combo, piece, x, y);
    const fresh = next.play.placed > effectsUpTo;
    if (fresh) painted.push(draw);
    // REAL NEIGHBORS: a cell of this piece touches, left or right, a piece whose panel is its neighbour on the real wall
    if (fresh) {
      const me = panelOf(draw);
      for (const c of cells) {
        const cx = c % N;
        for (const side of [-1, 1]) {
          const nx = cx + side; if (nx < 0 || nx >= N) continue;
          const other = owner[c + side] as number; if (other < 0 || other === draw) continue;
          const them = panelOf(other);
          if (side < 0 ? wallNeighbors(them, me) : wallNeighbors(me, them)) {
            const key = `${Math.min(me, them)}:${Math.max(me, them)}`;
            if (!neighborPairs.has(key)) {
              neighborPairs.add(key);
              const [l, r] = side < 0 ? [other, draw] : [draw, other];
              flashRef(`REAL NEIGHBORS · ${nameOfDraw(l)} | ${nameOfDraw(r)}`);
            }
          }
        }
      }
    }
    if (result.lines > 0) {
      const lines: LineInfo[] = [];
      const perLine = result.lineGain / result.lines;
      for (let r = 0; r < N; r++) if (result.rowMask & (1 << r)) lines.push(lineInfo(`ROW ${r + 1}`, Array.from({ length: N }, (_, i) => r * N + i), perLine));
      for (let c = 0; c < N; c++) if (result.colMask & (1 << c)) lines.push(lineInfo(`COL ${c + 1}`, Array.from({ length: N }, (_, i) => i * N + c), perLine));
      const cleared: number[] = [];
      for (let i = 0; i < N * N; i++) {
        const r = Math.floor(i / N), c = i % N;
        if ((result.rowMask & (1 << r)) || (result.colMask & (1 << c))) cleared.push(i);
      }
      if (fresh) {
        for (const line of lines) if (!best || line.value > best.value) best = { ...line, draws: [...line.draws] };
        if (prev.play.lines === 0) {                // the run's first full row: a real moment
          const draws: number[] = []; for (const line of lines) for (const d of line.draws) if (!draws.includes(d)) draws.push(d);
          moment = { until: performance.now() + 700, label: lines.length > 1 ? `${lines.length} LINES PAINTED` : `${(lines[0] as LineInfo).label.startsWith('COL') ? 'COLUMN' : 'ROW'} PAINTED`, draws };
        }
        say(lines.map((line) => `${line.label} · ${line.draws.map(nameOfDraw).join(' · ')}`).join('  /  '));
        flashes.push({ cells: cleared, t: 0 });
        SND.clear(result.lines); shake = Math.max(shake, 2 + result.lines); buzz(10 + 6 * result.lines);
        if (result.combo >= 2) { combo = { n: result.combo, t: 1 }; SND.combo(result.combo); }
        if (result.allClear) flashRef(`GRID CLEAR · +300`);
        for (const line of lines) {
          const names = new Set(line.draws.map(nameOfDraw));
          for (const [a, b] of COUPLES) if (names.has(a) && names.has(b)) flashRef(`COUPLE · ${a} + ${b}`);
        }
      }
      for (const i of cleared) owner[i] = -1;
    } else if (fresh) SND.place();
    if (fresh) effectsUpTo = next.play.placed;
  }
  function lineInfo(label: string, cells: number[], value: number): LineInfo {
    const draws: number[] = [];
    for (const c of cells) { const d = owner[c] as number; if (d >= 0 && !draws.includes(d)) draws.push(d); }
    return { label, draws, value };
  }
  /** Take in a new view: attribute the new placement if there is exactly one, then make the owners agree with the grid. */
  function follow(next: FrState): void {
    if (seen && seen.seed === next.seed && next.play.placed === seen.play.placed + 1) applyMove(seen, next);
    else if (seen && next.play.placed > seen.play.placed + 1) effectsUpTo = Math.max(effectsUpTo, next.play.placed);   // a jump (reload): cells stay unnamed
    if (!seen && next.play.placed > 0) effectsUpTo = next.play.placed;
    for (let i = 0; i < N * N; i++) {
      const filled = ((next.play.rows[Math.floor(i / N)] as number) >> (i % N)) & 1;
      if (!filled) owner[i] = -1;
    }
    if (holder && !holderAnnounced && next.play.drawn > holder.draw) {
      holderAnnounced = true;
      flashRef(`YOUR NAME · ${(infoOf(holder.pos).name || '').toUpperCase()}`);
    }
    if (next.play.stuckTick !== null && (!seen || seen.play.stuckTick === null)) { say('NO PIECE FITS ANY MORE'); SND.over(); }
    seen = next;
  }

  /* ------------------------------ input helpers ---------------------------- */
  const canPlay = (): boolean => mode === 'play' && view !== null && view.started && !view.gameOver && view.play.stuckTick === null && momentLeft() <= 0 && io.canInput();
  const handPiece = (slot: number): Piece | null => { const id = view?.play.hand[slot]; return id === undefined || id < 0 ? null : PIECES[id] as Piece; };
  const pieceFits = (slot: number): boolean => { const p = handPiece(slot); return Boolean(p && view && fitsAnywhere(view.play.rows, p)); };
  /** Nearest legal top-left cell for a piece whose top-left sits at the fractional cell (fx, fy), within `reach` cells. */
  function snap(piece: Piece, fx: number, fy: number, reach: number): { x: number; y: number } | null {
    if (!view) return null;
    let bestPos: { x: number; y: number } | null = null, bd = reach * reach;
    for (let y = Math.floor(fy) - 1; y <= Math.ceil(fy) + 1; y++) for (let x = Math.floor(fx) - 1; x <= Math.ceil(fx) + 1; x++) {
      if (!fits(view.play.rows, piece, x, y)) continue;
      const d = (x - fx) * (x - fx) + (y - fy) * (y - fy);
      if (d <= bd) { bd = d; bestPos = { x, y }; }
    }
    return bestPos;
  }
  const lift = (piece: Piece, touch: boolean): number => (touch ? piece.h * CELL + 34 : piece.h * CELL / 2);
  function dragTarget(): { x: number; y: number } | null {
    if (!drag || !drag.moved) return null;
    const piece = PIECES[drag.id] as Piece;
    const left = drag.x - piece.w * CELL / 2, top = drag.y - lift(piece, drag.touch);
    return snap(piece, (left - GX) / CELL, (top - GY) / CELL, 0.85);
  }
  function tapTarget(slot: number, px: number, py: number): { x: number; y: number } | null {
    const piece = handPiece(slot); if (!piece) return null;
    const cx = (px - GX) / CELL - 0.5, cy = (py - GY) / CELL - 0.5;
    return snap(piece, cx - (piece.w - 1) / 2, cy - (piece.h - 1) / 2, 1.2);
  }
  function placeAt(slot: number, x: number, y: number): boolean {
    const piece = handPiece(slot);
    if (!piece || !view || !canPlay() || !fits(view.play.rows, piece, x, y)) { SND.nope(); return false; }
    io.sendInput({ action: 'place', slot, x, y });
    selected = -1; kb.on = false;
    return true;
  }
  const slotAt = (x: number, y: number): number => (y > GY + GRID + 12 && y < H - 40 ? Math.min(2, Math.max(0, Math.floor(x / SLOT_W))) : -1);
  const cellAt = (x: number, y: number): number => {
    const cx = Math.floor((x - GX) / CELL), cy = Math.floor((y - GY) / CELL);
    return cx >= 0 && cx < N && cy >= 0 && cy < N ? cy * N + cx : -1;
  };

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
  const dragon = new Image(); let dragonReady = false;
  dragon.onload = () => { dragonReady = true; dirty = true; }; dragon.src = dragonUrl;
  function drawDragon(x: number, y: number, w: number): void {
    if (!dragonReady || !dragon.naturalWidth) return;
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(dragon, x, y, w, w * dragon.naturalHeight / dragon.naturalWidth); ctx.restore();
  }

  /* -------------------------------- drawing -------------------------------- */
  /** A name written across a run of cells, chalk on ink; on a run of one or two cells, its first three letters. */
  function nameOnRun(name: string, x0: number, y0: number, len: number, vertical: boolean, cell: number, col: string, short: boolean, maxSize: number): void {
    const avail = len * cell - 8;
    let text = short ? name.replace(/[^A-Z0-9]/g, '').slice(0, 3) || name.slice(0, 3) : name;
    let size = Math.min(maxSize, avail / Math.max(1, text.length * 0.7 - 0.1));
    if (size < 8 && !short) {
      size = 8; const fit = Math.max(2, Math.floor((avail + 0.8) / 5.6));
      if (text.length > fit) text = `${text.slice(0, fit - 1)}…`;
    }
    ctx.save();
    if (vertical) { ctx.translate(x0 + cell / 2, y0 + len * cell / 2); ctx.rotate(-Math.PI / 2); mono(text, 0, 0, size, col, 'center', 0.1, 500); }
    else mono(text, x0 + len * cell / 2, y0 + cell / 2 + 0.5, size, col, 'center', 0.1, 500);
    ctx.restore();
  }
  /** The longest straight run of a set of cells (on a grid of width `cols`): [start cell, length, vertical]. */
  function longestRun(cells: readonly (readonly [number, number])[]): [number, number, number, boolean] {
    const set = new Set(cells.map(([x, y]) => `${x},${y}`));
    let bx = 0, by = 0, bl = 0, bv = false;
    for (const [x, y] of cells) {
      if (!set.has(`${x - 1},${y}`)) { let l = 1; while (set.has(`${x + l},${y}`)) l++; if (l > bl) { bl = l; bx = x; by = y; bv = false; } }
      if (!set.has(`${x},${y - 1}`)) { let l = 1; while (set.has(`${x},${y + l}`)) l++; if (l > bl) { bl = l; bx = x; by = y; bv = true; } }
    }
    return [bx, by, bl, bv];
  }
  function drawGrid(S: FrState): void {
    const rows = S.play.rows;
    // empty cells: concrete; ink 1 px rules
    ctx.fillStyle = CONCRETE; ctx.fillRect(GX, GY, GRID, GRID);
    ctx.fillStyle = INK;
    for (let i = 0; i <= N; i++) { ctx.fillRect(GX + i * CELL, GY, 1, GRID + 1); ctx.fillRect(GX, GY + i * CELL, GRID + 1, 1); }
    // ghost: where the piece in hand would land, and the lines it would complete
    let ghost: { piece: Piece; x: number; y: number } | null = null;
    if (canPlay()) {
      const target = drag ? dragTarget() : (selected >= 0 && kb.on ? { x: kb.x, y: kb.y } : (selected >= 0 && hover ? tapTarget(selected, hover.x, hover.y) : null));
      const piece = drag ? PIECES[drag.id] as Piece : (selected >= 0 ? handPiece(selected) : null);
      if (target && piece && fits(rows, piece, target.x, target.y)) ghost = { piece, x: target.x, y: target.y };
    }
    if (ghost) {
      const r = evaluatePlacement(rows, S.play.combo, ghost.piece, ghost.x, ghost.y);
      ctx.fillStyle = 'rgba(46,127,214,0.16)';
      for (let i = 0; i < N; i++) {
        if (r.rowMask & (1 << i)) ctx.fillRect(GX + 1, GY + i * CELL + 1, GRID - 1, CELL - 1);
        if (r.colMask & (1 << i)) ctx.fillRect(GX + i * CELL + 1, GY + 1, CELL - 1, GRID - 1);
      }
    }
    // placed blocks: ink; a concrete seam between two different pieces
    for (let i = 0; i < N * N; i++) {
      const cx = i % N, cy = Math.floor(i / N);
      if (!(((rows[cy] as number) >> cx) & 1)) continue;
      ctx.fillStyle = INK; ctx.fillRect(GX + cx * CELL, GY + cy * CELL, CELL + 1, CELL + 1);
    }
    ctx.fillStyle = CONCRETE;
    for (let i = 0; i < N * N; i++) {
      const cx = i % N, cy = Math.floor(i / N);
      if (!(((rows[cy] as number) >> cx) & 1)) continue;
      const o = owner[i] as number;
      if (cx < N - 1 && (((rows[cy] as number) >> (cx + 1)) & 1) && owner[i + 1] !== o) ctx.fillRect(GX + (cx + 1) * CELL - 1, GY + cy * CELL + 2, 2, CELL - 3);
      if (cy < N - 1 && (((rows[cy + 1] as number) >> cx) & 1) && owner[i + N] !== o) ctx.fillRect(GX + cx * CELL + 2, GY + (cy + 1) * CELL - 1, CELL - 3, 2);
    }
    // the names, chalk, across each piece's longest run
    const byDraw = new Map<number, [number, number][]>();
    for (let i = 0; i < N * N; i++) { const d = owner[i] as number; if (d >= 0) { const list = byDraw.get(d) ?? []; list.push([i % N, Math.floor(i / N)]); byDraw.set(d, list); } }
    for (const [d, cells] of byDraw) {
      const [x, y, len, vertical] = longestRun(cells);
      nameOnRun(nameOfDraw(d), GX + x * CELL, GY + y * CELL, len, vertical, CELL, CHALK, cells.length <= 2, 15);
      if (isHolderDraw(d)) outline(cells, GX, GY, CELL, BLUE, 3);
    }
    if (touched && touched.t > 0) { const cells = [...byDraw.get(touched.draw) ?? []]; if (cells.length) outline(cells, GX, GY, CELL, CHALK, 2); }
    if (ghost) {
      ctx.fillStyle = 'rgba(46,127,214,0.72)';
      for (const [dx, dy] of ghost.piece.cells) ctx.fillRect(GX + (ghost.x + dx) * CELL + 1, GY + (ghost.y + dy) * CELL + 1, CELL - 1, CELL - 1);
    }
    // a full line: a chalk flash, then square ink shards
    for (const f of flashes) {
      if (f.t >= 0.14) continue;
      for (const i of f.cells) {
        const x = GX + (i % N) * CELL, y = GY + Math.floor(i / N) * CELL;
        ctx.fillStyle = CHALK; ctx.fillRect(x + 1, y + 1, CELL - 1, CELL - 1);
      }
    }
  }
  /** The outer border of a set of cells. */
  function outline(cells: readonly (readonly [number, number])[], x0: number, y0: number, cell: number, col: string, lw: number): void {
    const set = new Set(cells.map(([x, y]) => `${x},${y}`));
    ctx.fillStyle = col;
    for (const [x, y] of cells) {
      const px = x0 + x * cell, py = y0 + y * cell;
      if (!set.has(`${x},${y - 1}`)) ctx.fillRect(px, py, cell + 1, lw);
      if (!set.has(`${x},${y + 1}`)) ctx.fillRect(px, py + cell + 1 - lw, cell + 1, lw);
      if (!set.has(`${x - 1},${y}`)) ctx.fillRect(px, py, lw, cell + 1);
      if (!set.has(`${x + 1},${y}`)) ctx.fillRect(px + cell + 1 - lw, py, lw, cell + 1);
    }
  }
  function drawPiece(piece: Piece, left: number, top: number, cell: number, draw: number, state: 'on' | 'off' | 'picked', nameMax: number): void {
    const fill = state === 'off' ? LABEL_LT : INK, text = state === 'off' ? LABEL : CHALK;
    ctx.fillStyle = fill;
    for (const [dx, dy] of piece.cells) ctx.fillRect(left + dx * cell, top + dy * cell, cell - 1, cell - 1);
    const [x, y, len, vertical] = longestRun(piece.cells);
    const name = nameOfDraw(draw);
    const room = len * cell - 8, onPiece = Math.min(nameMax, room / Math.max(1, name.length * 0.7 - 0.1)) >= 9;
    if (onPiece) nameOnRun(name, left + x * cell, top + y * cell, len, vertical, cell, text, false, nameMax);
    else {
      const size = Math.max(9, Math.min(14, (SLOT_W - 12) / Math.max(1, name.length * 0.7 - 0.1)));
      let t = name; const fit = Math.floor((SLOT_W - 10 + size * 0.1) / (size * 0.7));
      if (t.length > fit) t = `${t.slice(0, fit - 1)}…`;
      mono(t, left + piece.w * cell / 2, top + piece.h * cell + 13, size, state === 'off' ? LABEL : INK, 'center', 0.1, 500);
    }
    if (isHolderDraw(draw)) outline(piece.cells, left, top, cell - 1, BLUE, 2.5);
    if (state === 'picked') outline(piece.cells, left - 1, top - 1, cell - 1, BLUE, 2);
  }
  function drawTray(S: FrState): void {
    ctx.fillStyle = INK; ctx.fillRect(0, GY + GRID + 18, W, 1);
    for (let slot = 0; slot < 3; slot++) {
      const id = S.play.hand[slot] as number; if (id < 0) continue;
      if (drag && drag.slot === slot && drag.moved) continue;
      const piece = PIECES[id] as Piece, draw = S.play.drawn - 3 + slot;
      let left = SLOT_W * slot + SLOT_W / 2 - piece.w * TC / 2, top = TRAY_Y - piece.h * TC / 2;
      if (back && back.slot === slot) { const k = Math.min(1, back.t / 0.16); left = back.x + (left - back.x) * k; top = back.y + (top - back.y) * k; }
      const fitsNow = fitsAnywhere(S.play.rows, piece);
      drawPiece(piece, left, top, TC, draw, !fitsNow ? 'off' : (selected === slot ? 'picked' : 'on'), 13);
    }
  }
  function drawDragged(S: FrState): void {
    if (!drag || !drag.moved) return;
    const piece = PIECES[drag.id] as Piece, k = Math.min(1, drag.grow);
    const cell = TC + (CELL - TC) * k;
    const left = drag.x - piece.w * cell / 2, top = drag.y - (drag.touch ? piece.h * cell + 34 * k : piece.h * cell / 2);
    ctx.globalAlpha = 0.92;
    drawPiece(piece, left, top, cell, S.play.drawn - 3 + drag.slot, 'on', 15);
    ctx.globalAlpha = 1;
  }
  /** The very first game on this device shows "drag a piece" until its first placement; never again after. */
  let hintSeen = false;
  try { hintSeen = localStorage.getItem('wall-arcade:full-row:hint') === '1'; } catch { /* storage unavailable */ }
  function drawPlay(S: FrState): void {
    drawDragon(W - 128, H - 178, 230);                                // one dragon, behind the tray, cut by two edges
    // the score, big; the clock only in its last minute; COMBO only while it is on; the names only on an event
    anton(fmtScore(S.play.score), W / 2, 46, Math.min(fitAnton(fmtScore(S.play.score), W - 140, 58), 58), INK, 'center');
    const left = ticksLeft(S, Math.max(S.tick, io.estimatedTick()));
    if (lastMinute(left)) mono(fmtClock(left), W - 16, 30, 16, INK, 'right', 0.08, 500);
    let line = '', lineCol = INK;
    if (rowT > 0 && rowText) line = rowText;
    else if (S.play.combo >= 2) { line = `COMBO ×${S.play.combo}`; lineCol = BLUE; }
    else if (lastMinute(left)) line = 'LAST MINUTE';
    if (line) {
      const size = 15;
      let s = line; const fit = Math.floor((W - 32) / (size * 0.66));
      if (s.length > fit) s = `${s.slice(0, fit - 1)}…`;
      mono(s, W / 2, 86, size, lineCol, 'center', 0.06, 500);
    }
    drawGrid(S);
    ctx.fillStyle = INK; for (const p of shards) ctx.fillRect(p.x, p.y, p.sz, p.sz);
    drawTray(S);
    drawDragged(S);
    if (combo.t > 0) {
      const size = Math.min(110, 46 + combo.n * 7) * (1 + 0.25 * (1 - combo.t));
      ctx.globalAlpha = Math.min(1, combo.t * 1.6);
      anton(`COMBO ×${combo.n}`, GX + GRID / 2, GY + GRID / 2, fitAnton(`COMBO ×${combo.n}`, GRID - 20, size), BLUE, 'center');
      ctx.globalAlpha = 1;
    }
    if (moment && momentLeft() > 0) {
      ctx.fillStyle = 'rgba(222,219,211,0.9)'; ctx.fillRect(GX - 6, GY - 6, GRID + 12, GRID + 12);
      ctx.fillStyle = INK; ctx.fillRect(GX - 6, GY - 6, GRID + 12, 2); ctx.fillRect(GX - 6, GY + GRID + 4, GRID + 12, 2);
      const grow = 1 + 0.06 * (1 - momentLeft() / 0.7);
      anton(moment.label, W / 2, GY + 62, fitAnton(moment.label, GRID - 30, 54) * grow, INK, 'center');
      const names = moment.draws.map(nameOfDraw).slice(0, 6), top = GY + 116, lh = Math.min(52, (GRID - 140) / Math.max(1, names.length));
      names.forEach((nm, i) => anton(nm, W / 2, top + lh * (i + 0.5), Math.min(fitAnton(nm, GRID - 40, lh * 0.95), lh * 0.95), INK, 'center'));
    }
    if (refT > 0 && momentLeft() <= 0) {
      const y = GY + GRID / 2 - 26;
      ctx.fillStyle = CHALK; ctx.fillRect(GX - 6, y - 18, GRID + 12, 36);
      ctx.fillStyle = INK; ctx.fillRect(GX - 6, y - 18, GRID + 12, 1); ctx.fillRect(GX - 6, y + 18, GRID + 12, 1);
      let t = refText; if (t.length > 40) t = `${t.slice(0, 39)}…`;
      mono(t, W / 2, y, Math.max(13, Math.min(15, (GRID - 10) / Math.max(1, t.length * 0.7))), INK, 'center', 0.06, 500);
    }
    if (!hintSeen && S.play.placed > 0) { hintSeen = true; try { localStorage.setItem('wall-arcade:full-row:hint', '1'); } catch { /* storage unavailable */ } }
    if (!hintSeen && canPlay() && !drag && selected < 0) mono(COARSE ? 'DRAG A PIECE ONTO THE GRID' : 'DRAG OR CLICK A PIECE', W / 2, H - 84, 15, LABEL, 'center', 0.1, 500);
    else if (S.play.stuckTick !== null) mono('NO PIECE FITS · RUN OVER', W / 2, H - 84, 15, INK, 'center', 0.1, 500);
  }
  function drawIdle(): void {
    drawDragon(W - 150, H - 330, 270);                                // smaller, cut by the right edge, behind the overlay
  }
  function draw(): void {
    const pw = Math.round(W * DPRc), ph = Math.round(H * DPRc);
    if (!wmCanvas || wmCanvas.width !== pw || wmCanvas.height !== ph) buildWatermark();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(wmCanvas as HTMLCanvasElement, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (mode === 'play' && view) drawPlay(view);
    else if (mode !== 'end') drawIdle();                               // the end: the card covers the board
  }

  /* --------------------------------- input --------------------------------- */
  const point = (e: PointerEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H]; };
  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (mode !== 'play' || !view) return;
    const [x, y] = point(e);
    e.preventDefault();
    const slot = slotAt(x, y);
    if (slot >= 0 && canPlay() && handPiece(slot)) {
      if (!pieceFits(slot)) { SND.nope(); say(`${nameOfDraw(view.play.drawn - 3 + slot)} FITS NOWHERE`); return; }
      drag = { slot, id: view.play.hand[slot] as number, pointerId: e.pointerId, x0: x, y0: y, x, y, moved: false, touch: e.pointerType !== 'mouse', grow: 0 };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      return;
    }
    const cell = cellAt(x, y);
    if (cell >= 0 && selected >= 0 && canPlay()) {
      const target = tapTarget(selected, x, y);
      if (target) placeAt(selected, target.x, target.y); else SND.nope();
      return;
    }
    if (cell >= 0 && (owner[cell] as number) >= 0) {                   // a long press on a placed piece: its panel
      const d = owner[cell] as number;
      window.clearTimeout(press.timer);
      press = { id: e.pointerId, x, y, timer: window.setTimeout(() => {
        const pos = panelOf(d), info = infoOf(pos);
        touched = { draw: d, t: 1.6 };
        say(`PANEL #${pos} · ${(info.name || '?').toUpperCase()}${info.handle ? ` · @${info.handle}` : ''}`);
      }, 450) };
    }
  });
  let press: { id: number; x: number; y: number; timer: number } = { id: -1, x: 0, y: 0, timer: 0 };
  const cancelPress = (e: PointerEvent): void => { if (e.pointerId === press.id) { window.clearTimeout(press.timer); press.id = -1; } };
  canvas.addEventListener('pointerup', cancelPress);
  canvas.addEventListener('pointercancel', cancelPress);
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = point(e);
    if (e.pointerId === press.id && Math.hypot(x - press.x, y - press.y) > 10) cancelPress(e);
    if (drag && e.pointerId === drag.pointerId) {
      drag.x = x; drag.y = y;
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > 8) { drag.moved = true; selected = -1; kb.on = false; SND.pick(); }
      return;
    }
    if (e.pointerType === 'mouse') { hover = cellAt(x, y) >= 0 ? { x, y } : null; if (hover) kb.on = false; }
  });
  function endDrag(e: PointerEvent, cancelled: boolean): void {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag; drag = null;
    if (!d.moved) { if (!cancelled) { selected = selected === d.slot ? -1 : d.slot; kb.on = false; if (selected >= 0) SND.pick(); } return; }
    drag = d; const target = cancelled ? null : dragTarget(); drag = null;
    if (target && placeAt(d.slot, target.x, target.y)) return;
    const piece = PIECES[d.id] as Piece;
    back = { slot: d.slot, x: d.x - piece.w * TC / 2, y: d.y - piece.h * TC / 2, t: 0 };   // no room: the piece goes back to the tray
  }
  canvas.addEventListener('pointerup', (e) => endDrag(e, false));
  canvas.addEventListener('pointercancel', (e) => endDrag(e, true));
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hover = null; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    if (mode !== 'play' || !view) return;
    initAudio();
    const n = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].indexOf(e.code);
    if (n >= 0) { const slot = n % 3; if (handPiece(slot) && pieceFits(slot)) { selected = slot; kb.on = true; SND.pick(); } else SND.nope(); e.preventDefault(); return; }
    if (selected < 0) return;
    const piece = handPiece(selected); if (!piece) return;
    const move = (dx: number, dy: number): void => { kb.on = true; kb.x = Math.max(0, Math.min(N - piece.w, kb.x + dx)); kb.y = Math.max(0, Math.min(N - piece.h, kb.y + dy)); e.preventDefault(); };
    if (e.code === 'ArrowLeft') move(-1, 0); else if (e.code === 'ArrowRight') move(1, 0);
    else if (e.code === 'ArrowUp') move(0, -1); else if (e.code === 'ArrowDown') move(0, 1);
    else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); if (!e.repeat) placeAt(selected, Math.min(kb.x, N - piece.w), Math.min(kb.y, N - piece.h)); }
    else if (e.code === 'Escape') { selected = -1; kb.on = false; }
  });

  /* ------------------------------- end screen -------------------------------- */
  // One screen (src/share/end-screen.ts): the card (final grid, best row in blue, score, rank, names, player), POST ON X.
  /** The player on a card: their ENS (from the leaderboard) or their shortened address; nothing when signed out. */
  function cardPlayer(): string | undefined {
    if (endStats?.player) return endStats.player;
    const address = io.playerAddress?.();
    return address && /^0x[0-9a-f]{40}$/i.test(address) ? address : undefined;
  }
  const postMemo: EndMemo = { key: '', anchor: null, drawn: '' };
  function renderEnd(): void {
    const score = finalScore ?? view?.play.score ?? 0, cabinet = `${location.origin}/`;
    const row = best && best.draws.length ? best : null;
    const player = cardPlayer(), rank = practice ? undefined : rankOf(endStats?.rank);
    const names = row ? row.draws.map(nameOfDraw) : [], grid = view ? [...view.play.rows] : undefined;
    const extra = { ...(grid ? { grid } : {}), ...(rank ? { rank } : {}), ...(player ? { player } : {}) };
    renderEndScreen(endPanel, {
      game: 'FULL ROW', cabinet,
      card: { kind: 'row', data: { names, ...(row ? { line: row.label } : {}), score, practice, ...extra } },
      post: row && !practice ? { kind: 'row', names, line: row.label, score, ...extra } : null,
      tweet: (link) => fitTweet(row ? row.draws.map((d) => tag(nameOfDraw(d), handleOfDraw(d))) : [],
        (list, more) => `I painted ${list}${more ? ' …' : ''} together on THE WALL ARCADE. Beat my row: ${link}`, link),
      postLabel: 'Post on X',
    }, postMemo);
  }

  /* ---------------------------- layout and main loop ------------------------ */
  const frameEl = host.parentElement ?? host;
  function layout(): void {
    const availW = frameEl.clientWidth || 420, availH = frameEl.clientHeight || 800;
    const cssW = Math.max(220, Math.floor(Math.min(availW, availH * W / H)));
    const cssH = Math.floor(cssW * H / W);
    DPRc = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    host.style.width = `${cssW}px`; host.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * DPRc); canvas.height = Math.round(cssH * DPRc);
    host.style.setProperty('--fr-scale', String(cssW / W));
    wmCanvas = null; dirty = true;
  }
  new ResizeObserver(() => layout()).observe(frameEl);
  layout();
  void Promise.race([
    Promise.all([document.fonts.load('40px Anton'), document.fonts.load('500 12px "IBM Plex Mono"')]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]).then(() => { wmCanvas = null; dirty = true; }).catch(() => undefined);

  let liveSeen = wallIsLive(), lastFrame = performance.now();
  function frame(t: number): void {
    requestAnimationFrame(frame);
    if (wallIsLive() !== liveSeen) { liveSeen = wallIsLive(); wmCanvas = null; dirty = true; }
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t; sndBudget = 8;
    for (const p of shards) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 620 * dt; p.life -= dt; }
    shards = shards.filter((p) => p.life > 0);
    for (const f of flashes) {
      const before = f.t; f.t += dt;
      if (before < 0.14 && f.t >= 0.14) for (const i of f.cells) {              // the chalk flash breaks into ink shards
        const x = GX + (i % N + 0.5) * CELL, y = GY + (Math.floor(i / N) + 0.5) * CELL;
        for (let k = 0; k < 3; k++) { const an = Math.random() * 6.283, sp = 50 + Math.random() * 170; shards.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 90, life: 0.45 + Math.random() * 0.35, sz: 3 + Math.random() * 5 }); }
      }
    }
    flashes = flashes.filter((f) => f.t < 0.2);
    if (shake > 0.2) shake *= Math.pow(0.008, dt); else shake = 0;
    if (rowT > 0) rowT -= dt;
    if (refT > 0 && momentLeft() <= 0) refT -= dt;              // a flash waits for the first-row moment to end
    if (combo.t > 0) combo.t -= dt / 0.9;
    if (touched && touched.t > 0) touched.t -= dt;
    if (moment && momentLeft() <= 0) moment = null;
    if (drag && drag.moved && drag.grow < 1) drag.grow = Math.min(1, drag.grow + dt / 0.09);
    if (back) { back.t += dt; if (back.t > 0.16) back = null; }
    if (mode === 'play') draw();
    else if (dirty || shards.length || shake > 0) { draw(); dirty = false; }
  }
  requestAnimationFrame(frame);

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      if (extra?.idle) { mode = 'idle'; endPanel.hidden = true; return; }
      if (extra && typeof extra.final === 'number') {
        finalScore = extra.final;
        practice = Boolean(extra.practice);
        if (!view && extra.view && typeof extra.view === 'object') { view = extra.view as FrState; follow(view); }
        mode = 'end'; drag = null; selected = -1; moment = null;
        renderEnd(); endPanel.hidden = false;
      } else if (mode !== 'end') { mode = 'idle'; endPanel.hidden = true; }
    },
    hideRun(): void { if (mode === 'play') { mode = view && view.gameOver ? 'end' : 'idle'; if (mode === 'end') { renderEnd(); endPanel.hidden = false; } dirty = true; } },
    endStats(stats: EndStats): void {
      endStats = stats;
      if (mode === 'end') renderEnd();
    },
    showRun(next: FrState, info?: { practice?: boolean }): void {
      const nextPractice = Boolean(info?.practice);
      if (mode !== 'play' || nextPractice !== practice || (view && view.seed !== next.seed)) {
        resetRunMemory(next.seed); mode = 'play'; practice = nextPractice; view = null; endPanel.hidden = true;
      }
      if (next !== view) { view = next; follow(next); }
      if (drag && (view.play.hand[drag.slot] ?? -1) !== drag.id) drag = null;   // the piece being dragged was placed meanwhile
      if (selected >= 0 && !pieceFits(selected)) selected = -1;
    },
  };
}

export const fullRowAdapter: GameAdapter = {
  id: 'full-row',
  title: 'FULL ROW',
  heading: 'Place the names, paint the rows',
  tagline: 'Every piece carries a name of the wall: fill a row and the names get painted together.',
  lede: 'Three pieces at a time, each one carrying a name of the wall. Drop them on the 8 × 8 grid; a full row or column empties and paints the names it joined. Clear again and again for a combo. The run ends when no piece fits. One credit per run, scored by the server.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: FrState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: FrState) => state.play.score,
  statusLine(state: FrState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    if (state.play.stuckTick !== null) return 'No piece fits any more: run over.';
    const left = ticksLeft(state, tick);
    return `Score ${state.play.score} · ${state.play.lines} lines${lastMinute(left) ? ` · last minute: ${fmtClock(left)} left on the server clock` : ''}`;
  },
  createStage,
  diagSummary: (state: FrState) => ({ tick: state.tick, started: state.started, gameOver: state.gameOver, placed: state.play.placed, score: state.play.score, stuck: state.play.stuckTick }),
  practice: {
    createRun: (seed: number) => engine.createRun(seed, scoringConfiguration('full-row')),
    advance: (state: FrState, tick: number) => engine.advance(state, tick),
  },
};
