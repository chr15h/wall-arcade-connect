// FULL ROW's only clock on screen: the server cap stays invisible until its last minute.
import type { FrState } from './core.js';

export const TICK_MS = 50;
/** Server ticks left before the run's cap (the round length counted from the start). */
export const ticksLeft = (S: FrState, tick: number): number =>
  Math.max(0, S.startTick === null ? S.rules.roundTicks : S.rules.roundTicks - (tick - S.startTick));
/** LAST MINUTE shows only in the last 60 s of server time before the cap. */
export const lastMinute = (left: number): boolean => left <= 60_000 / TICK_MS;
export const fmtClock = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(ticks * TICK_MS / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
