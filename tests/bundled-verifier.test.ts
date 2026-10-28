import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { packageGame } from '../scripts/package-game.js';
import { scoringConfiguration, type Configuration } from '../src/shell/config.js';
import { createEngine as createUb, MIN_ANGLE, MAX_ANGLE, type UbState } from '../src/games/unbreakable/engine.js';
import { createEngine as createTap, MIN_REACTION_TICKS, type TapState, type TapQuestion } from '../src/games/tap-the-name/engine.js';
import { createEngine as createFullRow, PIECES, RULES as FR_RULES, fits, type FrState, type Piece } from '../src/games/full-row/engine.js';
import { createEngine as createSignage, BOTTOM as SG_BOTTOM, COLS as SG_COLS, RULES as SG_RULES, type SgState } from '../src/games/signage/engine.js';
import { createEngine as createWhitewash, DIVING as WW_DIVING, W as WW_W, type WwState } from '../src/games/whitewash/engine.js';
import { ELIG, TAP_POOL } from '../src/generated/wall.js';
import { mulberry32 } from '../src/common/det.js';
import { Coordinator, loadBuiltVerifier } from './helpers/coordinator.js';

const base = { groupId: '00000000-0000-4000-8000-000000000000', studioUrl: 'https://studio.superrare.com', apiUrl: 'https://api.superrare.com',
  connectUrl: 'https://connect.superrare.com', display: 'popup' } as const;
const CONFIGS: Record<'unbreakable' | 'tap-the-name' | 'full-row' | 'signage' | 'whitewash' | 'cc0-invaders', Configuration> = {
  unbreakable: { ...base, appId: 'c5285ae3-512e-464a-aceb-17571e1fe3e9', appOrigin: 'https://7x2phv5j.srstudio.dev', game: 'unbreakable' },
  'tap-the-name': { ...base, appId: '62a44855-272e-4b15-bc3b-f5fc803129ad', appOrigin: 'https://fgud7mby.srstudio.dev', game: 'tap-the-name' },
  'full-row': { ...base, appId: '5932be45-7ccb-483a-916d-0dcebff40ca2', appOrigin: 'https://yfq52eu3.srstudio.dev', game: 'full-row' },
  signage: { ...base, appId: '00000000-0000-4000-8000-00000000516a', appOrigin: 'https://signage-test.srstudio.dev', game: 'signage' },
  whitewash: { ...base, appId: '00000000-0000-4000-8000-0000000077a5', appOrigin: 'https://whitewash-test.srstudio.dev', game: 'whitewash' },
  'cc0-invaders': { ...base, appId: '00000000-0000-4000-8000-0000000cc0aa', appOrigin: 'https://cc0-invaders-test.srstudio.dev', game: 'cc0-invaders' },
};

async function built(game: keyof typeof CONFIGS) {
  const files = unzipSync(zipSync(await packageGame(CONFIGS[game])));       // build, archive, unpack: what Studio receives
  const verifier = await loadBuiltVerifier(files['server-verifier.js'] as Uint8Array);
  return { files, verifier, config: JSON.parse(strFromU8(files['scoring-config.json'] as Uint8Array)) as Record<string, unknown> };
}

for (const game of ['unbreakable', 'tap-the-name', 'full-row', 'signage', 'whitewash', 'cc0-invaders'] as const) {
  test(`${game}: the archive has Studio's required root layout and a matching scoring config`, async () => {
    const { files, config } = await built(game);
    for (const required of ['index.html', 'config.json', 'server-verifier.js', 'scoring-config.json']) assert.ok(files[required], `missing ${required}`);
    assert.ok(Object.keys(files).some((name) => /^assets\/app-[0-9a-f]{16}\.js$/.test(name)), 'content-hashed app bundle');
    assert.ok(Object.keys(files).some((name) => /^assets\/styles-[0-9a-f]{16}\.css$/.test(name)), 'content-hashed stylesheet');
    assert.deepEqual(config, scoringConfiguration(game));
    assert.ok((files['server-verifier.js'] as Uint8Array).byteLength < 256_000);
    const html = strFromU8(files['index.html'] as Uint8Array);
    assert.ok(html.includes(`content="${CONFIGS[game].appId}"`) && html.includes(`href="${CONFIGS[game].appOrigin}/"`));
    assert.ok(!/arcade\.js|otw-arcade\.netlify\.app\/arcade/.test(html), 'the old arcade module is not loaded any more');
    const publicConfig = strFromU8(files['config.json'] as Uint8Array);
    assert.ok(!/secret|token|private|treasury|0x[0-9a-fA-F]{40}/i.test(publicConfig), 'no secret or address in the public config');
  });

  test(`${game}: the BUILT verifier answers the platform's conformance probe and rejects everything else`, async () => {
    const { verifier, config } = await built(game);
    const probe = new Coordinator(verifier, config, 0);
    const state = await probe.create() as { rules: { game: string } };
    assert.equal(state.rules.game, game);
    assert.equal(await probe.score(), 0); assert.equal(await probe.isFinished(), false);
    assert.deepEqual(await probe.view(), state);
    const post = (payload: unknown, path = '/v1', method = 'POST') => verifier.fetch(new Request(`https://verifier.invalid${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(payload) : undefined }));
    assert.equal((await post({ version: '1', op: 'createRun', seed: 1, config })).status, 400, 'version must be the number 1');
    assert.equal((await post({ version: 1, op: 'submitScore', score: 999999 })).status, 400, 'no way to submit a score');
    assert.equal((await post({ version: 1, op: 'score', state: { ...state, bogus: 9 } })).status, 400, 'a state with unknown fields is refused');
    assert.equal((await post({ version: 1, op: 'score', state: { tick: -1 } })).status, 400, 'a malformed state is refused');
    assert.equal((await post({ version: 1, op: 'createRun', seed: -1, config })).status, 400);
    assert.equal((await post({ version: 1, op: 'createRun', seed: 1, config: { ...config, game: 'target-rush' } })).status, 400);
    assert.equal((await post({}, '/v1', 'GET')).status, 404); assert.equal((await post({}, '/other')).status, 404);
    assert.equal((await post({ version: 1, op: 'advance', state, serverTick: 3, extra: true })).status, 400, 'strict envelope');
  });
}

test('unbreakable: a full 3-minute run through the BUILT verifier equals the engine, stays small and fast', async () => {
  const { verifier, config } = await built('unbreakable');
  const engine = createUb(ELIG);
  const run = new Coordinator<UbState>(verifier, config, 123456);
  let local = engine.createRun(123456, config);
  await run.create();
  const rnd = mulberry32(7);
  const send = async (input: unknown): Promise<void> => { await run.input(input); local = engine.applyInput(local, input, run.tick); };
  await send({ action: 'start' });
  let shots = 0;
  while (!run.state.gameOver && run.tick < 4000) {
    if (run.state.sim.phase === 0) { await send({ action: 'fire', angle: Math.round(MIN_ANGLE + rnd() * (MAX_ANGLE - MIN_ANGLE)) }); shots++; }
    await run.advanceTo(run.tick + 1); local = engine.advance(local, run.tick);
  }
  assert.equal(run.state.gameOver, true);
  assert.deepEqual(run.state, local, 'bundled verifier state equals the engine run in-process');
  assert.equal(await run.isFinished(), true);
  assert.equal(await run.score(), run.state.sim.score);
  assert.ok(run.state.tick <= 3600 + 1, 'ended by the 3-minute round limit or by the end line');
  console.log(`  unbreakable built verifier: ${run.calls} calls, ${shots} shots, score ${await run.score()}, largest state ${run.largestState} B, worst call ${run.worstMs.toFixed(2)} ms`);
  assert.ok(run.largestState < 64 * 1024); assert.ok(run.worstMs < 10, `worst call ${run.worstMs} ms`);
});

test('tap-the-name: a full run through the BUILT verifier, with a wrong answer and with a horizon end', async () => {
  const { verifier, config } = await built('tap-the-name');
  const engine = createTap(TAP_POOL);
  async function play(seed: number, mistakeAt: number | null): Promise<{ run: Coordinator<TapState>; local: TapState }> {
    const run = new Coordinator<TapState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    const send = async (input: unknown, at?: number): Promise<void> => { await run.input(input, at); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' });
    let answered = 0;
    while (!run.state.gameOver && run.tick < 3000) {
      const q = run.state.question as TapQuestion | null;
      if (q) {
        const wrong = mistakeAt !== null && answered === mistakeAt ? q.options.find((p) => p !== q.target) as number : q.target;
        await send({ action: 'choose', questionId: q.id, pos: wrong }, Math.max(run.tick + 1, q.startTick + MIN_REACTION_TICKS)); answered++;
      } else { await run.advanceTo(run.state.nextRoundAt as number); local = engine.advance(local, run.tick); }
    }
    return { run, local };
  }
  const mistaken = await play(31, 4);
  assert.equal(mistaken.run.state.gameOver, true); assert.equal(mistaken.run.state.last, 'wrong'); assert.equal(await mistaken.run.score(), 4);
  assert.deepEqual(mistaken.run.state, mistaken.local);
  const perfect = await play(32, null);
  assert.equal(perfect.run.state.last, 'horizon'); assert.deepEqual(perfect.run.state, perfect.local);
  assert.ok(await perfect.run.score() > 20, 'a protocol-legal bot is accepted by these rules (documented limitation)');
  console.log(`  tap-the-name built verifier: bot score ${await perfect.run.score()}, worst call ${perfect.run.worstMs.toFixed(2)} ms, state ${perfect.run.largestState} B`);
});

test('full-row: whole runs through the BUILT verifier equal the engine (replay), end on "nothing fits", stay small and fast', async () => {
  const { verifier, config } = await built('full-row');
  const engine = createFullRow();
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<FrState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown): Promise<void> => { await run.input(input); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' });
    const rnd = mulberry32(seed ^ 0x77);
    while (!run.state.gameOver && run.tick < 7000) {
      if (run.state.play.stuckTick !== null) { await run.advanceTo(run.tick + 4); local = engine.advance(local, run.tick); continue; }
      const moves: { slot: number; x: number; y: number }[] = [];
      run.state.play.hand.forEach((id, slot) => {
        if (id < 0) return;
        const piece = PIECES[id] as Piece;
        for (let y = 0; y + piece.h <= 8; y++) for (let x = 0; x + piece.w <= 8; x++) if (fits(run.state.play.rows, piece, x, y)) moves.push({ slot, x, y });
      });
      await send({ action: 'place', ...moves[Math.floor(rnd() * moves.length)] });
      await run.advanceTo(run.tick + 2); local = engine.advance(local, run.tick);
    }
    assert.equal(run.state.gameOver, true); assert.notEqual(run.state.play.stuckTick, null, 'ended because nothing fit');
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine run in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    // replay: the same seed and the same inputs (at the same ticks) on a fresh coordinator give the same state and score
    const again = new Coordinator<FrState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state); assert.equal(await again.score(), await run.score());
    console.log(`  full-row built verifier (seed ${seed}): ${run.calls} calls, ${run.state.play.placed} placements, score ${await run.score()}, largest state ${run.largestState} B, worst call ${run.worstMs.toFixed(2)} ms`);
    assert.ok(run.largestState < 1024); assert.ok(run.worstMs < 10, `worst call ${run.worstMs} ms`);
  }
});

test('full-row: the BUILT verifier keeps the combo rule (×(1 + 0.5 × combo), capped at 10) and has no schema library inside', async () => {
  const { files, verifier, config } = await built('full-row');
  assert.ok(!/zod|ZodError|\$ZodType/.test(new TextDecoder().decode(files['server-verifier.js'] as Uint8Array)), 'zod-free verifier');
  assert.equal(FR_RULES.comboCap, 10);
  const run = new Coordinator<FrState>(verifier, config, 5);
  await run.create(); await run.input({ action: 'start' });
  const dot = PIECES.findIndex((piece) => piece.key === '1');
  const almost = 0b0111_1111;
  // a coordinator-held state at the cap: the next clear pays 80 × 6 and the combo stays at 10
  run.state = { ...run.state, play: { ...run.state.play, rows: [almost, almost, 0, 0, 0, 0, 1, 0], hand: [dot, dot, dot], combo: 9 } };
  await run.input({ action: 'place', slot: 0, x: 7, y: 0 });
  assert.equal(run.state.play.combo, 10); assert.equal(run.state.play.score, 1 + 80 * (1 + 0.5 * 9));
  await run.input({ action: 'place', slot: 1, x: 7, y: 1 });
  assert.equal(run.state.play.combo, 10, 'capped'); assert.equal(run.state.play.score, 1 + 80 * 5.5 + 1 + 80 * 6);
  await run.input({ action: 'place', slot: 2, x: 0, y: 3 });
  assert.equal(run.state.play.combo, 0, 'a placement that clears nothing resets it');
});

test('signage: whole runs through the BUILT verifier equal the engine (replay), forged inputs change nothing, small and fast', async () => {
  const { files, verifier, config } = await built('signage');
  assert.ok(!/zod|ZodError|\$ZodType/.test(new TextDecoder().decode(files['server-verifier.js'] as Uint8Array)), 'zod-free verifier');
  const engine = createSignage();
  const forged = [{ action: 'sign', x: 0, y: 0, dir: 0 }, { action: 'score', value: 1e6 }, { action: 'deliver', id: 0 }, { action: 'sign', x: 1, y: 2, dir: 0, life: 40 }];
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<SgState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    run.worstMs = 0;                                                  // the harness's own cold start (Request, JSON) is not the verifier's
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown): Promise<void> => { await run.input(input); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' });
    const rnd = mulberry32(seed ^ 0x99);
    while (!run.state.gameOver && run.tick < 6000) {
      const play = run.state.play;
      // a newcomer: send it along the bottom row towards its column; on its column: turn it up
      const w = play.walkers.find((v) => v.y === SG_BOTTOM && v.x !== v.to && engine.signAt(play, v.y * SG_COLS + v.x) < 0);
      const v = play.walkers.find((x) => x.x === x.to && x.dir !== 0 && engine.signAt(play, x.y * SG_COLS + x.x) !== 0);
      if (v && rnd() < 0.9) await send({ action: 'sign', x: v.x, y: v.y, dir: 0 });
      else if (w && rnd() < 0.8) await send({ action: 'sign', x: w.x, y: w.y, dir: w.to > w.x ? 1 : 3 });
      else if (rnd() < 0.05) {
        const before = run.state.play;
        await send(forged[Math.floor(rnd() * forged.length)]);
        assert.deepEqual(run.state.play.signs, before.signs, 'a forged input puts up no sign');
      } else { await run.advanceTo(run.tick + 2); local = engine.advance(local, run.tick); }
    }
    assert.equal(run.state.gameOver, true);
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine run in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    // replay: the same seed and the same inputs (at the same ticks) on a fresh coordinator give the same state and score
    const again = new Coordinator<SgState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state); assert.equal(await again.score(), await run.score());
    console.log(`  signage built verifier (seed ${seed}): ${run.calls} calls, ${run.state.play.delivered} delivered, ${run.state.play.missed}/${SG_RULES.strikes} lost, score ${await run.score()}, largest state ${run.largestState} B, worst call ${run.worstMs.toFixed(2)} ms`);
    // wall time under a busy test runner includes GC pauses and other processes: a loose guard here, the CPU budget below
    assert.ok(run.largestState < 8192); assert.ok(run.worstMs < 50, `worst call ${run.worstMs} ms`);
  }
  // the heaviest call there is, one that jumps the whole round (a coordinator catching up), stays under the 10 ms CPU
  // budget: best of three, so a GC pause is not counted as the verifier's CPU
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const jump = new Coordinator<SgState>(verifier, config, 5);
    await jump.create(); await jump.input({ action: 'start' });
    const t0 = process.hrtime.bigint();
    await jump.advanceTo((config as { maxTicks: number }).maxTicks);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(jump.state.gameOver, true);
  }
  assert.ok(best < 10, `whole-round call ${best} ms`);
});

test('whitewash: an abandoned run (one move, then nothing) ends on the idle limit, in one cheap call', async () => {
  const { verifier, config } = await built('whitewash');
  let best = Infinity, end = 0;
  for (let k = 0; k < 3; k++) {
    const run = new Coordinator<WwState>(verifier, config, 307);
    await run.create(); await run.input({ action: 'start' }, 0); await run.input({ action: 'move', x: 189 }, 2);
    const t0 = process.hrtime.bigint();
    await run.advanceTo((config as { maxTicks: number }).maxTicks);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); end = run.state.tick;
    assert.equal(run.state.gameOver, true);
  }
  assert.ok(end <= 2 + 600, `ended at tick ${end}`);
  assert.ok(best < 10, `the longest call ${best} ms`);
});

test('whitewash: whole runs through the BUILT verifier equal the engine (replay), forged inputs change nothing, small and fast', async () => {
  const { files, verifier, config } = await built('whitewash');
  assert.ok(!/zod|ZodError|\$ZodType/.test(new TextDecoder().decode(files['server-verifier.js'] as Uint8Array)), 'zod-free verifier');
  const engine = createWhitewash();
  const forged = [{ action: 'move', x: -5 }, { action: 'score', value: 1e6 }, { action: 'fire' }, { action: 'move', x: 10, y: 2 }, { action: 'move', x: 99.5 }];
  for (const seed of [123456, 0, 0xfeedface]) {
    const run = new Coordinator<WwState>(verifier, config, seed);
    let local = engine.createRun(seed, config);
    await run.create();
    run.worstMs = 0;                                                  // the harness's own cold start (Request, JSON) is not the verifier's
    const sent: { input: unknown; tick: number }[] = [];
    const send = async (input: unknown): Promise<void> => { await run.input(input); sent.push({ input, tick: run.tick }); local = engine.applyInput(local, input, run.tick); };
    await send({ action: 'start' });
    const rnd = mulberry32(seed ^ 0x99);
    while (!run.state.gameOver) {
      const p = run.state.play, diver = p.cleaners.filter((c) => c.mode === WW_DIVING).sort((a, b) => b.y - a.y)[0];
      if (diver && diver.x !== p.target && rnd() < 0.5) await send({ action: 'move', x: Math.max(0, Math.min(WW_W, diver.x)) });
      else if (rnd() < 0.03) {
        const before = run.state.play.target;
        await send(forged[Math.floor(rnd() * forged.length)]);
        assert.equal(run.state.play.target, before, 'a forged input moves nothing');
      } else { await run.advanceTo(run.tick + 2); local = engine.advance(local, run.tick); }
    }
    assert.deepEqual(run.state, local, 'bundled verifier state equals the engine run in-process');
    assert.equal(await run.isFinished(), true); assert.equal(await run.score(), run.state.play.score);
    // replay: the same seed and the same inputs (at the same ticks) on a fresh coordinator give the same state and score
    const again = new Coordinator<WwState>(verifier, config, seed);
    await again.create();
    for (const { input, tick } of sent) await again.input(input, tick);
    await again.advanceTo(run.tick);
    assert.deepEqual(again.state, run.state); assert.equal(await again.score(), await run.score());
    console.log(`  whitewash built verifier (seed ${seed}): ${run.calls} calls, wave ${run.state.play.wave}, ${run.state.play.downed} downed, score ${await run.score()}, largest state ${run.largestState} B, worst call ${run.worstMs.toFixed(2)} ms`);
    // wall time under a busy test runner includes GC pauses and other processes: a loose guard here, the CPU budget below
    assert.ok(run.largestState < 8192); assert.ok(run.worstMs < 50, `worst call ${run.worstMs} ms`);
  }
  // the heaviest call there is, one that jumps the whole round (a coordinator catching up), stays under the 10 ms CPU
  // budget: best of three, so a GC pause is not counted as the verifier's CPU
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const jump = new Coordinator<WwState>(verifier, config, 5);
    await jump.create(); await jump.input({ action: 'start' });
    const t0 = process.hrtime.bigint();
    await jump.advanceTo((config as { maxTicks: number }).maxTicks);
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(jump.state.gameOver, true);
  }
  assert.ok(best < 10, `whole-round call ${best} ms`);
});
