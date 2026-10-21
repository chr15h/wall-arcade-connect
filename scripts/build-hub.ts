// Builds the hub archive: index.html (the player page: the wall and the games), builders.html (artists: make a game on
// the wall) and dragon.jpg. A plain static app: no Connect, no verifier, no config. The player page's wall grid is
// embedded as a snapshot of the public /positions data; the builders page gets the Connect Kit (docs/CONNECT-KIT.md)
// inlined behind its COPY THE KIT button, after the repository's link.
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync, strToU8 } from 'fflate';

type Item = { position: number; tier: string; minted: boolean; name?: string };
const { values } = parseArgs({ args: process.argv.slice(2)[0] === '--' ? process.argv.slice(3) : process.argv.slice(2),
  options: { output: { type: 'string' }, force: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false } }, strict: true });
if (!values.output) throw new Error('Usage: npm run build:hub -- --output <hub.zip> [--force] [--offline]');

const html = await readFile(new URL('../hub/src.html', import.meta.url), 'utf8');
const buildersSource = await readFile(new URL('../hub/builders.html', import.meta.url), 'utf8');
const kitDoc = await readFile(new URL('../docs/CONNECT-KIT.md', import.meta.url), 'utf8');
const kitBlock = /```text\n([\s\S]*?)\n```/.exec(kitDoc);
if (!kitBlock) throw new Error('docs/CONNECT-KIT.md must hold the kit in a ```text block');
const REPO = 'https://github.com/hs7j4yk4sz-boop/wall-arcade-connect';
const kitText = `${REPO}\n\n${kitBlock[1]}\n`;
if (!buildersSource.includes("/*KIT*/''")) throw new Error("hub/builders.html must hold the /*KIT*/'' placeholder");
// JSON is a JavaScript string literal; </ is escaped so the kit can never close the <script>
const builders = buildersSource.replace("/*KIT*/''", () => JSON.stringify(kitText).replace(/<\//g, '<\\/'));
const dragon = await readFile(new URL('../hub/dragon.jpg', import.meta.url));
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
const page = html.replace(marker, () => `/*SNAPSHOT:START*/${JSON.stringify(rows)}/*SNAPSHOT:END*/`);
// the two pages link to each other with relative links only (the builders page: a discreet ← in its corner)
if (!page.includes('href="./builders.html"')) throw new Error('hub/src.html must link to ./builders.html');
if (!builders.includes('href="./"')) throw new Error('hub/builders.html must link back to ./');

const output = resolve(values.output);
let exists = false;
try { await access(output); exists = true; } catch { /* new output expected */ }
if (exists && !values.force) throw new Error(`Output exists: ${output}. Use another path or --force.`);
const archive = zipSync({ 'index.html': strToU8(page), 'builders.html': strToU8(builders), 'dragon.jpg': new Uint8Array(dragon) }, { level: 9 });
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try { await writeFile(temporary, archive, { flag: 'wx' }); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
const minted = rows.filter(Boolean).length;
process.stdout.write(`Hub archive: ${output}\nFiles: index.html, builders.html, dragon.jpg\nBricks: ${rows.length} (${minted} minted)\nSHA-256: ${createHash('sha256').update(archive).digest('hex')}\nSize: ${archive.byteLength} bytes\n`);
