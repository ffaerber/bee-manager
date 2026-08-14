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
  /**
   * Chunks that fit before the first bucket fills — the point at which an
   * immutable batch stops accepting and a mutable one starts discarding.
   * Far below `2^depth`; see firstFullEstimate.
   */
  firstFullChunks: number;
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
    firstFullChunks: Math.round(firstFullEstimate(r.depth, r.bucketDepth)),
    grid: Buffer.from(bytes).toString('base64'),
  };
}

/**
 * Roughly how many chunks fit before the FIRST bucket fills.
 *
 * This is the number that matters, and it is nowhere near the nominal 2^depth.
 * Chunk addresses are effectively random, so buckets fill unevenly, and the
 * first one reaching capacity is a generalised birthday problem:
 *
 *     k ~ (bucketUpperBound! * buckets^(bucketUpperBound - 1)) ^ (1/bucketUpperBound)
 *
 * Computed in log space — 256! overflows a double, and depth 24 needs it.
 * Checked against simulation (40 trials): depth 17 predicts 362 against 311
 * observed, depth 18 predicts 9,066 against 7,815, depth 19 predicts 61,675
 * against 67,850. Within ~15%, which is the right precision for "about here".
 *
 * What happens AT that point is where the two batch types diverge completely:
 *
 *   immutable  the whole batch is 100% utilised and refuses every upload. This
 *              is a hard ceiling, and the real capacity of the batch.
 *   mutable    that one bucket starts recycling its oldest chunk. The batch
 *              keeps working and keeps accepting; it is simply lossy from here
 *              on, increasingly so. There is no ceiling — it cannot get full.
 *
 * So for an immutable batch this is a limit, and for a mutable one it is the
 * onset of silent data loss. Same threshold, opposite consequence.
 */
export function firstFullEstimate(depth: number, bucketDepth = 16): number {
  const buckets = Math.pow(2, bucketDepth);
  const ub = Math.pow(2, depth - bucketDepth);
  if (ub <= 1) return buckets;
  // log(ub!) via lgamma, so large bucket bounds do not overflow.
  const lnFactorial = lgamma(ub + 1);
  const ln = (lnFactorial + (ub - 1) * Math.log(buckets)) / ub;
  // Never claim more than the batch physically holds.
  return Math.min(Math.exp(ln), Math.pow(2, depth));
}

/** Lanczos log-gamma. Only needed for log(n!) above. */
function lgamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
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
  // One slot left is the real warning line, and a percentage hides it on
  // shallow batches: at bucketUpperBound 4 the fullest bucket reads 75% when
  // the very next collision there ends an immutable batch outright. A fixed 80%
  // threshold called that "plenty of headroom".
  const oneSlotLeft = g.maxCollisions >= g.bucketUpperBound - 1;

  if (oneSlotLeft) {
    return immutable
      ? {
          level: 'critical',
          message: `The fullest bucket holds ${g.maxCollisions} of ${g.bucketUpperBound} — one slot left. Being immutable, the next chunk whose address lands there takes the WHOLE batch to 100% utilised and it refuses every upload after that. Dilute now, before that happens.`,
        }
      : {
          level: 'warning',
          message: `The fullest bucket holds ${g.maxCollisions} of ${g.bucketUpperBound} — one slot left. The next collision there starts recycling its oldest chunk: the batch keeps accepting, and quietly drops data instead. Dilute to stop that.`,
        };
  }

  if (pct >= 80) {
    return {
      level: 'warning',
      message: `The fullest bucket is at ${pct.toFixed(0)}% (${g.maxCollisions}/${g.bucketUpperBound}). Buckets fill unevenly because chunk addresses are effectively random, so the first one fills well before the batch looks full.`,
    };
  }

  const used = g.totalChunks / g.firstFullChunks;
  if (used >= 0.6) {
    return {
      level: 'warning',
      message: `${g.totalChunks.toLocaleString()} chunks stored against roughly ${g.firstFullChunks.toLocaleString()} before the first bucket fills — about ${(used * 100).toFixed(0)}% of what this batch can take, despite the nominal capacity being far larger.`,
    };
  }

  return {
    level: 'good',
    message: `The fullest bucket is at ${pct.toFixed(1)}% (${g.maxCollisions}/${g.bucketUpperBound}), and ${g.totalChunks.toLocaleString()} chunks are stored against roughly ${g.firstFullChunks.toLocaleString()} before the first bucket fills.`,
  };
}
