import { createEngine, stateSchema } from '../games/unbreakable/engine.js';
import { ELIG } from '../generated/wall.js';
import { makeVerifier } from './protocol.js';

const engine = createEngine(ELIG);
export default makeVerifier({
  stateSchema,
  createRun: engine.createRun, advance: engine.advance, applyInput: engine.applyInput,
  view: engine.view, isFinished: engine.isFinished, score: engine.score,
});
