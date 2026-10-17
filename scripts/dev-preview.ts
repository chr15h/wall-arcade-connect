import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/preview', { recursive: true });
await build({ entryPoints: ['src/dev/preview.ts'], outfile: 'dist/preview/preview.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.jpg': 'dataurl' }, sourcemap: true });
await copyFile('src/shell/styles.css', 'dist/preview/styles.css');
await writeFile('dist/preview/index.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@300;400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="./styles.css"><title>preview</title></head><body><main>
<p class="eyebrow">DEV PREVIEW · in-browser coordinator stand-in · not shipped</p><p id="status" class="game-status"></p>
<section class="card"><div id="arena" class="arena"></div></section></main><script type="module" src="./preview.js"></script></body></html>`);
console.log('preview built: dist/preview');
