// The end of a run, one screen, the same on both games: the card itself (the very image POST ON X shares, drawn here by
// src/share/card-draw.ts), full width, POST ON X in blue under it (always, on a real run), and a small "get on the
// wall" at the bottom right. PLAY AGAIN stays the page's own bar under this screen. In practice the card says PRACTICE
// and there is nothing to post.
import { fullRowCard, unbreakableCard, type BounceCardData, type CardBase, type CardEnv, type DragonImage, type RowCardData } from './card-draw.js';
import { allNames } from '../shell/wall-data.js';
import { wirePostLink, type CardRequest } from './post.js';
import dragonUrl from '../assets/dragon.jpg';

export type EndScreen = {
  /** Game title, as on the card. */
  game: string;
  /** What the card shows. */
  card: { kind: 'row'; data: RowCardData } | { kind: 'bounce'; data: BounceCardData };
  /** The card to post, or null (practice, or nothing to post). */
  post: CardRequest | null;
  tweet: (link: string) => string;
  postLabel: string;
  /** The game's address: shown on the card, and where the tweet points if the card service cannot be reached. */
  gameUrl: string;
};

/** "#3" -> 3; "—" or "Not top 10" -> undefined. */
export const rankOf = (rank: string | undefined): number | undefined => {
  const m = rank ? /^#(\d+)$/.exec(rank) : null;
  return m ? Number(m[1]) : undefined;
};

const env: CardEnv = { createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }) };
let dragon: DragonImage | null = null;
const dragonLoaded = new Promise<void>((resolve) => {
  const img = new Image();
  img.onload = () => { dragon = img; resolve(); };
  img.onerror = () => resolve();
  img.src = dragonUrl;
});

export type EndMemo = { key: string; anchor: HTMLAnchorElement | null; drawn: string };

/** Draws the screen into `panel`. The post link is made once per card (`memo` keeps it across redraws). */
export function renderEndScreen(panel: HTMLElement, data: EndScreen, memo: EndMemo): void {
  const base: CardBase = { game: data.game, url: data.gameUrl, wallNames: allNames(), dragon };
  const drawn = JSON.stringify([data.card, Boolean(dragon), base.wallNames.length]);
  let canvas = panel.querySelector<HTMLCanvasElement>('canvas.end-card');
  if (!canvas || memo.drawn !== drawn) {
    const fresh = data.card.kind === 'row' ? fullRowCard(env, base, data.card.data) : unbreakableCard(env, base, data.card.data);
    fresh.className = 'end-card';
    fresh.setAttribute('role', 'img');
    fresh.setAttribute('aria-label', `Your card: ${data.card.data.score} points${data.card.data.rank ? `, #${data.card.data.rank} this week` : ''}.`);
    canvas = fresh;
    memo.drawn = drawn;
  }
  // the post link survives redraws (the rank arrives a moment later): one link per card
  const key = data.post ? JSON.stringify(data.post) : '';
  let anchor = memo.key === key ? memo.anchor : null;
  if (data.post && !anchor) {
    anchor = document.createElement('a');
    anchor.className = 'end-post';
    wirePostLink(anchor, data.post, data.tweet, data.gameUrl, data.postLabel);
    memo.key = key; memo.anchor = anchor;
  }
  const wall = document.createElement('a');
  wall.className = 'end-wall'; wall.href = 'https://onthewall.nfcsummit.com'; wall.target = '_blank'; wall.rel = 'noopener';
  wall.textContent = 'get on the wall';
  panel.replaceChildren(...(anchor ? [canvas, anchor, wall] : [canvas, wall]));
  if (!dragon) void dragonLoaded.then(() => { if (dragon && panel.isConnected && !panel.hidden) renderEndScreen(panel, data, memo); });
}
