/**
 * The map palette reads its colours from CSS custom properties, so a theme edit
 * can change what the canvas draws without any type error. These pin the parser
 * against the way that actually broke.
 */

import { describe, expect, it } from 'bun:test';
import { parseColor, fillColor, type Palette, type RGB } from '../web/src/mapColors';

const FALLBACK: RGB = [23, 24, 33];

describe('parseColor', () => {
  it('parses hex in both lengths', () => {
    expect(parseColor('#256abf', FALLBACK)).toEqual([37, 106, 191]);
    expect(parseColor('#abc', FALLBACK)).toEqual([170, 187, 204]);
    expect(parseColor('  #256ABF  ', FALLBACK)).toEqual([37, 106, 191]);
  });

  it('parses rgb() and rgba(), compositing alpha over the page', () => {
    expect(parseColor('rgb(37, 106, 191)', FALLBACK)).toEqual([37, 106, 191]);
    // Fully opaque rgba is just the colour.
    expect(parseColor('rgba(37, 106, 191, 1)', FALLBACK)).toEqual([37, 106, 191]);
    // Fully transparent collapses to the page background.
    expect(parseColor('rgba(232, 231, 238, 0)', FALLBACK)).toEqual([5, 6, 12]);
  });

  it('does not turn a translucent token into bright green', () => {
    // The exact regression: the galaxy theme set --grid to this, the hex-only
    // parser produced [NaN, 186, NaN], and every empty bucket drew as
    // rgb(0,186,0) — a full-screen green field.
    const got = parseColor('rgba(232, 231, 238, 0.14)', FALLBACK);
    expect(got.every(Number.isFinite)).toBe(true);
    expect(got).not.toEqual([0, 186, 0]);
    // 14% of a near-white over a near-black page: a dark grey.
    expect(got).toEqual([37, 38, 44]);
  });

  it('falls back rather than emitting NaN for anything it cannot read', () => {
    for (const bad of ['', 'transparent', 'var(--nope)', '#12345', 'rgb(a, b, c)', 'color-mix(in oklab, red, blue)']) {
      expect(parseColor(bad, FALLBACK)).toEqual(FALLBACK);
    }
  });
});

describe('fillColor', () => {
  const p: Palette = {
    low: [37, 106, 191], mid: [109, 167, 236], high: [205, 226, 251],
    near: [250, 178, 25], full: [236, 48, 19], empty: [23, 24, 33],
  };

  it('keeps the two reserved states off the ramp', () => {
    expect(fillColor(0, p)).toEqual([23, 24, 33]);
    expect(fillColor(255, p)).toEqual([236, 48, 19]);
    expect(fillColor(204, p)).toEqual([250, 178, 25]);
  });

  it('never emits a NaN channel across the whole byte range', () => {
    for (let f = 0; f <= 255; f++) {
      expect(fillColor(f, p).every((c) => Number.isFinite(c) && c >= 0 && c <= 255)).toBe(true);
    }
  });
});
