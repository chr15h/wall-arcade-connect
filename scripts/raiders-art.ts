// Builds NFT INVADERS' CC0 raider art (src/games/whitewash/art/<collection>.json): for each collection, a set of
// tokens read from the chain (tokenURI, public RPC), their metadata and original image (IPFS / Arweave, public
// gateways), each checked to belong to the collection, reduced and embedded as a data URL. No key. Originals can be large
// (Grifters: ~15 MB each): pass a cache folder to keep them between runs.
//   node --import tsx scripts/raiders-art.ts [cache-dir] [collection,…]
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { reduceWork } from './cutout.js';

type Meta = { name: string; image: string; description?: string; attributes?: { trait_type: string; value: string }[] };
type Collection = {
  key: string; title: string; contract: string; license: string; tokens: number[];
  /** Output size in px, and whether the art is pixel art (reduced without smoothing, kept sharp). */
  size: number; pixel: boolean;
  /** The ground cut away when it leaves a clean figure: black (XCOPY) or the plain colour of its edges. */
  ground: 'black' | 'plain';
  /** The token really is a piece of this collection (its own metadata says so). */
  check(meta: Meta): boolean;
};
const spread = (from: number, to: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + Math.round(i * (to - from) / (n - 1)));
const COLLECTIONS: Collection[] = [
  { key: 'grifters', title: 'Grifters by XCOPY (Async Art Blueprint)', contract: '0xc143bbfcdbdbed6d454803804752a064a622c1f3',
    license: 'CC0-1.0 (XCOPY’s dedication of his own work)', tokens: [10, 60, 110, 160, 210, 260, 310, 360, 410, 460, 510, 560, 610, 660],
    size: 96, pixel: false, ground: 'black', check: (m) => Boolean(m.attributes?.some((a) => a.trait_type === 'Artist' && a.value === 'XCOPY')) },
  { key: 'cryptoadz', title: 'CrypToadz by Gremplin', contract: '0x1CB1A5e65610AEFF2551A50f76a87a7d3fB649C6',
    license: 'CC0-1.0 (Gremplin waived all copyright and related rights)', tokens: spread(5, 6305, 14),
    size: 72, pixel: true, ground: 'plain', check: (m) => /^CrypToadz #\d+$/.test(m.name) },
  { key: 'mfers', title: 'mfers by sartoshi', contract: '0x79FCDEF22feeD20eDDacbB2587640e45491b757f',
    license: 'CC0-1.0 (sartoshi released mfers to the public domain)', tokens: spread(5, 9105, 14),
    size: 96, pixel: false, ground: 'plain', check: (m) => m.description === 'mfers by sartoshi' && /^mfer #\d+$/.test(m.name) },
];
const RPC = 'https://ethereum-rpc.publicnode.com';
const IPFS = ['https://gateway.pinata.cloud/ipfs', 'https://ipfs.filebase.io/ipfs', 'https://w3s.link/ipfs', 'https://4everland.io/ipfs'];
const [cacheArg, onlyArg] = process.argv.slice(2);
const only = onlyArg ? new Set(onlyArg.split(',')) : null;

async function tokenURI(contract: string, token: number): Promise<string> {
  const data = `0xc87b56dd${token.toString(16).padStart(64, '0')}`;
  const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }) });
  const hex = ((await response.json()) as { result: string }).result.slice(2);
  const length = parseInt(hex.slice(64, 128), 16);
  return Buffer.from(hex.slice(128, 128 + length * 2), 'hex').toString();
}
/** Every URL an ipfs:// / ar:// / https:// URI can be read at, gateways in turn. */
const urls = (uri: string): string[] => (/^ipfs:\/\//.test(uri) ? IPFS.map((g) => uri.replace(/^ipfs:\/\/(ipfs\/)?/, `${g}/`))
  : [uri.replace(/^ar:\/\//, 'https://arweave.net/')]);
async function get(uri: string): Promise<Buffer> {
  let last = '';
  for (const url of urls(uri)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (response?.ok) return Buffer.from(await response.arrayBuffer());
      last = `${url}: ${response ? `HTTP ${response.status}` : 'unreachable'}`;
      if (response && response.status === 404) break;
    }
  }
  throw new Error(last);
}
async function cached(dir: string | undefined, name: string, load: () => Promise<Buffer>): Promise<Buffer> {
  const file = dir ? join(dir, name) : null;
  if (file && existsSync(file)) return readFile(file);
  const body = await load();
  if (file) await writeFile(file, body);
  return body;
}

for (const c of COLLECTIONS) {
  if (only && !only.has(c.key)) continue;
  const dir = cacheArg ? join(cacheArg, c.key) : undefined;
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const items: { token: number; name: string; image: string; cut: boolean; src: string }[] = [];
  for (const wanted of c.tokens) {
    // a token whose image no gateway serves any more is replaced by the next one
    let token = wanted, meta: Meta | null = null, bytes: Buffer | null = null;
    for (; token < wanted + 5 && !bytes; token++) {
      try {
        meta = JSON.parse((await cached(dir, `m${token}.json`, async () => get(await tokenURI(c.contract, token)))).toString()) as Meta;
        if (!c.check(meta)) throw new Error(`${c.key} token ${token}: its metadata does not belong to the collection`);
        bytes = await cached(dir, `${token}.bin`, () => get((meta as Meta).image));
      } catch (error) { console.log(`  ${c.key} token ${token} skipped: ${error instanceof Error ? error.message : error}`); }
    }
    token--;
    if (!meta || !bytes) throw new Error(`${c.key}: no image near token ${wanted}`);
    const { data, cut } = await reduceWork(await loadImage(bytes), c.size, !c.pixel, createCanvas, c.ground);   // its ground cut when clean
    items.push({ token, name: meta.name, image: meta.image, cut, src: `data:image/webp;base64,${data.toString('base64')}` });
    console.log(`${c.key}: ${meta.name} (token ${token}) ${data.length} bytes${cut ? ', cut out' : ''}`);
  }
  const out = { source: `${c.title}, contract ${c.contract}`, license: c.license, size: c.size, pixel: c.pixel, items };
  await writeFile(new URL(`../src/games/whitewash/art/${c.key}.json`, import.meta.url), `${JSON.stringify(out)}\n`);
  console.log(`${c.key}.json: ${items.length} pieces`);
}
