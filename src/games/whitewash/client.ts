// NFT INVADERS: the browser side. The page shows the platform's authoritative screen (advanced to the current server
// tick by the very module the verifier runs, with the player's own queued moves applied) and turns a drag, a touch or a
// held key into ONE kind of ordered input: { action: 'move', x }, where the dragon should go. The dragon sprays by
// itself. The page never sends a score, a time or a state.
//
// The names of the wall are a skin, never a rule: the 8 bricks carry 8 real neighbours of the painted wall (the same
// pick as SIGNAGE's, from the seed). The signed-in player's walking sprite stands guard in place of the dragon.
import type { GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { HitFeed } from '../../shell/hits.js';
import { allNames, infoOf, wallIsLive } from '../../shell/wall-data.js';
import { scoringConfiguration } from '../../shell/config.js';
import dragonUrl from '../../assets/dragon.jpg';
import { loadPeople, onPeople, sheetOfWallet } from '../../shell/people.js';
import { DIR, drawSprite, stepAt } from '../../share/sprite.js';
import { bricksFor } from '../signage/names.js';
import { onArt, type Art } from './art.js';
import {
  BRICK_W, BRICK_X0, DIVING, H, IN_FORMATION, RULES, SHIP_HH, SHIP_Y, W, WALL_Y, bitCount, streakMult,
  createEngine, inputSchema, snapshotSchema, stateSchema, type Cleaner, type WwState,
} from './engine.js';

const engine = createEngine();
const TICK_MS = 50;
const BRICK_H = 44;                                                   // clear of the page's SOUND button under them
const INK = '#0B0B0B', CHALK = '#F2F0EB', CONCRETE = '#DEDBD3', LABEL = '#6B685F', LABEL_LT = '#B0ACA2', BLUE = '#2E7FD6';
const F_ANTON = 'Anton, Impact, "Arial Narrow", sans-serif', F_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const COARSE = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
const fmtClock = (ticks: number): string => { const s = Math.max(0, Math.ceil(ticks * TICK_MS / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtScore = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const ticksLeft = (S: WwState, tick: number): number =>
  Math.max(0, S.startTick === null ? S.rules.roundTicks : S.rules.roundTicks - (tick - S.startTick));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
type Mode = 'idle' | 'play' | 'end';
type Spark = { x: number; y: number; vx: number; vy: number; life: number; sz: number; col: string };

/** What tells the two invader games apart: their title, their Survivor feed name and their line-up of art. */
export type InvadersOptions = { title: string; feed: string; art: Art };

function createStage(host: HTMLElement, io: StageIO, opts: InvadersOptions): Stage {
  const hits = new HitFeed(opts.feed);
  host.classList.add('ww-arena');
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  canvas.className = 'ub-canvas ww-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${opts.title}. Drag or touch to move the dragon left and right, or hold the arrow keys; it sprays by itself. Down the invaders before they whitewash the names.`);
  const soundButton = document.createElement('button');
  soundButton.type = 'button'; soundButton.className = 'ub-sound secondary';
  host.append(canvas, soundButton);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  /* ------------------------------ stage state ------------------------------ */
  let mode: Mode = 'idle';
  let practice = false;
  let base: WwState | null = null;            // the authoritative view the local copy was cloned from
  let local: WwState | null = null;           // that view, stepped to the current server tick
  let prev: WwState | null = null;            // the local copy one tick earlier (positions are drawn in between)
  let tickAt = 0;                             // when the local copy reached its tick (performance.now)
  let tickNow = 0;
  let bricks = bricksFor(0);
  let downedSeen = new Set<number>();
  let washedHigh = 0, clearedHigh = 0, stunSeen = 0, fireSeen = 0, divesSeen = 0, bricksShown = (1 << RULES.bricks) - 1;
  let introSeen = 0, multSeen = 1, namesSeen = RULES.bricks, beatAt = 0, beatN = 0, secondSeen = -1;
  let nearSeen = new Set<number>();
  let sparks: Spark[] = [];
  let nowText = '', nowT = 0, nowBlue = true, shake = 0, flashT = 0, lostT = 0;
  let desired: number | null = null, lastSent = -1, lastSendAt = 0;
  let shownX: number | null = null, frameDt = 0;   // where the dragon is drawn: its own smooth walk, see guardX()
  const keys = { left: false, right: false };
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
  /* names on bricks: Anton capitals fitted to the brick, cut in two lines when one line would be too small */
  const nameCache = new Map<string, { lines: string[]; size: number }>();
  function brickName(name: string, cx: number, cy: number, col: string): void {
    const nm = (name || '—').toUpperCase(), avail = BRICK_W - 8;
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
  // browsers start sound only after a click, a tap or a key: any of them on the page will do (the PRACTICE / PLAY button too)
  addEventListener('pointerdown', () => initAudio(), { capture: true });
  addEventListener('keydown', () => initAudio(), { capture: true });
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
  function thud(d: number, vol: number, freq: number, type: BiquadFilterType = 'lowpass'): void {
    if (muted || !AC || !noiseBuf || sndBudget <= 0) return; sndBudget--;
    const t0 = AC.currentTime, s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    s.connect(f).connect(g).connect(AC.destination); s.start(t0); s.stop(t0 + d + 0.02);
  }
  const SND = {
    spray: () => thud(0.07, 0.035, 2800, 'highpass'),                         // the can: a short hiss per shot
    dive: () => tone(1100, 0.45, 'sine', 0.035, 380),                         // a falling whistle: one of them is coming
    // each collection pops in its own key (wave → collection index)
    down: (dive: boolean, wave: number) => { const k = [1, 1.19, 0.84, 1.33][(Math.max(1, wave) - 1) % 4] as number; thud(0.1, 0.2, dive ? 1200 : 800); tone((dive ? 660 : 440) * k, 0.07, 'square', 0.04, (dive ? 990 : 300) * k); },
    wash: () => { thud(0.35, 0.25, 300); tone(140, 0.3, 'sawtooth', 0.06, 60); },
    stun: () => { tone(300, 0.25, 'triangle', 0.08, 90); },
    wave: () => { tone(392, 0.08, 'triangle', 0.06); setTimeout(() => tone(523, 0.08, 'triangle', 0.06), 90); setTimeout(() => tone(784, 0.14, 'triangle', 0.07), 180); },
    over: () => { tone(90, 0.5, 'sawtooth', 0.09, 40); thud(0.3, 0.2, 400); },
    // the formation's pulse: a spray can's rattle (two clicks of its ball), its tempo set by the wave, not by how many
    // invaders are left (that accelerating march is another game's signature)
    rattle: () => { thud(0.035, 0.11, 2400, 'bandpass'); setTimeout(() => thud(0.03, 0.08, 3000, 'bandpass'), 70); },
    intro: (wave: number) => {                                                  // a wave arrives: a sting in its collection's key
      const base = [262, 311, 220, 349][(Math.max(1, wave) - 1) % 4] as number;
      [1, 1.5, 2].forEach((m, i) => setTimeout(() => tone(base * m, 0.11, 'square', 0.035), i * 85));
    },
    mult: (m: number) => { [1, 1.26, 1.5].forEach((r, i) => setTimeout(() => tone(440 * (1 + (m - 2) * 0.25) * r, 0.08, 'triangle', 0.06), i * 60)); },
    alarm: () => { [0, 160].forEach((d) => setTimeout(() => tone(880, 0.1, 'square', 0.05, 700), d)); },
    tick: (last: boolean) => tone(last ? 1320 : 990, 0.04, 'square', 0.03),
    plip: () => tone(1700, 0.035, 'sine', 0.03, 850),                          // a drip let go
    near: () => { tone(620, 0.05, 'square', 0.035, 760); setTimeout(() => tone(760, 0.05, 'square', 0.035, 930), 60); },   // a diver close to the wall
  };
  const diveVoices = new Map<number, { o: OscillatorNode; g: GainNode }>();
  /** Each diving invader whines, lower and louder as it nears the wall (the three lowest; the others wait their turn). */
  function diveHum(divers: { id: number; y: number }[]): void {
    const keep = new Set<number>();
    if (AC && !muted) {
      for (const d of [...divers].sort((a, b) => b.y - a.y).slice(0, 3)) {
        keep.add(d.id);
        let v = diveVoices.get(d.id);
        if (!v) {
          const o = AC.createOscillator(), g = AC.createGain();
          o.type = 'sawtooth'; g.gain.value = 0; o.connect(g).connect(AC.destination); o.start();
          v = { o, g }; diveVoices.set(d.id, v);
        }
        const k = Math.max(0, Math.min(1, (d.y - 120) / (WALL_Y - 120)));
        v.o.frequency.setTargetAtTime(880 - 620 * k, AC.currentTime, 0.03);
        v.g.gain.setTargetAtTime(0.008 + 0.022 * k, AC.currentTime, 0.05);
      }
    }
    for (const [id, v] of diveVoices) {
      if (keep.has(id)) continue;
      try { v.g.gain.setTargetAtTime(0, (AC as AudioContext).currentTime, 0.02); v.o.stop((AC as AudioContext).currentTime + 0.1); } catch { /* already stopped */ }
      diveVoices.delete(id);
    }
  }
  const buzz = (ms: number): void => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };
  function burst(x: number, y: number, n: number, col: string): void {
    for (let i = 0; i < n; i++) { const an = Math.random() * 6.283, sp = 60 + Math.random() * 190; sparks.push({ x, y, vx: Math.cos(an) * sp, vy: Math.sin(an) * sp - 60, life: 0.4 + Math.random() * 0.4, sz: 2 + Math.random() * 4, col }); }
  }

  /* ------------------------------- run memory ------------------------------ */
  /** The effects of a new local copy (fresh snapshot or a tick further), each played once whatever the rebuilds. */
  function follow(before: WwState | null, next: WwState): void {
    const p = next.play;
    if (p.wave > introSeen && p.waveAt < 0) { introSeen = p.wave; SND.intro(p.wave); }
    const m = streakMult(p.streak);
    if (m > multSeen) SND.mult(m);
    multSeen = m;
    const standing = bitCount(p.bricks);
    if (standing <= 2 && standing > 0 && standing < namesSeen) SND.alarm();
    namesSeen = standing;
    if (before) {
      const after = new Set(p.cleaners.map((c) => c.id));
      for (const c of before.play.cleaners) {
        if (after.has(c.id) || downedSeen.has(c.id) || before.play.wave !== p.wave) continue;
        downedSeen.add(c.id);
        burst(c.x, c.y, 10, c.mode === IN_FORMATION ? INK : BLUE); SND.down(c.mode !== IN_FORMATION, p.wave);
      }
    }
    if (p.washed > washedHigh) {
      for (let b = 0; b < RULES.bricks; b++) {
        if ((bricksShown & (1 << b)) && !(p.bricks & (1 << b))) {
          const panel = bricks[b] ?? 0, name = infoOf(panel).name || `NAME ${b + 1}`;
          if (!practice && panel) hits.add(panel);
          burst(BRICK_X0 + (b + 0.5) * BRICK_W, WALL_Y + 10, 14, CHALK);
          nowText = `WHITEWASHED · ${name.toUpperCase()}`; nowT = 1.5; nowBlue = false;
        }
      }
      washedHigh = p.washed; lostT = 1; SND.wash(); buzz(40); shake = Math.max(shake, 2);
    }
    if (p.cleared > clearedHigh) {
      clearedHigh = p.cleared;
      const back = [...Array(RULES.bricks).keys()].find((b) => !(bricksShown & (1 << b)) && (p.bricks & (1 << b)));
      nowText = back === undefined ? `WAVE ${p.wave} DOWN` : `WAVE ${p.wave} DOWN · ${(infoOf(bricks[back] ?? 0).name || 'A NAME').toUpperCase()} REPAINTED`;
      nowT = 2; nowBlue = true; SND.wave();
    }
    if (p.fireAt > fireSeen) { if (fireSeen > 0) { SND.spray(); flashT = 0.09; } fireSeen = p.fireAt; }
    if (p.dives > divesSeen) { divesSeen = p.dives; SND.dive(); }
    if (before && p.drips.length > before.play.drips.length) SND.plip();
    for (const c of p.cleaners) {
      if (c.mode === DIVING && c.y > WALL_Y - 150 && !nearSeen.has(c.id * 1000 + p.dives)) { nearSeen.add(c.id * 1000 + p.dives); SND.near(); }
    }
    if (p.stunUntil > stunSeen && p.stunUntil > next.tick) { stunSeen = p.stunUntil; SND.stun(); buzz(60); }
    bricksShown = p.bricks;
    if (next.gameOver && !before?.gameOver && p.bricks === 0) SND.over();
  }
  function resetRunMemory(seed: number): void {
    bricks = bricksFor(seed); downedSeen = new Set(); washedHigh = 0; clearedHigh = 0; stunSeen = 0; fireSeen = 0; divesSeen = 0; bricksShown = (1 << RULES.bricks) - 1;
    introSeen = 0; multSeen = 1; namesSeen = RULES.bricks; beatAt = 0; beatN = 0; secondSeen = -1; nearSeen = new Set(); diveHum([]);
    sparks = []; nowText = ''; nowT = 0; shake = 0; flashT = 0; lostT = 0; desired = null; lastSent = -1; prev = null; keys.left = false; keys.right = false; shownX = null; kbX = null;
  }

  /* -------------------------------- drawing -------------------------------- */
  const RAIDER = 44;
  /** A raider: a CC0 character of its wave's collection (art.ts), whitewash dripping off it when it dives. */
  function drawEnemy(seed: number, id: number, x: number, y: number, diving: boolean, tilt: number, now: number): void {
    opts.art.drawRaider(ctx, seed, Math.floor(id / 100), id, x, y, RAIDER, tilt, now);
    if (diving) { ctx.fillStyle = CHALK; ctx.strokeStyle = INK; ctx.lineWidth = 1; for (const dx of [-9, 7]) { ctx.fillRect(x + dx, y + RAIDER / 2 - 2, 3, 7 + (dx > 0 ? 3 : 0)); ctx.strokeRect(x + dx - 0.5, y + RAIDER / 2 - 2.5, 4, 8 + (dx > 0 ? 3 : 0)); } }
  }
  function drawBricks(S: WwState | null, now = 0): void {
    const standing = S ? S.play.bricks : (1 << RULES.bricks) - 1;
    const targeted = new Set((S?.play.cleaners ?? []).filter((c) => c.mode === DIVING).map((c) => c.to));
    const pulse = 0.5 + 0.5 * Math.sin(now / 70);
    for (let b = 0; b < RULES.bricks; b++) {
      const x = BRICK_X0 + b * BRICK_W + 2, w = BRICK_W - 4, up = Boolean(standing & (1 << b));
      ctx.fillStyle = up ? INK : CHALK; ctx.fillRect(x, WALL_Y, w, BRICK_H);
      if (!up) { ctx.strokeStyle = LABEL_LT; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, WALL_Y + 0.5, w - 1, BRICK_H - 1); }
      brickName(infoOf(bricks[b] ?? 0).name, x + w / 2, WALL_Y + BRICK_H / 2, up ? CHALK : LABEL_LT);
      if (up && targeted.has(b)) {                                          // under attack: a blue frame that pulses, a marker above
        ctx.globalAlpha = 0.35 + 0.65 * pulse; ctx.strokeStyle = BLUE; ctx.lineWidth = 3; ctx.strokeRect(x - 1.5, WALL_Y - 1.5, w + 3, BRICK_H + 3);
        ctx.fillStyle = BLUE; ctx.beginPath(); ctx.moveTo(x + w / 2 - 8, WALL_Y - 16); ctx.lineTo(x + w / 2 + 8, WALL_Y - 16); ctx.lineTo(x + w / 2, WALL_Y - 6); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }
  const dragon = new Image(); let dragonReady = false;
  dragon.onload = () => { dragonReady = true; dirty = true; }; dragon.src = dragonUrl;
  function drawGuard(x: number, stunned: boolean, now: number): void {
    const sheet = sheetOfWallet(io.playerAddress?.());
    const blink = stunned && Math.floor(now / 90) % 2 === 0;
    if (blink) ctx.globalAlpha = 0.45;
    if (sheet) drawSprite(ctx, sheet, x - 32, SHIP_Y - 38, 64, stunned ? 0 : stepAt(now), DIR.UP);
    else if (dragonReady && dragon.naturalWidth) {
      const h = 76, w = h * dragon.naturalWidth / dragon.naturalHeight;
      ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(dragon, x - w / 2, SHIP_Y + SHIP_HH - h, w, h); ctx.restore();
    } else { ctx.fillStyle = INK; ctx.fillRect(x - 16, SHIP_Y - SHIP_HH, 32, SHIP_HH * 2); }
    ctx.globalAlpha = 1;
    if (stunned) {                                                       // whitewashed: chalk splats on it
      ctx.fillStyle = CHALK; ctx.strokeStyle = INK; ctx.lineWidth = 1;
      for (const [dx, dy, r] of [[-8, -10, 9], [9, -2, 7], [-2, 10, 8]] as const) { ctx.beginPath(); ctx.arc(x + dx, SHIP_Y + dy, r, 0, 6.283); ctx.fill(); ctx.stroke(); }
    }
  }
  function drawHud(S: WwState): void {
    const p = S.play;
    const size = Math.min(fitAnton(fmtScore(p.score), W - 200, 46), 46);
    anton(fmtScore(p.score), W / 2, 36, size, INK, 'center');
    const mult = streakMult(p.streak);
    if (mult > 1) { ctx.font = `${size}px ${F_ANTON}`; anton(`×${mult}`, W / 2 + ctx.measureText(fmtScore(p.score)).width / 2 + 8, 40, 26, BLUE, 'left'); }
    mono(fmtClock(ticksLeft(S, tickNow)), W - 16, 30, 16, INK, 'right', 0.08, 500);
    mono(`WAVE ${Math.max(1, p.wave)} · ${opts.art.collectionOfWave(p.wave).title}`, W - 16, 54, 12, LABEL, 'right', 0.14, 500);
    const standing = bitCount(p.bricks);                                     // left, under the page's PRACTICE tag
    mono(`NAMES ${standing}/${RULES.bricks}`, 16, 66, 12, standing <= 2 ? INK : LABEL, 'left', 0.14, 500);
    if (lostT > 0) { ctx.globalAlpha = lostT; ctx.fillStyle = INK; ctx.fillRect(16, 74, 84, 2); ctx.globalAlpha = 1; }
    if (nowT > 0 && nowText) {
      let s = nowText; const fit = Math.floor((W - 24) / (13 * 0.76)); if (s.length > fit) s = `${s.slice(0, fit - 1)}…`;
      mono(s, W / 2, 80, 13, nowBlue ? BLUE : INK, 'center', 0.06, 500);
    }
  }
  let hintSeen = false;
  try { hintSeen = localStorage.getItem('wall-arcade:whitewash:hint') === '1'; } catch { /* storage unavailable */ }
  function drawPlay(now: number): void {
    const S = local as WwState, p = S.play, f = Math.max(0, Math.min(1, (now - tickAt) / TICK_MS));
    const old = new Map((prev?.play.cleaners ?? []).map((c) => [c.id, c] as [number, Cleaner]));
    drawHud(S);
    for (const c of p.cleaners) {
      const o = old.get(c.id);
      const tilt = o && c.mode !== IN_FORMATION ? Math.max(-0.5, Math.min(0.5, (c.x - o.x) * 0.08)) : 0;
      drawEnemy(S.seed, c.id, o ? lerp(o.x, c.x, f) : c.x, o ? lerp(o.y, c.y, f) : c.y, c.mode === DIVING, tilt, now);
    }
    ctx.fillStyle = BLUE;
    for (const s of p.shots) ctx.fillRect(s[0] - 3, s[1] - RULES.shotSpeed * f - 8, 6, 14);
    ctx.fillStyle = CHALK; ctx.strokeStyle = INK; ctx.lineWidth = 1;
    for (const d of p.drips) {
      const y = d[1] + RULES.dripSpeed * f;
      ctx.globalAlpha = 0.45; ctx.fillRect(d[0] - 1, y - 24, 2, 15); ctx.globalAlpha = 1;   // its trail
      ctx.beginPath(); ctx.moveTo(d[0], y - 9); ctx.quadraticCurveTo(d[0] + 6, y, d[0], y + 5); ctx.quadraticCurveTo(d[0] - 6, y, d[0], y - 9); ctx.fill(); ctx.stroke();
    }
    const stunned = tickNow < p.stunUntil, gx = guardX(p.x, p.target, stunned);
    if (!stunned && !S.gameOver) {                                          // the aim: where the next shot goes
      ctx.strokeStyle = BLUE; ctx.globalAlpha = 0.28; ctx.lineWidth = 1.5; ctx.setLineDash([3, 7]);
      ctx.beginPath(); ctx.moveTo(gx, SHIP_Y - SHIP_HH - 22); ctx.lineTo(gx, 96); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    drawGuard(gx, stunned, now);
    if (flashT > 0) {                                                        // the can fires: a short blue burst
      ctx.strokeStyle = BLUE; ctx.lineWidth = 2; ctx.globalAlpha = Math.min(1, flashT / 0.05);
      const fy = SHIP_Y - SHIP_HH - 18;
      for (const [dx, dy] of [[0, -9], [-7, -5], [7, -5]] as const) { ctx.beginPath(); ctx.moveTo(gx, fy); ctx.lineTo(gx + dx, fy + dy); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    drawBricks(S, now);
    for (const s of sparks) { ctx.fillStyle = s.col; ctx.fillRect(s.x, s.y, s.sz, s.sz); }
    if (p.waveAt >= 0 && tickNow < p.waveAt && !S.gameOver) {                // the next wave, and whose characters it brings
      const next = opts.art.collectionOfWave(p.wave + 1);
      anton(`WAVE ${p.wave + 1}`, W / 2, 290, 54, INK, 'center');
      anton(next.title, W / 2, 340, 30, BLUE, 'center');
      mono(next.by, W / 2, 372, 12, LABEL, 'center', 0.14, 500);
    }
    if (S.gameOver) {                                                        // why it ended, above the page's end card
      const capped = S.startTick !== null && S.tick >= Math.min(S.rules.maxTicks, S.startTick + S.rules.roundTicks);
      const why = p.bricks === 0 ? 'ALL NAMES WHITEWASHED' : capped ? 'TIME’S UP' : 'NO MOVE FOR 30 SECONDS';
      ctx.fillStyle = INK; ctx.fillRect(0, 96, W, 52);
      anton(why, W / 2, 123, Math.min(fitAnton(why, W - 40, 32), 32), CHALK, 'center');
    }
    if (!hintSeen && S.started) {
      if (p.downed >= 3) { hintSeen = true; try { localStorage.setItem('wall-arcade:whitewash:hint', '1'); } catch { /* storage unavailable */ } }
      mono(COARSE ? 'DRAG TO MOVE · IT SPRAYS BY ITSELF' : 'MOUSE OR ← → TO MOVE · IT SPRAYS BY ITSELF', W / 2, 560, 12, INK, 'center', 0.06, 500);
    }
  }
  /** The dragon on screen walks by itself towards where the player points, at its real speed, every frame. Drawing the
   *  predicted position as is made it hop back and forth: the prediction is corrected each time an input lands a tick
   *  later than guessed (40 px a tick). Display only: the server's position is the one that sprays and gets hit. */
  function guardX(x: number, target: number, stunned: boolean): number {
    if (shownX === null) shownX = x;
    const goal = desired !== null && canPlay() ? Math.round(Math.max(22, Math.min(W - 22, desired))) : target;
    if (!stunned) {
      const reach = RULES.speed * frameDt * 1000 / TICK_MS, d = goal - shownX;
      shownX += Math.abs(d) <= reach ? d : Math.sign(d) * reach;
    }
    // no pull while the predicted dragon is still on its way (it is only late, by the input delay): pulling then made the
    // drawn one step back and forth. A stun or a large gap closes fast; a small one only once the authority has caught up
    // with where the player steers (it stands on the latest wanted spot), never mid-move
    // the authority merely trailing on the same path (between it and the goal, the network delay) is not a gap to close
    const err = x - shownX, trailing = (shownX - x) * (goal - x) > 0 && Math.abs(shownX - x) <= Math.abs(goal - x) + 0.5;
    if (stunned || (!trailing && Math.abs(err) > 120)) shownX += err * Math.min(1, frameDt * 12);
    else if (x === target && target === goal && Math.abs(shownX - target) < 1.5 * RULES.speed) shownX += err * Math.min(1, frameDt * 6);
    return shownX;
  }
  function drawIdle(now: number): void {
    for (let slot = 0; slot < RULES.formationCols * 2; slot++) drawEnemy(7, (1 + Math.floor(slot / 6)) * 100 + slot, 60 + (slot % 6) * 60, 160 + Math.floor(slot / 6) * 52, false, 0, now);
    drawGuard(W / 2, false, now);
    drawBricks(null);
  }
  function draw(now: number): void {
    const pw = Math.round(W * DPRc), ph = Math.round(H * DPRc);
    if (!wmCanvas || wmCanvas.width !== pw || wmCanvas.height !== ph) buildWatermark();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(wmCanvas as HTMLCanvasElement, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    if (shake > 0.3) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (mode === 'idle' || !local) drawIdle(now); else drawPlay(now);
  }

  /* --------------------------------- input --------------------------------- */
  // A move is sent at most once per 50 ms tick and only when the wanted spot changed: the platform takes one input per tick.
  const canPlay = (): boolean => mode === 'play' && local !== null && local.started && !local.gameOver && io.canInput();
  const toX = (e: PointerEvent): number => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(W, Math.round((e.clientX - r.left) / r.width * W))); };
  let pointerDown = false;
  canvas.addEventListener('pointerdown', (e) => {
    initAudio();
    if (!canPlay()) return;
    e.preventDefault(); pointerDown = true; desired = toX(e);
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  // The mouse steers to the exact pixel, also beyond the board's edges (the page's whole width counts, clamped), so the
  // cursor can never slip off it. It never steers while a key is held, and needs a real move (8 px) for a second after a
  // key was used: a hand resting on the mouse made the two fight over the dragon.
  let mouseAt = -1, keyAt = -1e9;
  addEventListener('pointermove', (e) => {
    if (!canPlay() || !(pointerDown || e.pointerType === 'mouse') || keys.left || keys.right) return;
    const x = toX(e);
    if (e.pointerType === 'mouse' && !pointerDown && performance.now() - keyAt < 1000 && Math.abs(x - mouseAt) < 8) return;
    mouseAt = x; kbX = null; desired = x;
  });
  canvas.addEventListener('pointerup', () => { pointerDown = false; });
  canvas.addEventListener('pointercancel', () => { pointerDown = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.tabIndex = 0;
  // ← → and A D work anywhere on the page during a run (no click on the board first), never while typing in a field
  const keyDir = (e: KeyboardEvent): 'left' | 'right' | null => (e.code === 'ArrowLeft' || e.code === 'KeyA' ? 'left' : e.code === 'ArrowRight' || e.code === 'KeyD' ? 'right' : null);
  const typing = (e: KeyboardEvent): boolean => {
    const el = e.target as HTMLElement | null;
    return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  };
  const stopKeys = (): void => {
    const held = keys.left || keys.right;
    keys.left = false; keys.right = false;
    if (held && shownX !== null) { kbX = shownX; desired = Math.round(shownX); }  // stop where it stands
  };
  // keys: a tap nudges the dragon by KEY_NUDGE px, a held key walks it at KEY_SPEED px/s (its own top speed, 800 px/s,
  // crossed the board in half a second); letting go stops it where it is drawn
  const KEY_NUDGE = 30, KEY_SPEED = 300, HOLD_DELAY = 150;                    // a tap = one nudge; walking starts after 150 ms held
  const heldSince = { left: 0, right: 0 };
  let kbX: number | null = null;
  const clampX = (x: number): number => Math.max(22, Math.min(W - 22, x));
  addEventListener('keydown', (e) => {
    const k = keyDir(e);
    if (!k || mode !== 'play' || typing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); initAudio(); keyAt = performance.now();
    if (!keys[k] && !e.repeat) { kbX = clampX((kbX ?? shownX ?? local?.play.x ?? W / 2) + (k === 'left' ? -KEY_NUDGE : KEY_NUDGE)); desired = Math.round(kbX); heldSince[k] = performance.now(); }
    keys[k] = true;
  });
  addEventListener('keyup', (e) => {
    const k = keyDir(e); if (!k || !keys[k]) return;
    e.preventDefault(); keys[k] = false; keyAt = performance.now();
  });
  addEventListener('blur', stopKeys);                                            // a key released in another window
  function pumpInput(now: number): void {
    if (!canPlay()) return;
    const dir = keys.left !== keys.right ? (keys.left ? 'left' : 'right') : null;
    if (dir && now - heldSince[dir] >= HOLD_DELAY && !(local && tickNow < local.play.stunUntil)) {   // a stunned dragon does not walk ahead in the head
      keyAt = now;
      kbX = clampX((kbX ?? shownX ?? local?.play.x ?? W / 2) + (keys.left ? -1 : 1) * KEY_SPEED * frameDt);
      desired = Math.round(kbX);
    }
    if (local && (desired === null || desired === lastSent) && now - lastSendAt > 5000) {   // a keep-alive: the run ends after 30 s with no input
      lastSendAt = now; io.sendInput({ action: 'move', x: local.play.target }); return;
    }
    if (desired === null || desired === lastSent || now - lastSendAt < TICK_MS) return;
    lastSent = desired; lastSendAt = now;
    io.sendInput({ action: 'move', x: desired });
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
  onArt(() => { dirty = true; });

  let liveSeen = wallIsLive(), lastFrame = performance.now(), idleStep = -1;
  function frame(t: number): void {
    requestAnimationFrame(frame);
    if (wallIsLive() !== liveSeen) { liveSeen = wallIsLive(); nameCache.clear(); wmCanvas = null; dirty = true; }   // the live names arrived
    const dt = Math.min(0.1, (t - lastFrame) / 1000); lastFrame = t; sndBudget = 8; frameDt = dt;
    for (const p of sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.life -= dt; }
    sparks = sparks.filter((p) => p.life > 0);
    if (shake > 0.2) shake *= Math.pow(0.01, dt); else shake = 0;
    if (nowT > 0) nowT -= dt;
    if (flashT > 0) flashT -= dt;
    if (lostT > 0) lostT = Math.max(0, lostT - dt / 1.2);
    canvas.style.cursor = mode === 'play' ? 'crosshair' : '';
    if (mode === 'play' && local) {
      pumpInput(t);
      const lp = local.play;
      if (local.started && !local.gameOver && lp.waveAt < 0 && lp.cleaners.length) {   // the rattle: every 900 ms in wave 1, 420 ms from wave 7
        if (t >= beatAt) { SND.rattle(); beatN++; beatAt = t + Math.max(420, 900 - 80 * (lp.wave - 1)); }
      }
      const secs = Math.ceil(ticksLeft(local, tickNow) * TICK_MS / 1000);       // the last ten seconds tick
      if (local.started && !local.gameOver && secs <= 10 && secs > 0 && secs !== secondSeen) { secondSeen = secs; SND.tick(secs <= 3); }
      tickNow = Math.max(local.tick, io.estimatedTick());
      if (tickNow > local.tick && !local.gameOver) {
        const before = engine.clone(local);
        engine.advanceInPlace(local, tickNow);
        prev = before; tickAt = t;
        follow(before, local);
        if (local.gameOver && !practice) hits.flush();
      }
      diveHum(local.gameOver ? [] : local.play.cleaners.filter((c) => c.mode === DIVING));
      draw(t);
    } else {
      if (diveVoices.size) diveHum([]);                                          // no whine outside a run
      if (mode === 'idle' && stepAt(t) !== idleStep && sheetOfWallet(io.playerAddress?.())) { idleStep = stepAt(t); dirty = true; }   // the sprite walks
      if (dirty || sparks.length || shake > 0) { draw(t); dirty = false; }
    }
  }
  requestAnimationFrame(frame);
  addEventListener('pagehide', () => { if (!practice) hits.flush(); diveHum([]); });
  // a hidden tab gets no frames: the whine of a dive would go on alone. Silence, and the sound waits for the tab's return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { diveHum([]); try { void AC?.suspend(); } catch { /* no audio */ } }
    else { try { void AC?.resume(); } catch { /* no audio */ } }
  });

  /* -------------------------------- Stage API ------------------------------- */
  return {
    setMessage(_text: string, extra?: { final?: number; view?: unknown; practice?: boolean; idle?: boolean }): void {
      dirty = true;
      if (extra?.idle) { mode = 'idle'; return; }
      if (extra && typeof extra.final === 'number') {
        practice = Boolean(extra.practice);
        if (!local && extra.view && typeof extra.view === 'object') local = engine.clone(extra.view as WwState);
        mode = 'end'; if (!practice) hits.flush();
      } else if (mode !== 'end') mode = 'idle';
    },
    hideRun(): void { if (mode === 'play') { mode = local && local.gameOver ? 'end' : 'idle'; dirty = true; } },
    showRun(view: WwState, info?: { practice?: boolean }): void {
      const nextPractice = Boolean(info?.practice);
      if (mode !== 'play' || nextPractice !== practice || (local && local.seed !== view.seed)) {
        resetRunMemory(view.seed); mode = 'play'; practice = nextPractice; base = null; local = null;
        // a run picked up mid-way (a reconnect, a reload): what it already shows is not played again, nor sent again to
        // the Survivor feed; a run just started still gets its first wave's sting
        const p = view.play;
        if (view.started && view.startTick !== null && view.tick - view.startTick > 10) {
          washedHigh = p.washed; clearedHigh = p.cleared; bricksShown = p.bricks; introSeen = p.wave; divesSeen = p.dives;
          fireSeen = p.fireAt; stunSeen = p.stunUntil; multSeen = streakMult(p.streak); namesSeen = bitCount(p.bricks);
        }
      }
      if (view !== base) {                                           // a new authoritative snapshot (or a new queued move)
        const shown = local;
        base = view; local = engine.clone(view); tickNow = Math.max(local.tick, io.estimatedTick());
        if (tickNow > local.tick && !local.gameOver) engine.advanceInPlace(local, tickNow);
        if (shown && local.tick > shown.tick) { prev = shown; tickAt = performance.now(); }
        follow(shown, local);
      }
    },
  };
}

/** An invader game's adapter: the shared rules and stage, its own words and art. */
export function invadersAdapter(o: InvadersOptions & { id: 'whitewash' | 'cc0-invaders'; heading: string; tagline: string; lede: string;
  howTo: readonly { title: string; text: string }[]; by?: { name: string; url: string } }): GameAdapter {
  return {
    id: o.id, title: o.title, heading: o.heading, tagline: o.tagline, lede: o.lede, howTo: o.howTo, ...(o.by ? { by: o.by } : {}),
    stateSchema: stateSchema as never,
    snapshotSchema: snapshotSchema as never,
    parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
    applyInput: (state: WwState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
    scoreOf: (state: WwState) => state.play.score,
    statusLine(state: WwState, tick: number): string {
      if (state.gameOver) return 'Waiting for the platform’s recorded result…';
      if (!state.started) return 'Starting your server-validated round…';
      let standing = 0; for (let b = 0; b < RULES.bricks; b++) if (state.play.bricks & (1 << b)) standing++;
      return `Wave ${state.play.wave} · ${standing}/${RULES.bricks} names standing · ${fmtClock(ticksLeft(state, tick))} left on the server clock`;
    },
    createStage: (host: HTMLElement, io: StageIO) => createStage(host, io, o),
    diagSummary: (state: WwState) => ({ tick: state.tick, started: state.started, gameOver: state.gameOver, wave: state.play.wave, cleaners: state.play.cleaners.length, bricks: state.play.bricks, score: state.play.score }),
    practice: {
      createRun: (seed: number) => engine.createRun(seed, scoringConfiguration(o.id)),
      advance: (state: WwState, tick: number) => engine.advance(state, tick),
    },
  };
}

/** The rules every invader game shows in its (i) panel, before its own "The art". */
export const INVADERS_RULES = [
  { title: 'Controls', text: 'Drag (or move the mouse) left and right anywhere on the board, or use ← → or A D: a tap is a small step, holding walks. The dragon sprays by itself.' },
  { title: 'Scoring', text: 'An invader in formation: 50. Caught mid-dive: 150. Every 8 downed without losing a name raises your multiplier (×2, ×3, up to ×4); losing a name resets it. A wave cleared pays 100 × names still standing × the wave number (up to ×5) and repaints one lost name.' },
  { title: 'Watch out', text: 'Divers drip whitewash: a drip on the dragon stuns it for almost 2 seconds. The name under attack pulses blue. Each wave is bigger and faster.' },
  { title: 'The end', text: 'The run ends when all eight names are whitewashed, after 3 minutes on the server clock, or if the page sends nothing for 30 seconds (an abandoned run; while you play, the page keeps it alive by itself). Your score is kept.' },
] as const;
export const AIPORIUM = { name: 'AIporium', url: 'https://x.com/AIporium_' };
