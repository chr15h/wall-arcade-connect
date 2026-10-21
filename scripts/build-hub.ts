// Builds the hub archive: index.html (the player page: today's game, the games, how it works, the wall), builders.html
// (artists: make a game on the wall) and shots/<id>.jpg. A plain static app: no Connect, no verifier, no config.
// - the games come from hub/games.json, inlined into the player page;
// - their screenshots are taken again at every build (scripts/capture-shots.ts: the game in the middle of a run, portrait,
//   1080 px high) into hub/shots/, so a game added to games.json always has one; --no-shots reuses hub/shots as it is;
// - both pages' wall grid is embedded as a snapshot of the public /positions data;
// - the builders page gets the Connect Kit (docs/CONNECT-KIT.md) behind its COPY THE KIT buttons, after the repo's link.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync, strToU8 } from 'fflate';
import { captureShots, type HubGame } from './capture-shots.js';

type Item = { position: number; tier: string; minted: boolean; name?: string };
const { values } = parseArgs({ args: process.argv.slice(2)[0] === '--' ? process.argv.slice(3) : process.argv.slice(2),
  options: { output: { type: 'string' }, force: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false }, 'no-shots': { type: 'boolean', default: false } }, strict: true });
if (!values.output) throw new Error('Usage: npm run build:hub -- --output <hub.zip> [--force] [--offline] [--no-shots]');

const html = await readFile(new URL('../hub/src.html', import.meta.url), 'utf8');
const buildersSource = await readFile(new URL('../hub/builders.html', import.meta.url), 'utf8');
const kitDoc = await readFile(new URL('../docs/CONNECT-KIT.md', import.meta.url), 'utf8');
const kitBlock = /```text\n([\s\S]*?)\n```/.exec(kitDoc);
if (!kitBlock) throw new Error('docs/CONNECT-KIT.md must hold the kit in a ```text block');
const REPO = 'https://github.com/hs7j4yk4sz-boop/wall-arcade-connect';
const kitText = `${REPO}\n\n${kitBlock[1]}\n`;
if (!buildersSource.includes("/*KIT*/''")) throw new Error("hub/builders.html must hold the /*KIT*/'' placeholder");
// JSON is a JavaScript string literal; </ is escaped so the kit can never close the <script>
const games = JSON.parse(await readFile(new URL('../hub/games.json', import.meta.url), 'utf8')) as HubGame[];
if (!games.length || new Set(games.map((g) => g.id)).size !== games.length || games.some((g) => !/^[a-z0-9-]+$/.test(g.id))) throw new Error('hub/games.json: unique ids, a-z 0-9 -');
if (!values.offline && !values['no-shots']) await captureShots(games, 'hub/shots');
const shots: Record<string, Uint8Array> = {};
for (const game of games) {
  try { shots[`shots/${game.id}.jpg`] = new Uint8Array(await readFile(new URL(`../hub/shots/${game.id}.jpg`, import.meta.url))); }
  catch { throw new Error(`No screenshot for ${game.id} (hub/shots/${game.id}.jpg): build without --no-shots to take it`); }
}
let rows: (string | number)[];
if (values.offline) {
  rows = Array.from({ length: 550 }, () => 0);
} else {
  const response = await fetch('https://otw-arcade.netlify.app/positions', { headers: { 'User-Agent': 'wall-arcade-connect-hub' } });
  if (!response.ok) throw new Error(`/positions: HTTP ${response.status}`);
  const raw = await response.json() as Item[] | { positions: Item[] };
  const wall = (Array.isArray(raw) ? raw : raw.positions).filter((item) => item.tier === 'name' || item.tier === 'pfp').sort((a, b) => a.position - b.position);
  if (wall.length !== 550) throw new Error(`Expected 550 bricks, got ${wall.length}`);
  rows = wall.map((item) => (item.minted ? (item.name || 1) : 0));
}
const marker = /\/\*SNAPSHOT:START\*\/.*?\/\*SNAPSHOT:END\*\//s;
if (!marker.test(html)) throw new Error('Snapshot markers missing in hub/src.html');
const gamesMarker = /\/\*GAMES:START\*\/.*?\/\*GAMES:END\*\//s;
if (!gamesMarker.test(html)) throw new Error('Games markers missing in hub/src.html');
const page = html.replace(marker, () => `/*SNAPSHOT:START*/${JSON.stringify(rows)}/*SNAPSHOT:END*/`)
  .replace(gamesMarker, () => `/*GAMES:START*/${JSON.stringify(games).replace(/</g, '\\u003c')}/*GAMES:END*/`);
if (!marker.test(buildersSource)) throw new Error('Snapshot markers missing in hub/builders.html');
const builders = buildersSource
  .replace("/*KIT*/''", () => JSON.stringify(kitText).replace(/<\//g, '<\\/'))
  .replace(marker, () => `/*SNAPSHOT:START*/${JSON.stringify(rows)}/*SNAPSHOT:END*/`);   // the same live wall as the hub
// the two pages link to each other with relative links only (the builders page: a discreet ← in its corner)
if (!page.includes('href="./builders.html"')) throw new Error('hub/src.html must link to ./builders.html');
if (!builders.includes('href="./"')) throw new Error('hub/builders.html must link back to ./');

const output = resolve(values.output);
let exists = false;
try { await access(output); exists = true; } catch { /* new output expected */ }
if (exists && !values.force) throw new Error(`Output exists: ${output}. Use another path or --force.`);
const archive = zipSync({ 'index.html': strToU8(page), 'builders.html': strToU8(builders), ...shots }, { level: 9 });
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try { await writeFile(temporary, archive, { flag: 'wx' }); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
const minted = rows.filter(Boolean).length;
process.stdout.write(`Hub archive: ${output}\nFiles: index.html, builders.html, ${Object.keys(shots).join(', ')}\nBricks: ${rows.length} (${minted} minted)\nSHA-256: ${createHash('sha256').update(archive).digest('hex')}\nSize: ${archive.byteLength} bytes\n`);
