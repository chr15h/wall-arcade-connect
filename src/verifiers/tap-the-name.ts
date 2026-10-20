import { createEngine, stateSchema } from '../games/tap-the-name/engine.js';
import { TAP_POOL } from '../generated/wall.js';
import { makeVerifier } from './protocol.js';

const engine = createEngine(TAP_POOL);
export default makeVerifier({
  stateSchema,
  createRun: engine.createRun, advance: engine.advance, applyInput: engine.applyInput,
  view: engine.view, isFinished: engine.isFinished, score: engine.score,
});
