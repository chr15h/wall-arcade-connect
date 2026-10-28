// SIGNAGE calibration: plays the BUILT verifier (the very module Studio runs) with three bots and reports how long runs
// last, what they score and the worst call. Usage: node --import tsx scripts/calibrate-signage.ts [runs]
//   idle    never puts up a sign (the floor: five walkers lost, the run is over in about 40 s)
//   corner  one sign under each newcomer towards its column, one "up" when it gets there (a careful beginner)
//   router  every tick, fixes the walker whose next step goes wrong first (a fast, protocol-legal bot: these rules
//           accept it, which is why the game is not called bot-proof)
import { build } from 'esbuild';
import { Coordinator, loadBuiltVerifier } from '../tests/helpers/coordinator.js';
import { BOTTOM, COLS, DX, DY, RULES, createEngine, type SgState, type Walker } from '../src/games/signage/engine.js';
import { scoringConfiguration } from '../src/shell/config.js';

const runs = Number(process.argv[2] ?? 10);
const bundle = await build({ entryPoints: ['src/verifiers/signage.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false });
const verifier = await loadBuiltVerifier((bundle.outputFiles[0] as { contents: Uint8Array }).contents);
const config = scoringConfiguration('signage');
const engine = createEngine();

/** The direction a walker should take from where it stands: along the row to its column, then up. */
const wanted = (w: Walker): number => (w.x === w.to ? 0 : (w.to > w.x ? 1 : 3));
/** The direction it will actually take on its next step. */
const heading = (S: SgState, w: Walker): number => { const s = engine.signAt(S.play, w.y * COLS + w.x); return s >= 0 ? s : w.dir; };

type Bot = (S: SgState) => Record<string, unknown> | null;
const bots: Record<string, Bot> = {
  idle: () => null,
  corner: (S) => {
    for (const w of S.play.walkers) {
      if (w.y === BOTTOM && w.x !== w.to && heading(S, w) !== wanted(w)) return { action: 'sign', x: w.x, y: w.y, dir: wanted(w) };
      if (w.x === w.to && heading(S, w) !== 0) return { action: 'sign', x: w.x, y: w.y, dir: 0 };
    }
    return null;
  },
  router: (S) => {
    let best: Walker | null = null;
    for (const w of S.play.walkers) {
      if (heading(S, w) === wanted(w)) continue;
      // a walker about to leave or with little patience comes first
      const leaving = w.y + (DY[heading(S, w)] as number) > BOTTOM || w.x + (DX[heading(S, w)] as number) < 0;
      if (!best || leaving || w.life < best.life) best = w;
    }
    return best ? { action: 'sign', x: best.x, y: best.y, dir: wanted(best) } : null;
  },
};

for (const [name, bot] of Object.entries(bots)) {
  const scores: number[] = [], seconds: number[] = [], delivered: number[] = [];
  let worst = 0;
  for (let i = 0; i < runs; i++) {
    const run = new Coordinator<SgState>(verifier, config, 1000 + i * 7919);
    await run.create(); await run.input({ action: 'start' });
    while (!run.state.gameOver) {
      const input = bot(run.state);
      if (input) await run.input(input); else await run.advanceTo(run.tick + 1);
    }
    scores.push(await run.score()); seconds.push(Math.round(((run.state.tick - (run.state.startTick ?? 0)) * 50) / 1000));
    delivered.push(run.state.play.delivered); worst = Math.max(worst, run.worstMs);
  }
  const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] as number;
  console.log(`${name.padEnd(7)} median score ${median(scores)} · delivered ${median(delivered)} · run ${median(seconds)} s (max ${Math.max(...seconds)} s of ${config.roundTicks / 20}) · best ${Math.max(...scores)} · worst call ${worst.toFixed(2)} ms · strikes ${RULES.strikes}`);
}
