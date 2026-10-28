// SIGNAGE's verifier: the rules (core.ts) behind the protocol envelope, without a schema library, so a cold isolate
// starts fast (scripts/measure-cold-verifier.ts).
import { checkState, createEngine } from '../games/signage/core.js';
import { makePlainVerifier } from './protocol-plain.js';

const engine = createEngine();
export default makePlainVerifier({
  checkState,
  createRun: engine.createRun, advance: engine.advance, applyInput: engine.applyInput,
  view: engine.view, isFinished: engine.isFinished, score: engine.score,
});
