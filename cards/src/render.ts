// Server-side rendering with @napi-rs/canvas: the very drawing code of the cards (src/share/card-draw.ts), the fonts
// registered under the family names it asks for, the dragon decoded once.
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { boardCard, fullRowCard, unbreakableCard, xPreview, type CardEnv, type DragonImage } from '../../src/share/card-draw.js';
import { ANTON_400, DRAGON_JPG, MONO_400, MONO_500 } from './assets.generated.js';
import { GAMES, gameOf, type Card } from './validate.js';

let ready: Promise<void> | null = null;
let dragon: DragonImage | null = null;
function setup(): Promise<void> {
  ready ??= (async () => {
    GlobalFonts.register(Buffer.from(ANTON_400, 'base64'), 'WallCard Anton');
    GlobalFonts.register(Buffer.from(MONO_400, 'base64'), 'WallCard Mono');
    GlobalFonts.register(Buffer.from(MONO_500, 'base64'), 'WallCard Mono');
    dragon = await loadImage(Buffer.from(DRAGON_JPG, 'base64')) as unknown as DragonImage;     // decoded before any card is drawn
  })();
  return ready;
}
const env: CardEnv = { createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement };
const encode = (canvas: HTMLCanvasElement): Buffer => (canvas as unknown as { toBuffer(mime: 'image/png'): Buffer }).toBuffer('image/png');
const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function square(card: Card, wallNames: readonly string[]): HTMLCanvasElement {
  const game = GAMES[gameOf(card)];
  const base = { game: game.title, url: game.url, wallNames, dragon };
  if (card.kind === 'row') {
    return fullRowCard(env, base, { label: `BEST ROW · ${card.line} · ${fmt(card.points)} PTS`, names: card.names, player: card.player ?? '', score: card.score, practice: card.practice });
  }
  if (card.kind === 'bounce') return unbreakableCard(env, base, { people: card.people, names: card.names, score: card.score, practice: card.practice });
  return boardCard(env, base, { rows: card.rows, caption: 'SERVER-VERIFIED · ALL TIME' });
}
/** The card itself (1080 × 1080) and its X preview (1200 × 630, the whole card visible). */
export async function renderCard(card: Card, wallNames: readonly string[]): Promise<{ square: Buffer; preview: Buffer }> {
  await setup();
  const sq = square(card, wallNames);
  return { square: encode(sq), preview: encode(xPreview(env, sq, wallNames)) };
}
