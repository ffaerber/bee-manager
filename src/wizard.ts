/**
 * Stamp sizing wizard.
 *
 * This is the part that addresses the root cause. The live node was running a
 * depth-24 batch (68.7 GB, ~104 BZZ/30d) holding 268 MB of data — 0.39% used.
 * Buying a batch means picking a depth and a duration, and the Swarm dashboard
 * shows neither the resulting monthly burn nor how long the wallet survives it.
 * Everything here exists so those two numbers are on screen *before* the spend.
 */

import {
  amountForDuration as amountAtPrice, capacityBytes, chunksForDepth, costPlur,
  plurToBzz, runwaySeconds, CHUNK_BYTES, GNOSIS_MS_PER_BLOCK,
} from './math';
import type { Batch, ChainState } from './bee';

/** Bee rejects depths at or below the bucket depth. */
export const MIN_DEPTH = 17;
/** Above this a single batch is larger than anything this node plausibly serves. */
export const MAX_DEPTH = 32;

/**
 * The chain-wide pricing needed to size any batch: PLUR per chunk per block,
 * plus how long a block takes.
 *
 * `msPerBlock` is measured by the poller from successive `chainstate.block`
 * values rather than assumed — it came out at 4997ms against the live chain,
 * confirming Gnosis's nominal 5s, but measuring means a chain-level change
 * cannot silently mis-size every purchase.
 */
export interface BurnRate {
  price: bigint;
  msPerBlock: number;
  source: 'measured' | 'assumed';
}

export function burnRate(
  _batches: Batch[],
  chain: ChainState,
  msPerBlock?: number,
): BurnRate {
  return {
    price: chain.currentPrice,
    msPerBlock: msPerBlock && msPerBlock > 0 ? msPerBlock : GNOSIS_MS_PER_BLOCK,
    source: msPerBlock && msPerBlock > 0 ? 'measured' : 'assumed',
  };
}

/** PLUR per chunk needed to cover `seconds` at the current price. */
export function amountForDuration(rate: BurnRate, seconds: number): bigint {
  return amountAtPrice(rate.price, seconds, rate.msPerBlock);
}

export interface Quote {
  depth: number;
  days: number;
  amountPerChunk: bigint;
  costPlur: bigint;
  costBzz: number;
  capacityBytes: bigint;
  capacityGb: number;
  /** Ongoing cost to keep this batch alive, once bought. */
  costPer30DaysBzz: number;
  /** Wallet balance after the purchase, in BZZ. */
  walletAfterBzz: number;
  /** Whether the wallet can actually cover this. */
  affordable: boolean;
  /** Days of runway remaining after buying, at the resulting burn rate. */
  runwayDaysAfter: number;
}

/** Price a hypothetical batch. Pure — never touches the node. */
export function quote(
  rate: BurnRate,
  depth: number,
  days: number,
  walletPlur: bigint,
  existingBurnPer30DaysPlur = 0n,
): Quote {
  const seconds = Math.max(1, Math.round(days * 86_400));
  const amountPerChunk = amountForDuration(rate, seconds);
  const total = costPlur(amountPerChunk, depth);
  const per30 = costPlur(amountForDuration(rate, 30 * 86_400), depth);
  const walletAfter = walletPlur - total;
  return {
    depth,
    days,
    amountPerChunk,
    costPlur: total,
    costBzz: plurToBzz(total),
    capacityBytes: capacityBytes(depth),
    capacityGb: Number(capacityBytes(depth)) / 1e9,
    costPer30DaysBzz: plurToBzz(per30),
    walletAfterBzz: plurToBzz(walletAfter),
    affordable: walletAfter >= 0n,
    runwayDaysAfter:
      walletAfter < 0n
        ? 0
        : runwaySeconds(walletAfter, per30 + existingBurnPer30DaysPlur) / 86_400,
  };
}

/** Smallest depth whose capacity covers `bytes`. */
export function depthForBytes(bytes: bigint): number {
  for (let d = MIN_DEPTH; d <= MAX_DEPTH; d++) {
    if (capacityBytes(d) >= bytes) return d;
  }
  return MAX_DEPTH;
}

export interface Recommendation {
  depth: number;
  reason: string;
  headroomFactor: number;
}

/**
 * Recommend a depth for `neededBytes`, with headroom.
 *
 * Deliberately conservative in the *small* direction: depth can only ever be
 * increased later (dilute), and a batch that turns out too small can be grown
 * in seconds, whereas one that is too large cannot be shrunk at all — it can
 * only be abandoned and re-uploaded. Over-buying is the expensive mistake.
 */
export function recommendDepth(neededBytes: bigint, headroomFactor = 4): Recommendation {
  const target = neededBytes * BigInt(Math.max(1, Math.round(headroomFactor)));
  const depth = depthForBytes(target > 0n ? target : BigInt(CHUNK_BYTES));
  const actual = Number(capacityBytes(depth)) / Math.max(1, Number(neededBytes));
  return {
    depth,
    headroomFactor: actual,
    reason:
      neededBytes <= 0n
        ? `Minimum usable depth ${depth} (${(Number(capacityBytes(depth)) / 1e9).toFixed(1)} GB) — no data measured yet.`
        : `Depth ${depth} holds ${(Number(capacityBytes(depth)) / 1e9).toFixed(1)} GB, ` +
          `about ${actual < 100 ? actual.toFixed(0) : Math.round(actual)}x the ${formatBytes(neededBytes)} in use. ` +
          `Depth can be increased later but never reduced, so headroom is cheap to add and impossible to remove.`,
  };
}

/**
 * The full slider surface: a quote at every selectable depth, so the UI can
 * render the cost curve and make an over-sized choice self-evidently expensive.
 */
export function depthLadder(
  rate: BurnRate,
  days: number,
  walletPlur: bigint,
  existingBurnPer30DaysPlur = 0n,
  min = MIN_DEPTH,
  max = MAX_DEPTH,
): Quote[] {
  const out: Quote[] = [];
  for (let d = min; d <= max; d++) out.push(quote(rate, d, days, walletPlur, existingBurnPer30DaysPlur));
  return out;
}

/** Warnings the wizard should surface before a purchase is confirmed. */
export function reviewQuote(q: Quote, neededBytes: bigint, walletPlur: bigint): string[] {
  const warnings: string[] = [];
  if (!q.affordable) {
    warnings.push(`Costs ${q.costBzz.toFixed(2)} xBZZ but the wallet holds ${plurToBzz(walletPlur).toFixed(2)} xBZZ.`);
  }
  if (neededBytes > 0n) {
    const ratio = Number(q.capacityBytes) / Number(neededBytes);
    if (ratio > 50) {
      warnings.push(
        `This batch is ${Math.round(ratio)}x larger than the ${formatBytes(neededBytes)} currently stored. ` +
        `Depth ${q.depth - 2} would cost about ${(q.costBzz / 4).toFixed(2)} xBZZ instead of ${q.costBzz.toFixed(2)} xBZZ.`,
      );
    }
  }
  if (q.affordable && q.runwayDaysAfter < q.days) {
    warnings.push(
      `After this purchase the wallet covers only ${q.runwayDaysAfter.toFixed(0)} more days of top-ups, ` +
      `less than the ${q.days}-day life of the batch itself — it will lapse unless topped up from elsewhere.`,
    );
  }
  if (q.costBzz > 0 && q.costBzz > plurToBzz(walletPlur) * 0.5) {
    warnings.push(`This spends over half the wallet in one transaction.`);
  }
  return warnings;
}

export function formatBytes(bytes: bigint | number): string {
  const n = Number(bytes);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

/** Chunks a given byte count occupies. */
export function chunksForBytes(bytes: bigint): bigint {
  return (bytes + BigInt(CHUNK_BYTES) - 1n) / BigInt(CHUNK_BYTES);
}

export { chunksForDepth };
