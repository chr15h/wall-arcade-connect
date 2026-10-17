// The Worker request/response adapter of a Studio verifier module (protocol version 1), shared by every game.
// Adapted from studio-games-example/src/server-verifier.ts (MIT, Copyright 2026 SuperRare): the six supported
// operations, strict request envelopes, HTTP 400 for malformed requests, 404 for anything but POST /v1.
import * as z from 'zod/mini';

export interface VerifierEngine<State> {
  stateSchema: z.ZodMiniType<State>;
  createRun(seed: unknown, config: unknown): State;
  advance(state: State, serverTick: number): State;
  applyInput(state: State, input: unknown, serverTick: number): State;
  view(state: State): unknown;
  isFinished(state: State): boolean;
  score(state: State): number;
}

export function makeVerifier<State>(engine: VerifierEngine<State>): { fetch(request: Request): Promise<Response> } {
  const serverTick = z.int().check(z.gte(0));
  const requestSchema = z.discriminatedUnion('op', [
    z.strictObject({ version: z.literal(1), op: z.literal('createRun'), seed: z.unknown(), config: z.unknown() }),
    z.strictObject({ version: z.literal(1), op: z.literal('advance'), state: engine.stateSchema, serverTick }),
    z.strictObject({ version: z.literal(1), op: z.literal('applyInput'), state: engine.stateSchema, input: z.unknown(), serverTick }),
    z.strictObject({ version: z.literal(1), op: z.literal('view'), state: engine.stateSchema }),
    z.strictObject({ version: z.literal(1), op: z.literal('isFinished'), state: engine.stateSchema }),
    z.strictObject({ version: z.literal(1), op: z.literal('score'), state: engine.stateSchema }),
  ]);

  async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1') return new Response('Not found', { status: 404 });
    try {
      const payload = requestSchema.parse(await request.json() as unknown);
      let result: unknown;
      switch (payload.op) {
        case 'createRun': result = engine.createRun(payload.seed, payload.config); break;
        case 'advance': result = engine.advance(payload.state as State, payload.serverTick); break;
        case 'applyInput': result = engine.applyInput(payload.state as State, payload.input, payload.serverTick); break;
        case 'view': result = engine.view(payload.state as State); break;
        case 'isFinished': result = engine.isFinished(payload.state as State); break;
        case 'score': result = engine.score(payload.state as State); break;
      }
      return Response.json({ version: 1, result });
    } catch (error: unknown) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid verifier request' }, { status: 400 });
    }
  }
  return { fetch: handle };
}
