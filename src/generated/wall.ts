import snapshot from './wall.json' with { type: 'json' };

export type WallPanel = { p: number; n: string; h?: string };
export const WALL_PANELS: readonly WallPanel[] = snapshot.positions;
/** Ascending positions of the named panels at build time (the verifier has no network). */
export const ELIG: readonly number[] = WALL_PANELS.map((panel) => panel.p);
export const WALL_TAKEN_AT: string = snapshot.takenAt;
