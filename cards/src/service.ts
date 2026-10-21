// The card service, independent of Netlify (the function in netlify/functions/cards.mts plugs in Netlify Blobs):
//   POST /api/cards          a card's fields (validated) -> { id, url, image }; the card is stored and rendered once
//   GET  /r/<id>             a page with the og: / twitter: tags of the card, which sends a person on to the game
//   GET  /r/<id>.png         the card (1080 × 1080)
//   GET  /r/<id>.x.png       its link preview for X (1200 × 630, the whole card visible)
// The id is a hash of the validated card: the same card always gets the same link.
import { createHash } from 'node:crypto';
import { CardError, GAMES, gameOf, player, validate, type BoardCard, type BoardRequest, type Card, type GameKey } from './validate.js';
import { renderCard } from './render.js';

export interface CardStore {
  get(key: string, type: 'json'): Promise<unknown>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  set(key: string, value: string | ArrayBuffer | Blob): Promise<unknown>;
}
export type LeaderEntry = { rank: number; score: string | number; player?: { kind?: string; displayName?: string; ensName?: string | null } };
export type Deps = { store: CardStore; wallNames(): Promise<string[]>; leaderboard(game: GameKey): Promise<LeaderEntry[]> };

const ALLOWED_ORIGINS = new Set(['https://yfq52eu3.srstudio.dev', 'https://7x2phv5j.srstudio.dev', 'https://6972mvu4.srstudio.dev']);
const isAllowed = (origin: string | null): boolean => origin !== null && (ALLOWED_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
const cors = (request: Request): Record<string, string> => {
  const origin = request.headers.get('origin');
  return isAllowed(origin) ? { 'Access-Control-Allow-Origin': origin as string, 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' } : {};
};
const json = (request: Request, status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request) } });
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Bump when the drawing changes: a card's id (and so its cached image) then changes too. */
export const RENDER_VERSION = 4;
export const cardId = (card: Card): string => createHash('sha256').update(`${RENDER_VERSION}:${JSON.stringify(card)}`).digest('base64url').slice(0, 16);

/** The line under the preview in X, and the page's description. */
export function describe(card: Card): string {
  const rank = card.kind !== 'board' && card.rank ? ` #${card.rank} this week.` : '';
  if (card.kind === 'row') return `${card.names.join(' · ')}: painted together on FULL ROW${card.player ? ` by ${card.player}` : ''}. ${fmt(card.score)} points.${rank}`;
  if (card.kind === 'bounce') return `Bounced off ${card.people} people of the wall on UNBREAKABLE. ${fmt(card.score)} points.${rank}`;
  const me = card.rows.find((r) => r.me);
  return me ? `#${me.rank} on ${GAMES[card.game].title} · ${fmt(me.score)} points.` : `The top 5 of ${GAMES[card.game].title}.`;
}

function page(origin: string, id: string, card: Card): string {
  const game = GAMES[gameOf(card)], title = `${game.title} · THE WALL ARCADE`, text = describe(card);
  const image = `${origin}/r/${id}.x.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(text)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="THE WALL ARCADE">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(text)}">
<meta property="og:url" content="${esc(`${origin}/r/${id}`)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(text)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(text)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(text)}">
<meta http-equiv="refresh" content="0; url=${esc(game.url)}">
<link rel="canonical" href="${esc(game.url)}">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#DEDBD3;color:#0B0B0B;font:500 14px/1.5 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}a{color:#0B0B0B}</style>
</head><body><p><a href="${esc(game.url)}">Play ${esc(game.title)} on THE WALL ARCADE →</a></p>
<script>location.replace(${JSON.stringify(game.url)});</script>
</body></html>`;
}

class BoardUnavailable extends Error {}
/** The rows of a board card come from the platform's public leaderboard (top 10 of THIS WEEK, Friday 15:00 Lisbon): the top 5, plus the
 *  highlighted player's own line when they rank lower. */
async function boardFromPlatform(asked: BoardRequest, deps: Deps): Promise<BoardCard> {
  let entries: LeaderEntry[];
  try { entries = await deps.leaderboard(asked.game); } catch { throw new BoardUnavailable('the leaderboard could not be read'); }
  const rows = entries.flatMap((e) => {
    const p = e.player ?? {}, raw = p.ensName || p.displayName || '';
    let name: string; try { name = player(raw); } catch { return []; }   // a name that is neither ENS nor an address is left out
    const score = Number(e.score);
    return Number.isSafeInteger(e.rank) && Number.isSafeInteger(score) && score >= 0
      ? [{ rank: e.rank, name, score, ...(asked.me && (asked.me === name || (p.displayName && player(p.displayName) === asked.me)) ? { me: true } : {}) }] : [];
  });
  if (!rows.length) throw new BoardUnavailable('no server-verified score yet');
  const me = rows.find((r) => r.me);
  return { kind: 'board', game: asked.game, rows: [...rows.filter((r) => r.rank <= 5), ...(me && me.rank > 5 ? [me] : [])].slice(0, 6) };
}

async function stored(deps: Deps, id: string): Promise<Card | null> {
  const value = await deps.store.get(`${id}.json`, 'json');
  return value && typeof value === 'object' ? value as Card : null;
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url), origin = url.origin, path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (path === '/api/cards') {
    if (request.method !== 'POST') return json(request, 405, { error: 'POST a card' });
    const raw = await request.text();
    if (raw.length > 8192) return json(request, 413, { error: 'too large' });
    let card: Card;
    try {
      const wall = new Set((await deps.wallNames()).map((n) => n.trim().toUpperCase()));
      const asked = validate(JSON.parse(raw) as unknown, wall);
      card = asked.kind === 'board' ? await boardFromPlatform(asked, deps) : asked;
    } catch (error) {
      if (error instanceof BoardUnavailable) return json(request, 502, { error: error.message });
      return json(request, 400, { error: error instanceof CardError ? error.message : 'invalid JSON' });
    }
    const id = cardId(card);
    if (!(await stored(deps, id))) {
      const { square, preview } = await renderCard(card, await deps.wallNames());
      await deps.store.set(`${id}.png`, square.buffer.slice(square.byteOffset, square.byteOffset + square.byteLength) as ArrayBuffer);
      await deps.store.set(`${id}.x.png`, preview.buffer.slice(preview.byteOffset, preview.byteOffset + preview.byteLength) as ArrayBuffer);
      await deps.store.set(`${id}.json`, JSON.stringify(card));
    }
    return json(request, 200, { id, url: `${origin}/r/${id}`, image: `${origin}/r/${id}.png` });
  }
  const match = /^\/r\/([A-Za-z0-9_-]{16})(\.x\.png|\.png)?$/.exec(path);
  if (match && (request.method === 'GET' || request.method === 'HEAD')) {
    const id = match[1] as string, ext = match[2];
    const card = await stored(deps, id);
    if (!card) return new Response('No such card', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (!ext) return new Response(page(origin, id, card), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    let png = await deps.store.get(`${id}${ext}`, 'arrayBuffer');
    if (!png) {                                                    // rendered on demand if the stored image is missing
      const { square, preview } = await renderCard(card, await deps.wallNames());
      const buf = ext === '.png' ? square : preview;
      png = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      await deps.store.set(`${id}${ext}`, png);
    }
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  }
  if (path === '/' || path === '') return Response.redirect('https://6972mvu4.srstudio.dev/', 302);
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
}
