// FULL ROW's skin: which name of the wall each piece carries. Display only, never a rule: the engine and the verifier
// never see a name. Piece number k of a run (its draw index, the same for every player of the same seed) carries the
// k-th "name" panel of the build-time snapshot, counted from a starting point that moves once every ISO week.
import { WALL_PANELS } from '../../generated/wall.js';
import couplesData from './couples.json' with { type: 'json' };

/** The wall's "name" panels of the snapshot, in panel order: the same list for every player of a build. */
export const NAME_PANELS: readonly number[] = WALL_PANELS.filter((panel) => panel.p <= 500).map((panel) => panel.p);
/** COUPLE: pairs of names as painted on the wall (src/games/full-row/couples.json). */
export const COUPLES: readonly (readonly [string, string])[] = couplesData.couples.map((c) => [c.names[0] as string, c.names[1] as string] as const);
/** Row of a panel on the physical wall (25 panels a row; -1 outside the 500 names). */
export const wallRow = (pos: number): number => (pos >= 1 && pos <= 500 ? Math.floor((pos - 1) / 25) : -1);
/** REAL NEIGHBORS: `right` sits immediately to the right of `left` on the real wall. */
export const wallNeighbors = (left: number, right: number): boolean => right === left + 1 && wallRow(left) >= 0 && wallRow(left) === wallRow(right);

/** ISO-8601 week (UTC) as year × 100 + week. */
export function isoWeekKey(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return d.getUTCFullYear() * 100 + Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}
/** Where the names start this week. */
export const weekOffset = (weekKey: number, count = NAME_PANELS.length): number => (count > 0 ? (weekKey * 7919) % count : 0);
/** YOUR NAME: which of the first ten draws carries the signed-in holder's own name (from the seed: stable in a replay). */
export const holderDrawOf = (seed: number): number => 2 + (seed % 8);
/** The panel shown on piece number `draw` of a run. */
export function panelForDraw(draw: number, offset: number, holder: { draw: number; pos: number } | null): number {
  if (holder && draw === holder.draw) return holder.pos;
  return NAME_PANELS.length ? NAME_PANELS[(offset + draw) % NAME_PANELS.length] as number : 0;
}
