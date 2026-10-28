// DEV ONLY (never packaged): runs a game stage against an in-browser stand-in for the coordinator, so the canvas and
// the controls can be looked at and played without a paid run. The stage code under test is the shipped code.
import { ELIG } from '../generated/wall.js';
import { scoringConfiguration } from '../shell/config.js';
import { refreshWall } from '../shell/wall-data.js';
import type { Stage, StageIO } from '../shell/adapter.js';
import { unbreakableAdapter } from '../games/unbreakable/client.js';
import { tapAdapter } from '../games/tap-the-name/client.js';
import { createEngine as createUb } from '../games/unbreakable/engine.js';
import { createEngine as createTap } from '../games/tap-the-name/engine.js';
import { fullRowAdapter } from '../games/full-row/client.js';
import { createEngine as createFullRow } from '../games/full-row/engine.js';
import { signageAdapter } from '../games/signage/client.js';
import { createEngine as createSignage } from '../games/signage/engine.js';
import { whitewashAdapter } from '../games/whitewash/nft-invaders.js';
import { createEngine as createWhitewash } from '../games/whitewash/engine.js';
import { cc0InvadersAdapter } from '../games/whitewash/cc0-invaders.js';

const params = new URLSearchParams(location.search);
const game = (['tap-the-name', 'full-row', 'signage', 'whitewash', 'cc0-invaders'] as const).find((id) => id === params.get('game')) ?? 'unbreakable';
const seed = Number(params.get('seed') ?? 4242) >>> 0;
const lagMs = Number(params.get('lag') ?? 0);
const adapter = game === 'tap-the-name' ? tapAdapter : game === 'full-row' ? fullRowAdapter : game === 'signage' ? signageAdapter : game === 'whitewash' ? whitewashAdapter : game === 'cc0-invaders' ? cc0InvadersAdapter : unbreakableAdapter;
const engine = (game === 'tap-the-name' ? createTap(ELIG) : game === 'full-row' ? createFullRow() : game === 'signage' ? createSignage() : game === 'whitewash' || game === 'cc0-invaders' ? createWhitewash() : createUb(ELIG)) as unknown as ReturnType<typeof createUb>;

const t0 = performance.now();
const tick = (): number => Math.floor((performance.now() - t0) / 50);
let state = engine.createRun(seed, scoringConfiguration(game));
let view = state as unknown;
let inputs = 0;
let done = false;
// read by the teaser's capture (scripts/teaser-capture.ts), which also sends planned inputs through `send`
(window as unknown as { __preview: unknown }).__preview = { get state() { return state; }, get inputs() { return inputs; }, send: (input: unknown) => io.sendInput(input as never) };

const host = document.getElementById('arena') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const io: StageIO = {
  sendInput(input) {
    inputs++;
    const apply = (): void => { state = engine.applyInput(state, input, Math.max(state.tick, tick())); view = state; };
    if (lagMs > 0) setTimeout(apply, lagMs); else apply();
  },
  canInput: () => !done && !(state as { gameOver: boolean }).gameOver,
  estimatedTick: () => Math.max(0, tick() - Math.round(lagMs / 50)),
  pendingCount: () => 0,
};
const stage: Stage = adapter.createStage(host, io);
void refreshWall();
io.sendInput({ action: 'start' });
setInterval(() => {
  state = engine.advance(state, Math.max(state.tick, tick())); view = state;       // a snapshot: a new object every tick, like the socket
  if ((state as { gameOver: boolean }).gameOver && !done) {
    done = true; const score = adapter.scoreOf(state);
    stage.setMessage(`Server-verified score: ${score}. Round complete.`, { final: score, view: state });
    status.textContent = `done · score ${score}`;
  }
}, 50);
setInterval(() => {
  if (done) return;
  stage.showRun(view, { tick: io.estimatedTick(), pending: 0, serverTick: state.tick });
  status.textContent = adapter.statusLine(view, io.estimatedTick());
}, 25);
