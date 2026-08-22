import { describe, expect, it } from 'bun:test';
import { plausibleCoords } from '../src/geo';

describe('telling a coordinate from an absence', () => {
  it('rejects the (0, 0) sentinel', () => {
    expect(plausibleCoords(0, 0)).toBe(false);
  });

  it('accepts real places that touch zero on one axis', () => {
    expect(plausibleCoords(5.7, 0)).toBe(true);      // Tema, Ghana
    expect(plausibleCoords(0, 32.6)).toBe(true);     // on the equator
  });

  it('rejects anything off the globe', () => {
    expect(plausibleCoords(91, 10)).toBe(false);
    expect(plausibleCoords(-91, 10)).toBe(false);
    expect(plausibleCoords(10, 181)).toBe(false);
    expect(plausibleCoords(10, -181)).toBe(false);
  });

  it('rejects non-numbers and non-finite values', () => {
    for (const v of [null, undefined, '50', NaN, Infinity, -Infinity, {}]) {
      expect(plausibleCoords(v, 10)).toBe(false);
      expect(plausibleCoords(10, v)).toBe(false);
    }
  });

  it('accepts the extremes, which are valid', () => {
    expect(plausibleCoords(90, 180)).toBe(true);
    expect(plausibleCoords(-90, -180)).toBe(true);
  });
});
