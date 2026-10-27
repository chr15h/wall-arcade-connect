// The people of the wall in the games: the card service's people.json (one object per named panel, its walking sprite
// or null), read once per page, display only. Names match as on the card service (no case, spaces or accents); a sheet
// is loaded on first use (CORS *, so it can be drawn on a canvas) and `onPeople` is told when it arrives. The Sprite
// Party capture link is never in the page: the card service gives it to a wallet that holds a name (/people/capture).
import { CARD_SERVICE } from '../share/post.js';
import { nameKey, type SpriteSheet } from '../share/sprite.js';

export type Person = { panel: number; name: string; wallet?: string; sprite: { url: string } | null };
const SHEET_URL = /^https:\/\/wall-arcade-cards\.netlify\.app\/people\/sprites\/[0-9a-f-]{36}\.png$/;

let people: Person[] = [];
let byName = new Map<string, Person>();
let loading: Promise<Person[]> | null = null;
const sheets = new Map<string, HTMLImageElement>();
const listeners: (() => void)[] = [];

function valid(p: unknown): p is Person {
  const o = p as Person | null;
  return Boolean(o && typeof o.name === 'string' && typeof o.panel === 'number'
    && (o.sprite === null || (typeof o.sprite?.url === 'string' && SHEET_URL.test(o.sprite.url))));
}
/** people.json, once per page (again after a failure). */
export function loadPeople(): Promise<Person[]> {
  loading ??= fetch(`${CARD_SERVICE}/people.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((list: unknown) => {
      people = Array.isArray(list) ? list.filter(valid) : [];
      byName = new Map(people.map((p) => [nameKey(p.name), p]));
      for (const f of listeners) f();
      return people;
    }, () => { loading = null; return []; });
  return loading;
}
/** The panels a wallet holds, as people.json has them (empty before it is read). */
export const peopleOf = (wallet: string | undefined): Person[] => (wallet ? people.filter((p) => p.wallet === wallet.toLowerCase()) : []);
/** A holder of a name of the wall whose names have no character yet: their first name, else null. */
export function missingCharacter(wallet: string | undefined): string | null {
  const mine = peopleOf(wallet);
  return mine.length && !mine.some((p) => p.sprite) ? (mine[0] as Person).name : null;
}
/** The capture link for a wallet that holds a name of the wall (asked once per wallet), else null. */
const captures = new Map<string, Promise<string | null>>();
const captured = new Map<string, string>();
export function captureFor(wallet: string): Promise<string | null> {
  const key = wallet.toLowerCase();
  let ask = captures.get(key);
  if (!ask) {
    ask = fetch(`${CARD_SERVICE}/people/capture?wallet=${key}`).then((r) => (r.ok ? r.json() : null)).then((d: { url?: unknown } | null) => {
      const url = d && typeof d.url === 'string' && /^https:\/\/www\.spriteparty\.com\/p\/[A-Za-z0-9_-]+\/capture$/.test(d.url) ? d.url : null;
      if (url) captured.set(key, url);
      return url;
    }, () => { captures.delete(key); return null; });
    captures.set(key, ask);
  }
  return ask;
}
/** The capture link already given for this wallet, if any. */
export const knownCapture = (wallet: string | undefined): string | null => (wallet ? captured.get(wallet.toLowerCase()) ?? null : null);
/** Called when people.json or a sheet arrives (a game redraws). */
export const onPeople = (f: () => void): void => { listeners.push(f); };

function sheet(url: string): SpriteSheet | null {
  let img = sheets.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => { for (const f of listeners) f(); };
    img.src = url;
    sheets.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}
/** The sprite sheet of a name of the wall, once loaded; null if it has none (or not yet). */
export function sheetOfName(name: string): SpriteSheet | null {
  const url = byName.get(nameKey(name))?.sprite?.url;
  return url ? sheet(url) : null;
}
/** The sprite sheet of a wallet's first name that has one, once loaded. */
export function sheetOfWallet(wallet: string | undefined): SpriteSheet | null {
  const url = peopleOf(wallet).find((p) => p.sprite)?.sprite?.url;
  return url ? sheet(url) : null;
}
