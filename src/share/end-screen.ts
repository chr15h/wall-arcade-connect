// The end of a run, one screen, the same on both games: RUN OVER (score, rank, record) · what the run painted (FULL ROW:
// your best row; UNBREAKABLE: the people of the wall the balls bounced off) · a big blue POST … ON X · a small line to
// the open panels. PLAY AGAIN stays the page's own button, in ink, in the bar under this screen.
import type { EndStats } from '../shell/adapter.js';
import { wirePostLink, type CardRequest } from './post.js';

export type EndScreen = {
  practice: boolean;
  score: number;
  stats: EndStats | null;
  /** e.g. "Your best row · ROW 4 · 120 pts" */
  label: string;
  /** UNBREAKABLE's "I bounced off 12 people of the wall"; absent for FULL ROW. */
  headline?: string;
  names: string[];
  /** The card to post, or null (nothing to post: no full row this time). */
  card: CardRequest | null;
  tweet: (link: string) => string;
  postLabel: string;
  /** Where the tweet points if the card service cannot be reached: the cabinet. */
  cabinet: string;
};

const fmt = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtStat = (s: string): string => (/^\d+$/.test(s) ? fmt(Number(s)) : s);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}

/** Draws the screen into `panel`. The card is only created once per run (`cardKey` remembers it across redraws). */
export function renderEndScreen(panel: HTMLElement, data: EndScreen, memo: { key: string; anchor: HTMLAnchorElement | null }): void {
  const stats = data.stats;
  const grid = el('div', '', 'end-stats');
  const cell = (label: string, value: string, main = false): HTMLElement => { const c = el('div', '', main ? 'main' : ''); c.append(el('span', label, ''), el('strong', value, '')); return c; };
  grid.append(cell(data.practice ? 'Practice score' : 'Score', fmt(data.score), true), cell('Rank', stats?.rank ?? '…'),
    cell(stats?.bestLabel === 'Best' ? 'Record' : (stats?.bestLabel ?? 'Record'), stats ? fmtStat(stats.best) : '…'));
  const head = el('div', '', 'end-head');
  head.append(el('p', data.practice ? "Practice · scores don't count" : 'Server-verified · recorded by SuperRare', 'end-eyebrow'),
    el('h2', data.practice ? 'Practice over' : 'Run over', 'end-title'), grid);

  const run = el('div', '', 'end-run');
  run.append(el('p', data.label, 'end-eyebrow'));
  if (data.headline) run.append(el('p', data.headline, 'end-headline'));
  if (data.names.length) {
    const names = el('p', '', data.headline ? 'end-names' : 'end-bignames');
    names.textContent = data.headline ? data.names.join(' · ') : '';
    if (!data.headline) for (const n of data.names) names.append(el('span', n, 'end-bigname'));
    run.append(names);
  }
  // the post link survives redraws (the rank arrives a moment later): the same card, the same link
  const key = data.card ? JSON.stringify(data.card) : '';
  let anchor = memo.key === key ? memo.anchor : null;
  if (data.card && !anchor) {
    anchor = document.createElement('a');
    anchor.className = 'end-post';
    wirePostLink(anchor, data.card, data.tweet, data.cabinet, data.postLabel);
    memo.key = key; memo.anchor = anchor;
  }
  if (anchor) run.append(anchor);

  const open = el('p', 'Open panels are waiting for a name ', 'end-open');
  const link = document.createElement('a');
  link.href = 'https://onthewall.nfcsummit.com'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = '→ get on the wall';
  open.append(link);
  panel.replaceChildren(head, run, open);
}
