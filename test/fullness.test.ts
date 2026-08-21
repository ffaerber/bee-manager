/**
 * Room-left-after-a-write.
 *
 * An upload is the only thing that consumes bucket space, so this is evaluated
 * after a write rather than on the 5-minute poll. The window that closes
 * matters most for immutable batches: between filling and the poller noticing,
 * every upload is refused with nothing explaining why.
 */

import { describe, expect, it } from 'bun:test';
import { fullnessOf, fullnessMessage, diluteTriggerFor } from '../src/evaluate';
import type { Batch } from '../src/bee';

const batch = (depth: number, ratio: number, immutable = false): Batch => ({
  batchID: 'abc123def456', label: 'docs-site', depth, bucketDepth: 16,
  amount: 0n, batchTTL: 86_400, utilization: 0, utilizationRatio: ratio,
  usable: true, immutableFlag: immutable, exists: true, blockNumber: 1,
} as unknown as Batch);

describe('fullnessOf', () => {
  it('is ok with room to spare', () => {
    expect(fullnessOf(batch(24, 0.10), 0.8)).toBe('ok');
    expect(fullnessOf(batch(24, 0.50), 0.8)).toBe('ok');
  });

  it('is full only when the fullest bucket is at capacity', () => {
    expect(fullnessOf(batch(24, 1), 0.8)).toBe('full');
    // 255/256 is one slot short — nearing, not full.
    expect(fullnessOf(batch(24, 255 / 256), 0.8)).toBe('nearing');
  });

  it('uses the same trigger the planner does, so the two cannot disagree', () => {
    for (const d of [17, 18, 19, 20, 24, 28]) {
      const t = diluteTriggerFor(d, 0.8);
      expect(fullnessOf(batch(d, t), 0.8)).not.toBe('ok');
      expect(fullnessOf(batch(d, t - 0.001), 0.8)).toBe('ok');
    }
  });

  it('treats a shallow batch as full only at 1.0', () => {
    // depth 17 quantises to 0, 0.5, 1 — 0.5 must not read as full.
    expect(fullnessOf(batch(17, 0.5), 0.8)).toBe('ok');
    expect(fullnessOf(batch(17, 1), 0.8)).toBe('full');
  });
});

describe('fullnessMessage', () => {
  it('says nothing when there is room', () => {
    expect(fullnessMessage(batch(24, 0.1), 'ok')).toBeNull();
  });

  it('distinguishes the two ways a full batch hurts', () => {
    const immutable = fullnessMessage(batch(24, 1, true), 'full')!;
    const mutable = fullnessMessage(batch(24, 1, false), 'full')!;
    expect(immutable).toContain('refuse every further upload');
    // Matches the stem, not one inflection: the claim is that the message is
    // ABOUT recycling, not that it uses a particular word form.
    expect(mutable).toMatch(/recycl/);
    // Never the wrong one — these are opposite failures.
    expect(immutable).not.toMatch(/recycl/);
    expect(mutable).not.toContain('refuse every further upload');
  });

  /**
   * A mutable batch at capacity is doing what it was bought to do, and the
   * usual cause here is a repeated identical chunk — same content, same
   * address, same bucket — so what recycles is a duplicate.
   *
   * t4t-v3 was diluted 18 -> 19 -> 20 chasing exactly that, doubling its
   * monthly cost each step for a bucket that refilled immediately. The message
   * must not send the next person down the same path.
   */
  it('does not prescribe dilution to a mutable batch', () => {
    const mutable = fullnessMessage(batch(24, 1, false), 'full')!;
    expect(mutable).not.toMatch(/Dilute it/);
    // It should point at the evidence that decides whether anything is lost.
    expect(mutable).toMatch(/bucket map/);
  });

  it('still tells an immutable batch to dilute, because that does fix it', () => {
    expect(fullnessMessage(batch(24, 1, true), 'full')).toMatch(/Dilute it/);
  });

  it('names the batch so an alert is actionable', () => {
    expect(fullnessMessage(batch(24, 1, true), 'full')).toContain('docs-site');
  });
});
