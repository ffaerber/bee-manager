/**
 * utilizationRatio is version-dependent in Bee: present on 2.8.1, absent on
 * 2.8.0. Defaulting a missing value to 0 meant "this batch is empty", which
 * silences fullness detection, batch_full and the dilute trigger on precisely
 * the batches that need them.
 */
import { describe, expect, it } from 'bun:test';
import { __ratioOf as ratioOf } from '../src/bee';

describe('utilization ratio', () => {
  it('uses the value Bee sends when present', () => {
    expect(ratioOf({ utilizationRatio: 0.5, utilization: 4, depth: 20, bucketDepth: 16 })).toBe(0.5);
    expect(ratioOf({ utilizationRatio: 0, utilization: 0, depth: 20, bucketDepth: 16 })).toBe(0);
  });

  it('derives it when Bee omits it', () => {
    // The live gateway batch: 215 of 256 -> 83.98%, matching what its bucket
    // report showed. Previously this read as 0%.
    expect(ratioOf({ utilization: 215, depth: 24, bucketDepth: 16 })).toBeCloseTo(215 / 256, 6);
    expect(ratioOf({ utilization: 2, depth: 20, bucketDepth: 16 })).toBeCloseTo(0.125, 6);
    expect(ratioOf({ utilization: 8, depth: 19, bucketDepth: 16 })).toBe(1);
  });

  it('never invents a ratio it cannot compute', () => {
    expect(ratioOf({ depth: 20, bucketDepth: 16 })).toBe(0);
    expect(ratioOf({ utilization: 5, depth: 16, bucketDepth: 16 })).toBe(5);
  });
});
