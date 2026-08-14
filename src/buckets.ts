/**
 * Turning a batch's bucket occupancy into something drawable.
 *
 * The mental model this supports: a postage batch is not one undivided pool of
 * space. It is 2^bucketDepth (65,536) fixed-size bins, and a chunk's address —
 * its content hash — decides which bin its stamp must occupy. You do not get to
 * pick. So a batch can be 0.001% full overall and still refuse an upload,
 * because the one bin that particular chunk hashes into is already full.
 *
 * That is the failure everyone hits and nobody sees coming, and it is why the
 * grid is worth rendering: 65,536 cells laid out 256x256, each shaded by how
 * full its bin is. A healthy batch is a faint even dusting. A batch about to
 * start rejecting writes has hot cells long before the headline number moves.
 *
 * The wire format is a base64 Uint8Array, one byte per bucket, holding fill on
 * a 0-255 scale rather than a raw count. Raw counts would need 16 bits once
 * depth exceeds 24 (bucketUpperBound is 2^(depth-16), so 4,096 at depth 28),
 * and the drawing only ever needs a fraction. 65,536 bytes is 88 KB of base64 —
 * small enough to send whole, so every bucket stays individually visible and
 * nothing is averaged away.
 */

import type { BucketReport } from './bee';

/** Bytes per chunk in Swarm. */
export const CHUNK_BYTES = 4096;

export interface BucketGrid {
  depth: number;
  bucketDepth: number;
  bucketUpperBound: number;
  /** Buckets per side of the square grid: sqrt(2^bucketDepth) = 256. */
  side: number;
  /** Exact totals, computed from raw counts before any scaling. */
  totalChunks: number;
  usedBuckets: number;
  emptyBuckets: number;
  /** Buckets at capacity. On an immutable batch, ANY of these makes the whole
   *  batch refuse uploads; on a mutable batch they silently recycle. */
  fullBuckets: number;
  /** Occupancy of the fullest bucket — what `utilizationRatio` reflects. */
  maxCollisions: number;
  /** totalChunks * 4096. The honest "stored" figure. */
  storedBytes: number;
  /** Capacity if every bucket filled: 2^depth * 4096. */
  capacityBytes: number;
  /** base64 of one byte per bucket, fill scaled to 0-255. */
  grid: string;
}

/**
 * Summarise a bucket report and encode its grid.
 *
 * Every statistic is computed from the raw counts, so the 0-255 scaling used
 * for drawing never feeds a reported number.
 */
export function buildGrid(r: BucketReport): BucketGrid {
  const n = r.buckets.length;
  const side = Math.round(Math.sqrt(n));
  const ub = r.bucketUpperBound || 1;

  let total = 0;
  let used = 0;
  let full = 0;
  let max = 0;
  const bytes = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const c = r.buckets[i] ?? 0;
    total += c;
    if (c > 0) used++;
    if (c >= ub) full++;
    if (c > max) max = c;
    // 0 and 255 are reserved sentinels: 0 means empty, 255 means AT CAPACITY,
    // and everything in between scales across 1..254. Scaling a partial bucket
    // over the full 0..255 would let 4,095 of 4,096 round up to 255 and paint a
    // bucket that still accepts writes with the colour of one that does not.
    // A non-empty bucket must also never round to 0: a single stamp in a
    // depth-28 batch is 1/4096 of a bucket, and rounding it away would draw an
    // empty grid over real data.
    bytes[i] = c === 0 ? 0
      : c >= ub ? 255
      : Math.max(1, Math.min(254, Math.round((c / ub) * 254)));
  }

  return {
    depth: r.depth,
    bucketDepth: r.bucketDepth,
    bucketUpperBound: ub,
    side,
    totalChunks: total,
    usedBuckets: used,
    emptyBuckets: n - used,
    fullBuckets: full,
    maxCollisions: max,
    storedBytes: total * CHUNK_BYTES,
    capacityBytes: Math.pow(2, r.depth) * CHUNK_BYTES,
    grid: Buffer.from(bytes).toString('base64'),
  };
}

/**
 * How close this batch is to refusing writes, and why.
 *
 * Deliberately keyed off the fullest bucket rather than the average, because
 * the fullest bucket is what actually rejects an upload. On an immutable batch
 * one full bin makes the WHOLE batch refuse uploads; on a mutable one it
 * silently drops the oldest chunks there, which is data loss no error surfaces.
 * Dilution is the fix in both cases — it doubles every bucket's capacity, at
 * the cost of half the remaining life.
 */
export function bucketPressure(g: BucketGrid, immutable: boolean): {
  level: 'good' | 'warning' | 'critical';
  message: string;
} {
  const pct = (g.maxCollisions / g.bucketUpperBound) * 100;

  if (g.fullBuckets > 0) {
    return immutable
      ? {
          level: 'critical',
          message: `${g.fullBuckets.toLocaleString()} of ${(1 << g.bucketDepth).toLocaleString()} buckets are full. Being immutable, this batch treats that as 100% utilised and refuses every further upload, not just those landing in a full bucket. Diluting doubles each bucket's capacity and makes it usable again — at the cost of half the remaining life.`,
        }
      : {
          level: 'warning',
          message: `${g.fullBuckets.toLocaleString()} buckets are full. Being mutable, this batch recycles its oldest chunk in a full bucket rather than refusing the write — those chunks are silently unpinned. Dilute to stop losing them.`,
        };
  }
  if (pct >= 80) {
    return {
      level: 'warning',
      message: `The fullest bucket is at ${pct.toFixed(0)}% (${g.maxCollisions}/${g.bucketUpperBound}). Buckets fill unevenly because chunk addresses are effectively random, so the first one fills well before the batch looks full.`,
    };
  }
  return {
    level: 'good',
    message: `The fullest bucket is at ${pct.toFixed(1)}% (${g.maxCollisions}/${g.bucketUpperBound}). Plenty of headroom in every bucket.`,
  };
}
