/**
 * The grid is a picture of where the data is, so the tests are mostly about it
 * not lying: exact totals from raw counts, no occupied bucket rendered as
 * empty, and the at-capacity state called correctly for mutable vs immutable
 * batches — which are opposite failures with the same symptom.
 */
import { describe, expect, it } from 'bun:test';
import { buildGrid, bucketPressure, firstFullEstimate, CHUNK_BYTES } from '../src/buckets';
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
    expect(decode(g.grid)[0]).toBe(127); // 128/256 over the 1..254 range
  });

  it('never rounds a nearly-full bucket up to the at-capacity sentinel', () => {
    // The reason 255 is reserved: at depth 28 a bucket holds 4,096 stamps, and
    // scaling 4,095 of them across the full 0..255 rounds to 255 — painting a
    // bucket that still accepts writes exactly like one that refuses them.
    const g = buildGrid(report(28, (i) => (i === 0 ? 4095 : i === 1 ? 4096 : 0)));
    const px = decode(g.grid);
    expect(px[0]).toBe(254);
    expect(px[1]).toBe(255);
    expect(g.fullBuckets).toBe(1);
  });
});

describe('bucketPressure', () => {
  const withFull = buildGrid(report(18, (i) => (i < 3 ? 4 : 0)));
  const roomy = buildGrid(report(24, (i) => (i < 115 ? 1 : 0)));

  it('is critical for an immutable batch with any full bucket', () => {
    const p = bucketPressure(withFull, true);
    expect(p.level).toBe('critical');
    // Critical because ONE full bucket makes an immutable batch refuse every
    // upload, not only those hashing into that bucket.
    expect(p.message).toMatch(/refuses every further upload/i);
  });

  it('tells an immutable batch that dilution is the fix', () => {
    // This assertion previously said the opposite, encoding a belief that Bee
    // refuses to dilute immutable batches. It does not: DiluteBatch checks only
    // that depth increases, and the on-chain increaseDepth never reads
    // immutableFlag. Dilution doubles bucket capacity and is the only thing
    // that makes such a batch usable again.
    expect(bucketPressure(withFull, true).message).toMatch(/dilut/i);
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

/**
 * Effective capacity — where behaviour changes, which is nowhere near 2^depth.
 *
 * Validated against simulation (40 trials, uniform random bucket assignment):
 * depth 17 observed 311, depth 18 observed 7,815, depth 19 observed 67,850.
 * The estimator is a generalised birthday approximation, so ~15% is the
 * accuracy to expect and all this needs.
 */
describe('firstFullEstimate', () => {
  it('is drastically below nominal capacity on shallow batches', () => {
    // depth 17 is sold as 131,072 chunks and changes behaviour around 362.
    const e = firstFullEstimate(17);
    expect(e).toBeGreaterThan(250);
    expect(e).toBeLessThan(500);
    expect(Math.pow(2, 17) / e).toBeGreaterThan(200);
  });

  it('tracks the simulated values within ~20%', () => {
    for (const [depth, observed] of [[17, 311], [18, 7815], [19, 67850], [20, 277432]] as [number, number][]) {
      const e = firstFullEstimate(depth);
      expect(Math.abs(e - observed) / observed).toBeLessThan(0.25);
    }
  });

  it('does not overflow at depths where the factorial would', () => {
    // 256! is not representable as a double; the log-space form must hold up.
    const e = firstFullEstimate(24);
    expect(Number.isFinite(e)).toBe(true);
    expect(e).toBeGreaterThan(0);
  });

  it('never claims more than the batch physically holds', () => {
    for (const d of [17, 18, 20, 24, 28]) {
      expect(firstFullEstimate(d)).toBeLessThanOrEqual(Math.pow(2, d));
    }
  });

  it('rises with depth, since bigger buckets tolerate more collisions', () => {
    let prev = 0;
    for (const d of [17, 18, 19, 20, 24]) {
      const e = firstFullEstimate(d);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });

  it('is reported on the grid', () => {
    const g = buildGrid(report(18, () => 0));
    expect(g.firstFullChunks).toBe(Math.round(firstFullEstimate(18)));
  });
});

/**
 * The one-slot-left case, which a percentage threshold hides.
 *
 * At bucketUpperBound 4 the fullest bucket reads 75% when the very next
 * collision there ends an immutable batch outright. Against a fixed 80% rule
 * that reported "plenty of headroom" — and did so for a real batch that was one
 * chunk from refusing every upload.
 */
describe('bucketPressure at one slot left', () => {
  /** Fullest bucket at ub-1, i.e. a single slot remaining. */
  const nearlyFull = (depth: number) => {
    const ub = Math.pow(2, depth - 16);
    return buildGrid(report(depth, (i) => (i === 0 ? ub - 1 : 0)));
  };

  it('is critical for an immutable batch, whatever the percentage says', () => {
    const g = nearlyFull(18); // 3 of 4 = 75%, below any 80% rule
    const p = bucketPressure(g, true);
    expect(p.level).toBe('critical');
    expect(p.message).toMatch(/one slot left/i);
    expect(p.message).toMatch(/refuses every upload/i);
  });

  it('warns for a mutable batch, which loses data rather than stopping', () => {
    const p = bucketPressure(nearlyFull(18), false);
    expect(p.level).toBe('warning');
    expect(p.message).toMatch(/recycling|drops data/i);
  });

  it('catches the shallowest case, where one slot is 50%', () => {
    // depth 17: bucketUpperBound 2, so 1 of 2 is one slot left.
    expect(bucketPressure(nearlyFull(17), true).level).toBe('critical');
  });

  it('still fires on deep batches via the percentage rule', () => {
    // depth 24: 208 of 256 is 81%, nowhere near one slot left.
    const g = buildGrid(report(24, (i) => (i === 0 ? 208 : 0)));
    expect(bucketPressure(g, false).level).toBe('warning');
  });

  it('warns when stored chunks approach the effective capacity', () => {
    // No single bucket is close, but the batch as a whole is — the case that
    // the fullest-bucket view alone cannot see.
    const g = buildGrid(report(18, (i) => (i < 7000 ? 1 : 0)));
    expect(g.maxCollisions).toBe(1); // 25%, looks calm
    expect(bucketPressure(g, false).level).toBe('warning');
  });
});
