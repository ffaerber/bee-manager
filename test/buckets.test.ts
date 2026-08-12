/**
 * The grid is a picture of where the data is, so the tests are mostly about it
 * not lying: exact totals from raw counts, no occupied bucket rendered as
 * empty, and the at-capacity state called correctly for mutable vs immutable
 * batches — which are opposite failures with the same symptom.
 */
import { describe, expect, it } from 'bun:test';
import { buildGrid, bucketPressure, CHUNK_BYTES } from '../src/buckets';
import type { BucketReport } from '../src/bee';

/** 65,536 buckets, `fill` applied by index. */
function report(depth: number, fill: (i: number) => number): BucketReport {
  const bucketDepth = 16;
  const n = 1 << bucketDepth;
  return {
    depth,
    bucketDepth,
    bucketUpperBound: Math.pow(2, depth - bucketDepth),
    buckets: Array.from({ length: n }, (_, i) => fill(i)),
  };
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe('buildGrid', () => {
  it('is a 256x256 square', () => {
    const g = buildGrid(report(24, () => 0));
    expect(g.side).toBe(256);
    expect(decode(g.grid).length).toBe(65536);
  });

  it('counts exactly, from raw values', () => {
    // The live t4t shape: 115 chunks, one per bucket, in a depth-24 batch.
    const g = buildGrid(report(24, (i) => (i < 115 ? 1 : 0)));
    expect(g.totalChunks).toBe(115);
    expect(g.usedBuckets).toBe(115);
    expect(g.emptyBuckets).toBe(65536 - 115);
    expect(g.maxCollisions).toBe(1);
    expect(g.fullBuckets).toBe(0);
    expect(g.storedBytes).toBe(115 * CHUNK_BYTES);
    expect(g.capacityBytes).toBe(Math.pow(2, 24) * CHUNK_BYTES);
  });

  it('never renders an occupied bucket as empty', () => {
    // depth 28 => bucketUpperBound 4096, so one chunk is 1/4096 of a bucket.
    // Naive rounding gives 0 and the map would show nothing at all.
    const g = buildGrid(report(28, (i) => (i === 7 ? 1 : 0)));
    const px = decode(g.grid);
    expect(g.bucketUpperBound).toBe(4096);
    expect(px[7]).toBeGreaterThan(0);
    expect(px[6]).toBe(0);
  });

  it('reserves 255 for buckets that are actually full', () => {
    const g = buildGrid(report(18, (i) => (i === 0 ? 4 : i === 1 ? 2 : 0)));
    const px = decode(g.grid);
    expect(g.bucketUpperBound).toBe(4);
    expect(px[0]).toBe(255);       // 4/4 — at capacity
    expect(px[1]).toBeLessThan(255); // 2/4 — must not read as full
    expect(g.fullBuckets).toBe(1);
  });

  it('scales the middle of the range proportionally', () => {
    const g = buildGrid(report(24, (i) => (i === 0 ? 128 : 0)));
    expect(decode(g.grid)[0]).toBe(128); // 128/256 -> 127.5 -> 128
  });
});

describe('bucketPressure', () => {
  const withFull = buildGrid(report(18, (i) => (i < 3 ? 4 : 0)));
  const roomy = buildGrid(report(24, (i) => (i < 115 ? 1 : 0)));

  it('is critical for an immutable batch with any full bucket', () => {
    const p = bucketPressure(withFull, true);
    expect(p.level).toBe('critical');
    // The operationally important part: dilution does not rescue this.
    expect(p.message).toMatch(/dilution cannot fix it|new batch/i);
  });

  it('is a warning for a mutable batch, which loses data instead of failing', () => {
    const p = bucketPressure(withFull, false);
    expect(p.level).toBe('warning');
    expect(p.message).toMatch(/recycles|unpinned/i);
  });

  it('is good when every bucket has headroom', () => {
    expect(bucketPressure(roomy, false).level).toBe('good');
    expect(bucketPressure(roomy, true).level).toBe('good');
  });

  it('warns before anything is actually full', () => {
    // 208/256 = 81%: uneven filling means the first bucket fills long before
    // the batch looks full, so the warning has to lead the failure.
    const near = buildGrid(report(24, (i) => (i === 0 ? 208 : 0)));
    expect(near.fullBuckets).toBe(0);
    expect(bucketPressure(near, false).level).toBe('warning');
  });
});
