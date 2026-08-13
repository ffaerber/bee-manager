/**
 * The auto-dilute trigger has to be reachable BEFORE a bucket fills.
 *
 * utilizationRatio is maxCollisions / 2^(depth-16), so it is quantised, and
 * coarsely so on shallow batches. With a fixed 0.8 threshold a depth-17 batch
 * can only ever read 0, 0.5 or 1 — meaning the guard fires only at 1.0, when a
 * bucket is already full and a mutable batch is already discarding its oldest
 * chunks. Both of the live managed batches are depth 17 and 18, so this was
 * not a corner case.
 */
import { describe, expect, it } from 'bun:test';
import { diluteTriggerFor } from '../src/evaluate';

/** The values utilizationRatio can actually take at a given depth. */
const reachable = (depth: number) => {
  const ub = Math.pow(2, depth - 16);
  return Array.from({ length: ub + 1 }, (_, i) => i / ub);
};

describe('diluteTriggerFor', () => {
  it('is reachable before full at every depth where early warning is possible', () => {
    for (const depth of [19, 20, 22, 24, 28]) {
      const trigger = diluteTriggerFor(depth, 0.8);
      const before = reachable(depth).filter((v) => v < 1 && v >= trigger);
      expect(before.length).toBeGreaterThan(0);
    }
  });

  it('does NOT fire early on very shallow batches', () => {
    // bucketUpperBound 2 and 4. "One slot left" there is 0.5 and 0.75, which a
    // batch holding one or three chunks already reads — it would dilute an
    // essentially empty batch, then again at each new depth, halving life
    // every time. These wait for a genuinely full bucket instead.
    expect(diluteTriggerFor(17, 0.8)).toBe(1);
    expect(diluteTriggerFor(18, 0.8)).toBe(1);
  });

  it('fires with one slot left once buckets are big enough to mean it', () => {
    expect(diluteTriggerFor(19, 0.8)).toBe(0.8);    // 7/8 = 0.875 clears it
    expect(diluteTriggerFor(20, 0.8)).toBe(0.8);
  });

  it('keeps the configured threshold where it is the tighter bound', () => {
    // At depth 24 one slot of 256 is 99.6% — far looser than 80%, so the
    // configured value must win.
    expect(diluteTriggerFor(24, 0.8)).toBe(0.8);
    expect(diluteTriggerFor(28, 0.8)).toBe(0.8);
  });

  it('follows a changed threshold', () => {
    expect(diluteTriggerFor(24, 0.5)).toBe(0.5);
    // Shallow batches ignore it: they wait for a full bucket regardless.
    expect(diluteTriggerFor(17, 0.9)).toBe(1);
  });

  it('never sits above the highest sub-full reading', () => {
    // The trigger itself need not be a reachable value — the comparison is
    // `>=`, so at depth 19 a trigger of 0.8 is met by the reachable 0.875.
    // What must hold is that some reading below 1.0 clears it.
    for (const depth of [19, 20, 22, 24, 28]) {
      const highestBeforeFull = Math.max(...reachable(depth).filter((v) => v < 1));
      expect(diluteTriggerFor(depth, 0.8)).toBeLessThanOrEqual(highestBeforeFull);
    }
  });
});
