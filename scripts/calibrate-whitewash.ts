// NFT INVADERS calibration: plays the BUILT verifier (the very module Studio runs) with three bots and reports how long
// runs last, what they score and the worst call. Usage: node --import tsx scripts/calibrate-whitewash.ts [runs]
//   idle     never moves (stands in the middle and sprays straight up)
//   sweeper  walks from edge to edge and back (a beginner)
//   hunter   every 3 ticks, goes under the lowest diver, else under the nearest cleaner, and steps aside from drips
//            (a fast, protocol-legal bot: these rules accept it, which is why the game is not called bot-proof)
import { build } from 'esbuild';
import { Coordinator, loadBuiltVerifier } from '../tests/helpers/coordinator.js';
import { DIVING, RULES, SHIP_Y, W, type WwState } from '../src/games/whitewash/engine.js';
import { scoringConfiguration } from '../src/shell/config.js';

const runs = Number(process.argv[2] ?? 10);
const bundle = await build({ entryPoints: ['src/verifiers/whitewash.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false });
const verifier = await loadBuiltVerifier((bundle.outputFiles[0] as { contents: Uint8Array }).contents);
const config = scoringConfiguration('whitewash');

type Bot = (S: WwState, tick: number) => number | null;
const bots: Record<string, Bot> = {
  idle: () => null,
  sweeper: (S, tick) => (Math.floor(tick / 40) % 2 ? 20 : W - 20) + (S.play.x < 0 ? 1 : 0),
  hunter: (S) => {
    const p = S.play;
    const danger = p.drips.find((d) => Math.abs(d[0] - p.x) < 30 && d[1] > SHIP_Y - 160 && d[1] < SHIP_Y);
    if (danger) return Math.max(0, Math.min(W, p.x + (danger[0] > p.x ? -60 : 60)));
    const divers = p.cleaners.filter((c) => c.mode === DIVING).sort((a, b) => b.y - a.y);
    const aim = divers[0] ?? [...p.cleaners].sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    return aim ? Math.max(0, Math.min(W, aim.x)) : null;
  },
};

const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;
for (const [name, bot] of Object.entries(bots)) {
  const scores: number[] = [], seconds: number[] = [], waves: number[] = [];
  let worst = 0;
  for (let i = 0; i < runs; i++) {
    const run = new Coordinator<WwState>(verifier, config, 2000 + i * 7919);
    await run.create(); await run.input({ action: 'start' });
    let last = -1;
    while (!run.state.gameOver) {
      const x = run.tick % 3 === 0 ? bot(run.state, run.tick) : null;
      if (x !== null && x !== last) { last = x; await run.input({ action: 'move', x }); } else await run.advanceTo(run.tick + 1);
    }
    scores.push(await run.score()); waves.push(run.state.play.cleared);
    seconds.push(Math.round(((run.state.tick - (run.state.startTick ?? 0)) * 50) / 1000)); worst = Math.max(worst, run.worstMs);
  }
  console.log(`${name.padEnd(8)} median score ${median(scores)} · waves downed ${median(waves)} · run ${median(seconds)} s (max ${Math.max(...seconds)} s of ${config.roundTicks / 20}) · best ${Math.max(...scores)} · worst call ${worst.toFixed(2)} ms · ${RULES.bricks} names`);
}
