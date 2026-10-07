// lib/rng.js — seeded randomness. Never Math.random: every frame must be identical on every run and in any order.
// Seed per element (rngFor('tile', i)), never one shared stream: a shared stream shifts every value drawn after an
// element that consumed a different amount of randomness this frame (ClaudeAnimationBase commit 4751cc7).

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const fnvByte = (h, b) => Math.imul(h ^ b, FNV_PRIME) >>> 0;

// Stable 32-bit FNV-1a over the UTF-8 bytes of String(part), parts joined with '\u0001'.
export function hash32(...parts) {
  let h = FNV_OFFSET;
  for (let p = 0; p < parts.length; p++) {
    if (p > 0) h = fnvByte(h, 0x01);
    for (const ch of String(parts[p])) {
      const c = ch.codePointAt(0);
      if (c < 0x80) h = fnvByte(h, c);
      else if (c < 0x800) {
        h = fnvByte(h, 0xc0 | (c >> 6));
        h = fnvByte(h, 0x80 | (c & 63));
      } else if (c < 0x10000) {
        h = fnvByte(h, 0xe0 | (c >> 12));
        h = fnvByte(h, 0x80 | ((c >> 6) & 63));
        h = fnvByte(h, 0x80 | (c & 63));
      } else {
        h = fnvByte(h, 0xf0 | (c >> 18));
        h = fnvByte(h, 0x80 | ((c >> 12) & 63));
        h = fnvByte(h, 0x80 | ((c >> 6) & 63));
        h = fnvByte(h, 0x80 | (c & 63));
      }
    }
  }
  return h >>> 0;
}

// mulberry32: tiny, fast, full 32-bit period; returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngFor = (...parts) => mulberry32(hash32(...parts));
export const range = (r, a, b) => a + (b - a) * r();
export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

export function shuffle(r, arr) {
  const out = Array.from(arr);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Smooth value noise in [-1, 1]. Lattice values come from an integer hash (no tables, no state), blended with the
// quintic fade so the first and second derivatives are continuous — good for drift, wobble and handheld camera.

const seedInt = (seed) => (typeof seed === 'number' && Number.isFinite(seed) ? seed | 0 : hash32(seed) | 0);

function lattice(ix, iy, s) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}

const fade = (f) => f * f * f * (f * (f * 6 - 15) + 10);

export function noise1(x, seed = 0) {
  if (!Number.isFinite(x)) return 0;
  const s = seedInt(seed);
  const i = Math.floor(x);
  const f = fade(x - i);
  const a = lattice(i, 0, s);
  return a + (lattice(i + 1, 0, s) - a) * f;
}

export function noise2(x, y, seed = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const s = seedInt(seed) ^ 0x5bd1e995;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const a = lattice(ix, iy, s);
  const b = lattice(ix + 1, iy, s);
  const c = lattice(ix, iy + 1, s);
  const d = lattice(ix + 1, iy + 1, s);
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}
