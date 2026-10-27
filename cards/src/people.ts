// PEOPLE: the people of the wall as walking sprites (independent of Netlify: netlify/functions/people*.mts plug in
// Netlify Blobs and fetch). Sources, all public, no key:
//   - the wall: GET https://onthewall.nfcsummit.com/api/positions (panel, name, handle, wallet); no CORS: read here
//   - Sprite Party, event "PEOPLE OF THE WALL (NFC SUMMIT 2027)": GET https://www.spriteparty.com/api/party?party=…
//     (sprites: { id, name, src, cols, rows }), PNG 192 × 192, a 4 × 4 grid of 48 × 48 frames; no CORS either
//   - people/aliases.json: a sprite's "Player name" → the panel's name, when they do not match by themselves
// A sprite belongs to the panel(s) whose name equals its "Player name" ignoring case, spaces and accents (or through an
// alias). Each new PNG is mirrored once (it is immutable at Sprite Party too) and served from here with CORS, so games
// can draw it on a canvas. Sprites matching no panel are listed apart (unmatched.json), never shown to players.
export const PARTY = 'sp_Fr4EW5t7XNjm0E_q';
export const SPRITE_PARTY = 'https://www.spriteparty.com';
export const MANIFEST_URL = `${SPRITE_PARTY}/api/party?party=${PARTY}`;
export const POSITIONS_URL = 'https://onthewall.nfcsummit.com/api/positions';
export const CAPTURE_URL = `${SPRITE_PARTY}/p/${PARTY}/capture`;
export const SITE = 'https://wall-arcade-cards.netlify.app';
export const FRAME = 48, COLS = 4, ROWS = 4;

export type Position = { position: number; tier: string; minted?: boolean; name?: string | null; owner?: string | null; xHandle?: string | null; updatedAt?: string };
export type ManifestSprite = { id: string; name: string; src: string; cols: number; rows: number };
export type Manifest = { sprites: ManifestSprite[] };
export type Sprite = { id: string; url: string; cols: 4; rows: 4; frame: 48 };
export type Person = { panel: number; name: string; handle: string | null; wallet?: string; sprite: Sprite | null; updatedAt: string | null };
export type Unmatched = { id: string; name: string; url: string };
export type Stats = { names: number; withSprite: number; lastSpriteAt: string | null };
export type Mirrored = Record<string, string>;            // sprite id → when it was mirrored (ISO)

/** "John  Kárp" → "JOHNKARP": no case, no spaces, no accents. */
export const keyOf = (name: string): string => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toUpperCase();
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const spriteUrl = (id: string): string => `${SITE}/people/sprites/${id}.png`;

/** The sprites of the manifest that this service can serve: a uuid id, a 4 × 4 grid, a source on Sprite Party. */
export function validSprites(manifest: unknown): ManifestSprite[] {
  const list = (manifest as Manifest | null)?.sprites;
  if (!Array.isArray(list)) throw new Error('manifest: no sprites');
  return list.filter((s) => s && typeof s.id === 'string' && ID.test(s.id) && typeof s.name === 'string' && typeof s.src === 'string'
    && s.src.startsWith('/api/assets?') && s.cols === COLS && s.rows === ROWS);
}

/** A PNG of 192 × 192 (its IHDR), or nothing. */
export function isSpritePng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === COLS * FRAME && view.getUint32(20) === ROWS * FRAME;
}

/**
 * people.json (one object per named panel of the wall, in wall order), unmatched.json and stats.json, from the wall,
 * the manifest's (mirrored) sprites and the aliases. A later sprite for the same panel replaces an earlier one.
 */
export function buildPeople(positions: Position[], sprites: ManifestSprite[], aliases: Record<string, string>, mirrored: Mirrored):
  { people: Person[]; unmatched: Unmatched[]; stats: Stats } {
  const panels = positions.filter((p) => typeof p.name === 'string' && p.name.trim() !== '').sort((a, b) => a.position - b.position);
  const byKey = new Map<string, Position[]>();
  for (const p of panels) { const k = keyOf(p.name as string); byKey.set(k, [...(byKey.get(k) ?? []), p]); }
  const aliasKeys = new Map(Object.entries(aliases).map(([from, to]) => [keyOf(from), keyOf(to)]));
  const spriteOf = new Map<number, ManifestSprite>();
  const unmatched: Unmatched[] = [];
  for (const s of sprites) {
    if (!mirrored[s.id]) continue;                                    // not served yet: next refresh
    const key = keyOf(s.name), target = byKey.get(key) ?? byKey.get(aliasKeys.get(key) ?? '');
    if (target) for (const p of target) spriteOf.set(p.position, s);
    else unmatched.push({ id: s.id, name: s.name, url: spriteUrl(s.id) });
  }
  const people: Person[] = panels.map((p) => {
    const s = spriteOf.get(p.position);
    const times = [p.updatedAt ?? null, s ? mirrored[s.id] ?? null : null].filter((t): t is string => Boolean(t)).sort();
    return {
      panel: p.position, name: p.name as string, handle: p.xHandle || null, ...(p.owner ? { wallet: p.owner.toLowerCase() } : {}),
      sprite: s ? { id: s.id, url: spriteUrl(s.id), cols: COLS, rows: ROWS, frame: FRAME } : null,
      updatedAt: times.at(-1) ?? null,
    };
  });
  const served = Object.values(mirrored).sort();
  return {
    people, unmatched,
    stats: { names: people.length, withSprite: people.filter((p) => p.sprite).length, lastSpriteAt: served.at(-1) ?? null },
  };
}
