// Loads the ORIGINAL v5.1 simulation (wall-arcade/games/unbreakable/src.html) as the reference implementation for
// differential tests. The original file is read, never modified. Returns null when it is not on this machine.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type OriginalSim = {
  rows: { n: number; cells: ({ t: number; hp: number; hp0: number; pos: number } | { t: 3 } | null)[] }[];
  turn: number; nBalls: number; originX: number; phase: number; balls: { x: number; y: number; vx: number; vy: number; land: boolean; age: number }[];
  toFire: number; fireCd: number; score: number; broken: number; hits: number; recalls: number; round: number; seqPos: number;
  step(): void; fire(a100: number): boolean;
};
export type OriginalModule = { makeSim: (cfg: { week: string; elig: number[] }) => OriginalSim };

export function loadOriginal(): OriginalModule | null {
  const file = join(homedir(), 'wall-arcade/games/unbreakable/src.html');
  if (!existsSync(file)) return null;
  const html = readFileSync(file, 'utf8');
  const rules = html.slice(html.indexOf('const RULES = {'), html.indexOf('};', html.indexOf('const RULES = {')) + 2);
  const start = html.indexOf('/* ============================ DETERMINISTIC TOOLKIT');
  const end = html.indexOf('/* ================================== DATA');
  if (!rules.startsWith('const RULES') || start < 0 || end < 0) throw new Error('Original simulation markers not found');
  const body = `"use strict";\n${rules}\n${html.slice(start, end)}\nreturn { makeSim };`;
  return new Function(body)() as OriginalModule;
}
