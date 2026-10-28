// Builds src/games/whitewash/art/xcopy.json, NFT INVADERS' waves of XCOPY, from a saved copy of xcopy.art's "Works" page
// (a .docx: its section headings name each release and year, its images are the works). XCOPY's own works are CC0
// (xcopy.art/creative-commons: "XCOPY works are licensed under CC0 (Public Domain) … Derivative and collaborative works
// may have different rights retained by the original artist"), so releases that may be collaborations are left out.
// Each work is reduced to 96 × 96 (an animated GIF to its first frame) and embedded as a data URL.
//   node --import tsx scripts/xcopy-works-art.ts <Works.docx>
import { readFile, writeFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { reduceWork } from './cutout.js';

const SIZE = 96, PER_WAVE = 12;
/** One wave per series, in this order; `from` lists the page's section headings (release names) it draws on. */
const WAVES: { key: string; title: string; years: string; from: string[] }[] = [
  { key: 'max-pain', title: 'MAX PAIN AND FRENS', years: '2022', from: ['MAX PAIN AND FRENS'] },
  { key: 'traitors', title: 'TRAITORS', years: '2021–22', from: ['TRAITORS', 'TRAITORS REDEMPTION'] },
  { key: 'superrare-2019', title: 'SUPERRARE 2019', years: '2019', from: ['2019 SUPERRARE'] },
  { key: 'fresh-hell', title: 'FRESH HELL', years: '2023–25', from: ['FRESH HELL', 'DAMAGE CONTROL', 'RΞMNANTS'] },
  { key: 'superrare', title: 'SUPERRARE', years: '2020–23', from: ['2020 SUPERRARE', '2021 SUPERRARE', '2022 SUPERRARE', '2023 SUPERRARE'] },
  { key: 'early', title: 'EARLY WORKS', years: '2019–21', from: ['KNOWNORIGIN', 'RARIBLE', 'Opensea', 'NGMI', 'DISRUPTOR', 'SELECT WORKS'] },
];
/** Releases left out: possibly collaborations or curated by others (XCOPY's CC0 statement does not cover those), among
 *  them Async Art's 2020 layered pieces; and ICXN (an icon, not a figure). */
const COLLABORATIONS = ['The Memes by 6529', 'COINDESK MOST INFLUENTIAL', 'Kolectiv', 'NFT Boxes', 'ASYNC ART', 'Deca', 'Noble Gallery', 'PixelChain', 'ICXN'];
/** Not left out for its licence: GRIFTERS (his own Async Art Blueprint, issued and signed by him) have their own wave,
 *  read from the chain at full size by scripts/raiders-art.ts, so the page's single Grifter is not taken twice. */
const LEFT_OUT = [...COLLABORATIONS, 'GRIFTERS'];

const docx = process.argv[2];
if (!docx) throw new Error('Usage: xcopy-works-art.ts <Works.docx>');
const files = unzipSync(new Uint8Array(await readFile(docx)));
const xml = strFromU8(files['word/document.xml'] as Uint8Array);
const rels = strFromU8(files['word/_rels/document.xml.rels'] as Uint8Array);
const target = new Map([...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1] as string, m[2] as string]));
const decode = (s: string): string => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

// walk the page: a 4-digit paragraph is a year, any other text a release heading, each image belongs to the last two
type Work = { year: string; release: string; media: string };
const works: Work[] = [];
let year = '', release = '';
for (const p of xml.split('</w:p>')) {
  const text = decode([...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').trim());
  if (/^\d{4}$/.test(text)) year = text; else if (text) release = text;
  for (const m of p.matchAll(/r:embed="(rId\d+)"/g)) { const media = target.get(m[1] as string); if (media) works.push({ year, release, media: `word/${media}` }); }
}
const matches = (w: Work, name: string): boolean => (/^\d{4} /.test(name) ? `${w.year} ${w.release}` === name : w.release === name);

const out: { key: string; title: string; years: string; items: { year: string; release: string; cut: boolean; src: string }[] }[] = [];
for (const wave of WAVES) {
  const pool = works.filter((w) => wave.from.some((name) => matches(w, name)) && !LEFT_OUT.includes(w.release));
  const pick = pool.length <= PER_WAVE ? pool : Array.from({ length: PER_WAVE }, (_, i) => pool[Math.floor(i * pool.length / PER_WAVE)] as Work);
  const items: { year: string; release: string; cut: boolean; src: string }[] = [];
  for (const w of pick) {
    const bytes = files[w.media];
    if (!bytes) continue;
    const { data, cut } = await reduceWork(await loadImage(Buffer.from(bytes)), SIZE, true, createCanvas);   // the centre square, its black ground cut when clean
    items.push({ year: w.year, release: w.release, cut, src: `data:image/webp;base64,${data.toString('base64')}` });
  }
  out.push({ key: wave.key, title: wave.title, years: wave.years, items });
  console.log(`${wave.title}: ${items.length} works (of ${pool.length}), ${items.filter((i) => i.cut).length} cut out`);
}
const json = { source: 'xcopy.art, Works (saved page)', license: 'CC0-1.0: "XCOPY works are licensed under CC0 (Public Domain)" (xcopy.art/creative-commons)', size: SIZE, waves: out };
await writeFile(new URL('../src/games/whitewash/art/xcopy.json', import.meta.url), `${JSON.stringify(json)}\n`);
console.log(`xcopy.json: ${out.reduce((n, w) => n + w.items.length, 0)} works in ${out.length} waves`);
