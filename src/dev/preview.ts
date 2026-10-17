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

const params = new URLSearchParams(location.search);
const game = params.get('game') === 'tap-the-name' ? 'tap-the-name' : 'unbreakable';
const seed = Number(params.get('seed') ?? 4242) >>> 0;
const lagMs = Number(params.get('lag') ?? 0);
const adapter = game === 'tap-the-name' ? tapAdapter : unbreakableAdapter;
const engine = (game === 'tap-the-name' ? createTap(ELIG) : createUb(ELIG)) as ReturnType<typeof createUb>;

const t0 = performance.now();
const tick = (): number => Math.floor((performance.now() - t0) / 50);
let state = engine.createRun(seed, scoringConfiguration(game));
let view = state as unknown;
let inputs = 0;
let done = false;
(window as unknown as { __preview: unknown }).__preview = { get state() { return state; }, get inputs() { return inputs; } };

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
