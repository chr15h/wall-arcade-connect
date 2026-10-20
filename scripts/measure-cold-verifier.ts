// Cold-start cost of a game's BUILT verifier, as Studio would meet it in a fresh isolate: each sample is a new Node
// process that loads server-verifier.js from the archive, then times the first call of every operation the coordinator
// makes (wall time and CPU time). Usage: node --import tsx scripts/measure-cold-verifier.ts <game.zip> [samples]
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

const [zipPath, samplesArg] = process.argv.slice(2);
if (!zipPath) throw new Error('Usage: measure-cold-verifier.ts <game.zip> [samples]');
const files = unzipSync(new Uint8Array(await readFile(zipPath)));
const source = new TextDecoder().decode(files['server-verifier.js'] as Uint8Array);
const config = JSON.parse(new TextDecoder().decode(files['scoring-config.json'] as Uint8Array)) as unknown;
const samples = Number(samplesArg ?? 25);

// The child: plain ESM, no tsx, nothing warmed up before the verifier module.
// Node loads Request/Response/JSON helpers (undici) lazily on first use; a Worker isolate has them natively. They are
// exercised once on a dummy request first, so the timings below are the verifier's own cold cost.
const child = `
{ const warm = new Request('https://warm.invalid/v1', { method: 'POST', body: '{"a":1}' }); await warm.json(); await Response.json({ a: 1 }).json(); }
const src = ${JSON.stringify(source)};
const config = ${JSON.stringify(config)};
const ms = (a) => Number(process.hrtime.bigint() - a) / 1e6;
const cpu = (a) => { const d = process.cpuUsage(a); return (d.user + d.system) / 1000; };
let t = process.hrtime.bigint(), c = process.cpuUsage();
const verifier = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;
const out = { load: [ms(t), cpu(c)] };
async function call(name, body) {
  t = process.hrtime.bigint(); c = process.cpuUsage();
  const response = await verifier.fetch(new Request('https://verifier.invalid/v1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, ...body }) }));
  const json = await response.json();
  out[name] = [ms(t), cpu(c)];
  if (response.status !== 200) throw new Error(name + ' ' + JSON.stringify(json));
  return json.result;
}
let state = await call('createRun', { op: 'createRun', seed: 123456, config });
state = await call('start', { op: 'applyInput', state, input: { action: 'start' }, serverTick: 1 });
const id = state.play.hand[0];
state = await call('place', { op: 'applyInput', state, input: { action: 'place', slot: 0, x: 0, y: 0 }, serverTick: 2 });
state = await call('advance', { op: 'advance', state, serverTick: 3 });
await call('view', { op: 'view', state });
await call('isFinished', { op: 'isFinished', state });
await call('score', { op: 'score', state });
state = await call('place2', { op: 'applyInput', state, input: { action: 'place', slot: 1, x: 3, y: 4 }, serverTick: 4 });
process.stdout.write(JSON.stringify(out));
`;
const runs: Record<string, [number, number]>[] = [];
for (let i = 0; i < samples; i++) runs.push(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' })));
const keys = Object.keys(runs[0] as object);
const stat = (values: number[]): string => { const s = [...values].sort((a, b) => a - b); return `median ${(s[s.length >> 1] as number).toFixed(2)} · max ${(s[s.length - 1] as number).toFixed(2)}`; };
console.log(`${zipPath} · verifier ${source.length} B · ${samples} fresh processes (ms; wall / CPU)`);
for (const key of keys) {
  console.log(`  ${key.padEnd(10)} wall ${stat(runs.map((r) => (r[key] as [number, number])[0]))}   cpu ${stat(runs.map((r) => (r[key] as [number, number])[1]))}`);
}
const first = runs.map((r) => Math.max(...keys.filter((k) => k !== 'load').map((k) => (r[k] as [number, number])[0])));
console.log(`  worst single call per process: ${stat(first)}`);
