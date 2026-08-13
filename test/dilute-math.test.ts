/**
 * Dilution halves remaining life per depth step, and that is the fact the UI
 * exists to make unmissable. These pin the arithmetic the preview shows, so a
 * refactor cannot quietly turn "you will lose half your time" into a wrong
 * reassurance.
 */
import { describe, expect, it } from 'bun:test';
import { capacityBytes } from '../src/math';

/** The preview's TTL projection, as the endpoint computes it. */
const ttlAfter = (ttl: number, steps: number) => Math.floor(ttl / Math.pow(2, steps));

describe('dilution arithmetic', () => {
  it('halves remaining life for one depth step', () => {
    const thirtyDays = 30 * 86_400;
    expect(ttlAfter(thirtyDays, 1)).toBe(15 * 86_400);
  });

  it('quarters it for two steps, not halves twice-announced', () => {
    const ttl = 60 * 86_400;
    expect(ttlAfter(ttl, 2)).toBe(15 * 86_400);
    expect(ttlAfter(ttl, 3)).toBe(7.5 * 86_400);
  });

  it('doubles capacity per step', () => {
    // The trade the UI describes: x2 room for /2 time, per step.
    expect(capacityBytes(19)).toBe(capacityBytes(18) * 2n);
    expect(capacityBytes(20)).toBe(capacityBytes(18) * 4n);
  });

  it('matches the real t4t-v3 shape', () => {
    // depth 18 = 1.07 GB; diluting to 19 gives 2.15 GB and halves 57d to 28d.
    expect(capacityBytes(18)).toBe(1_073_741_824n);
    expect(capacityBytes(19)).toBe(2_147_483_648n);
    expect(ttlAfter(57 * 86_400, 1) / 86_400).toBeCloseTo(28.5, 1);
  });

  it('never reports a negative or fractional-chunk TTL', () => {
    expect(ttlAfter(1, 3)).toBe(0);
    expect(ttlAfter(0, 1)).toBe(0);
  });
});
