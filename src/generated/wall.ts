import snapshot from './wall.json' with { type: 'json' };

export type WallPanel = { p: number; n: string; h?: string };
export const WALL_PANELS: readonly WallPanel[] = snapshot.positions;
/** Ascending positions of the named panels at build time (the verifier has no network). */
export const ELIG: readonly number[] = WALL_PANELS.map((panel) => panel.p);
export const WALL_TAKEN_AT: string = snapshot.takenAt;
const nameKey = (name: string): string => name.trim().toUpperCase();
const nameCount = new Map<string, number>();
for (const panel of WALL_PANELS) nameCount.set(nameKey(panel.n), (nameCount.get(nameKey(panel.n)) ?? 0) + 1);
/** TAP THE NAME's pool: the named panels whose name is unique on the wall. Two panels with the same name (5 such pairs on
 *  2026-10-17) can never meet in one question, so the button with the target's name is always the target's panel.
 *  Client and verifier are built from this same list. */
export const TAP_POOL: readonly number[] = WALL_PANELS.filter((panel) => nameCount.get(nameKey(panel.n)) === 1).map((panel) => panel.p);
