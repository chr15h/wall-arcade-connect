// FULL ROW calibration: two bots play through the BUILT verifier module (the archive's server-verifier.js), 200 runs
// each, and report the median length (placements) and score. Usage: node --import tsx scripts/calibrate-full-row.ts [runs]
//   random: a valid placement chosen at random
//   greedy: the placement that clears the most lines; otherwise the one that keeps the most room (mobility: how many
//           (piece, position) fits the grid still offers)
import { build } from 'esbuild';
import { mulberry32 } from '../src/common/det.js';
import { scoringConfiguration } from '../src/shell/config.js';
import { PIECES, N, evaluatePlacement, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';
import { Coordinator, loadBuiltVerifier } from '../tests/helpers/coordinator.js';

const runs = Number(process.argv[2] ?? 200);
const bundle = await build({ entryPoints: ['src/verifiers/full-row.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false });
const verifier = await loadBuiltVerifier((bundle.outputFiles[0] as { contents: Uint8Array }).contents);
const config = scoringConfiguration('full-row');

type Move = { slot: number; x: number; y: number };
function legalMoves(state: FrState): Move[] {
  const out: Move[] = [];
  state.play.hand.forEach((id, slot) => {
    if (id < 0) return;
    const piece = PIECES[id] as Piece;
    for (let y = 0; y + piece.h <= N; y++) for (let x = 0; x + piece.w <= N; x++) if (fits(state.play.rows, piece, x, y)) out.push({ slot, x, y });
  });
  return out;
}
function mobility(rows: readonly number[]): number {
  let n = 0;
  for (const piece of PIECES) for (let y = 0; y + piece.h <= N; y++) for (let x = 0; x + piece.w <= N; x++) if (fits(rows, piece, x, y)) n++;
  return n;
}
const bots: Record<string, (state: FrState, rnd: () => number) => Move> = {
  random: (state, rnd) => { const moves = legalMoves(state); return moves[Math.floor(rnd() * moves.length)] as Move; },
  greedy: (state) => {
    let best: Move | null = null, bestKey = -Infinity;
    for (const move of legalMoves(state)) {
      const piece = PIECES[state.play.hand[move.slot] as number] as Piece;
      const r = evaluatePlacement(state.play.rows, state.play.combo, piece, move.x, move.y);
      const key = r.lines * 1_000_000 + mobility(r.rows);
      if (key > bestKey) { bestKey = key; best = move; }
    }
    return best as Move;
  },
};

const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] as number : ((s[m - 1] as number) + (s[m] as number)) / 2; };
const pct = (values: number[], p: number): number => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number; };

for (const [name, bot] of Object.entries(bots)) {
  const moves: number[] = [], scores: number[] = [], over3000: number[] = [];
  let worstMs = 0, largest = 0, capped = 0;
  for (let i = 0; i < runs; i++) {
    const seed = (0x9e3779b9 * (i + 1)) >>> 0;
    const run = new Coordinator<FrState>(verifier, config, seed);
    await run.create();
    await run.input({ action: 'start' });
    const rnd = mulberry32(seed ^ 0xb07);
    while (!run.state.gameOver) {
      if (run.state.play.stuckTick !== null) { await run.advanceTo(run.tick + 20); continue; }
      await run.input({ action: 'place', ...bot(run.state, rnd) });       // one placement per server tick: far faster than a person (no time pressure exists)
    }
    if (run.state.play.stuckTick === null) capped++;
    moves.push(run.state.play.placed); scores.push(await run.score());
    if (run.state.play.score >= 3000) over3000.push(run.state.play.score);
    worstMs = Math.max(worstMs, run.worstMs); largest = Math.max(largest, run.largestState);
  }
  console.log(`${name.padEnd(6)} ${runs} runs · placements median ${median(moves)} (p10 ${pct(moves, 0.1)}, p90 ${pct(moves, 0.9)}, max ${Math.max(...moves)})`
    + ` · score median ${median(scores)} (p10 ${pct(scores, 0.1)}, p90 ${pct(scores, 0.9)}, max ${Math.max(...scores)})`
    + ` · ≥3000: ${over3000.length}/${runs} · cut by the cap: ${capped} · worst call ${worstMs.toFixed(2)} ms · largest state ${largest} B`);
}
