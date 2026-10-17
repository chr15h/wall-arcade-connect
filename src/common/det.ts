// Deterministic toolkit shared by the browser prediction and the server verifier.
// Only + - * / sqrt floor abs and integer ops are used by the simulations built on it: those are exact /
// correctly rounded in every JS engine (Math.sin, cos, hypot, pow, log are not), so the same inputs give the same
// state in a Cloudflare isolate, on iOS Safari and in Node. Ported unchanged from UNBREAKABLE v5.1.

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// sin and cos of an angle given in hundredths of a degree, by Taylor series (basic operations only)
export function sinCos100(a100: number): [number, number] {
  const x = a100 * (3.141592653589793 / 18000), x2 = x * x;
  let ts = x, s = x, tc = 1, c = 1;
  for (let i = 1; i <= 16; i++) {
    ts = -ts * x2 / ((2 * i) * (2 * i + 1)); s += ts;
    tc = -tc * x2 / ((2 * i - 1) * (2 * i)); c += tc;
  }
  return [s, c];
}

// xorshift32 step used by TAP THE NAME (same generator as the upstream example)
export function xorshift32(state: number): number {
  let v = state;
  v ^= v << 13; v ^= v >>> 17; v ^= v << 5;
  return v >>> 0;
}
