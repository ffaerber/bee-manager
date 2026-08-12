/**
 * The bucket-map palette, shared by the modal view and the ambient background.
 *
 * One definition on purpose: two copies would drift, and the whole point of the
 * colours is that amber and red mean the same thing wherever they appear.
 *
 * Magnitude takes the sequential blue ramp; the two states that are not degrees
 * take reserved status colours. Amber at >=80% is the same threshold
 * bucketPressure() uses for its written warning, so the picture and the prose
 * agree by construction. Green is deliberately absent — it sits ΔE 4.1 from
 * critical red under deuteranopia, which would merge "barely used" with
 * "refusing writes", the two most opposite states on the map.
 */

export interface Palette {
  low: RGB; mid: RGB; high: RGB;
  near: RGB; full: RGB; empty: RGB;
}
export type RGB = [number, number, number];

/** Encoded fill at which a bucket counts as "nearly full": 80% of the 1..254 range. */
export const NEAR_FULL_BYTE = Math.round(0.8 * 254);

function hex(c: string): RGB {
  const m = c.trim().replace('#', '');
  const v = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Read the ramp from CSS custom properties so both views track the theme. */
export function readPalette(root: Element = document.documentElement): Palette {
  return {
    low: hex(cssVar(root, '--map-low', '#b7d3f6')),
    mid: hex(cssVar(root, '--map-mid', '#3987e5')),
    high: hex(cssVar(root, '--map-high', '#184f95')),
    near: hex(cssVar(root, '--warning', '#fab219')),
    full: hex(cssVar(root, '--critical', '#d03b3b')),
    empty: hex(cssVar(root, '--grid', '#e1e0d9')),
  };
}

/**
 * Colour for one encoded fill byte.
 *
 * The ramp is floored at 0.35 so an occupied bucket is never near-invisible
 * against the empty colour — a bucket holding 1 of 256 stamps is 0.4% full and
 * would otherwise render as the lightest step. Applied here at draw time only;
 * the encoded byte stays a true fill fraction, which is what the hover readout
 * derives its count from.
 */
export function fillColor(f: number, p: Palette): RGB {
  if (f === 0) return p.empty;
  if (f >= 255) return p.full;
  if (f >= NEAR_FULL_BYTE) return p.near;
  const t = 0.35 + 0.65 * (f / NEAR_FULL_BYTE);
  const [a, b, u] = t < 0.5 ? [p.low, p.mid, t / 0.5] : [p.mid, p.high, (t - 0.5) / 0.5];
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

/** base64 -> one byte per bucket. */
export function decodeGrid(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Lay N buckets out to roughly fill a W x H viewport with square cells.
 *
 * The square 256x256 arrangement is only a convention — a bucket's index says
 * nothing about where it "is" — so reflowing to the viewport's aspect loses no
 * meaning, and it beats the alternatives: stretching a square would make cells
 * non-square and misrepresent their size, and cropping would hide buckets,
 * which defeats a display whose job is to show all of them at once.
 */
export function layoutFor(n: number, w: number, h: number): { cols: number; rows: number } {
  if (w <= 0 || h <= 0) return { cols: Math.round(Math.sqrt(n)), rows: Math.round(Math.sqrt(n)) };
  const cell = Math.sqrt((w * h) / n);
  const cols = Math.max(1, Math.round(w / cell));
  return { cols, rows: Math.ceil(n / cols) };
}
