/**
 * Decide what, if anything, should happen to each batch — and refuse anything
 * that breaches a spend cap.
 *
 * This module is pure: it takes a snapshot of the world and returns a plan. It
 * never calls Bee. That keeps the money-deciding logic exhaustively testable
 * without a node, and means a bug here cannot spend anything by itself.
 */

import { amountForDuration, costPlur, plurToBzz } from './math';
import type { Batch, ChainState, Wallet } from './bee';
import type { Config } from './config';

export type Plan =
  | { kind: 'none'; batchId: string; reason: string }
  | { kind: 'topup'; batchId: string; amountPerChunk: bigint; cost: bigint; reason: string }
  | { kind: 'dilute'; batchId: string; newDepth: number; thenTopup: bigint; cost: bigint; reason: string }
  | { kind: 'blocked'; batchId: string; reason: string; wouldHaveCost: bigint };

export interface EvalContext {
  config: Config;
  wallet: Wallet;
  chain: ChainState;
  /** PLUR already committed to top-ups in the trailing 24h, from the ledger. */
  spentLast24h: bigint;
  /** Batch IDs with an action already submitted but not yet observed on chain. */
  inFlight: Set<string>;
  /** Measured block time; falls back to the Gnosis nominal when absent. */
  msPerBlock?: number;
  /** Per-batch policy overrides, by batch id. Absent entries use the globals. */
  policies?: Map<string, BatchPolicy>;
}

/** A cap check, separated so it can be reported even when it passes. */
export interface CapVerdict {
  allowed: boolean;
  reason: string;
}

/**
 * The utilisation at which a batch should be diluted, for a given depth.
 *
 * `utilizationRatio` is not continuous: it is maxCollisions / 2^(depth-16), so
 * a shallow batch has very few possible values. At depth 17 the only values
 * are 0, 0.5 and 1; at depth 18, quarters. A fixed 0.8 threshold is therefore
 * unreachable on those batches until the ratio hits exactly 1.0 — by which
 * point a bucket is already full, and a mutable batch is already discarding
 * its oldest chunks to make room. The guard would fire only after the damage.
 *
 * So the trigger is the configured threshold OR "one slot left in the fullest
 * bucket", whichever comes first. Deep batches keep the 0.8 behaviour, since
 * one slot out of 256 is far tighter than 80%; shallow batches get a threshold
 * they can actually reach in time.
 */
export function diluteTriggerFor(depth: number, configured: number): number {
  const bucketUpperBound = Math.pow(2, Math.max(0, depth - 16));

  // Below this, "one slot left" means almost nothing: at bucketUpperBound 2 a
  // bucket holding a SINGLE chunk already reads 0.5, so a batch with one file
  // in it would dilute immediately, and then again at each new depth — walking
  // 17->22 would halve remaining life five times and pay for five restoring
  // top-ups, all while the batch was essentially empty. Shallow batches
  // therefore trigger only once a bucket is genuinely full.
  //
  // That is reactive rather than predictive, and deliberately so: on a mutable
  // batch a full bucket costs one recycled chunk, which is a far smaller harm
  // than repeatedly halving the life of a batch that had plenty of room.
  // Immutable batches never reach here — they are excluded earlier.
  const MIN_BUCKET_FOR_EARLY_TRIGGER = 8; // depth 19+

  if (bucketUpperBound < MIN_BUCKET_FOR_EARLY_TRIGGER) return 1;

  const oneSlotLeft = (bucketUpperBound - 1) / bucketUpperBound;
  return Math.min(configured, oneSlotLeft);
}

export function checkCaps(cost: bigint, ctx: EvalContext): CapVerdict {
  const { config: c, wallet } = ctx;
  const bzz = (p: bigint) => plurToBzz(p).toFixed(4);

  if (cost <= 0n) return { allowed: false, reason: 'computed cost was zero' };

  if (cost > c.maxTopupPlurPerBatch) {
    return { allowed: false, reason: `costs ${bzz(cost)} xBZZ, over the ${bzz(c.maxTopupPlurPerBatch)} xBZZ per-action cap` };
  }
  if (ctx.spentLast24h + cost > c.maxTopupPlurPerDay) {
    return {
      allowed: false,
      reason: `would bring 24h spend to ${bzz(ctx.spentLast24h + cost)} xBZZ, over the ${bzz(c.maxTopupPlurPerDay)} xBZZ daily cap`,
    };
  }
  if (wallet.bzzBalance - cost < c.minWalletPlur) {
    return {
      allowed: false,
      reason: `would leave ${bzz(wallet.bzzBalance - cost)} xBZZ, under the ${bzz(c.minWalletPlur)} xBZZ floor`,
    };
  }
  if (wallet.nativeTokenBalance < c.minWalletXdaiWei) {
    return {
      allowed: false,
      reason: `xDAI balance ${(Number(wallet.nativeTokenBalance) / 1e18).toFixed(3)} is under the gas floor — the transaction would not land`,
    };
  }
  return { allowed: true, reason: `within caps (${bzz(cost)} xBZZ)` };
}

/** Plan a single batch. */
/**
 * The settings in force for one batch: its own overrides, else the globals.
 *
 * Resolved per evaluation rather than copied onto the batch when it is first
 * seen, so changing a global default moves every batch that has not explicitly
 * opted out — which is what "default" should mean.
 */
export function policyFor(c: Config, o?: BatchPolicy | null) {
  return {
    topupWhenTtlBelowSec: (o?.topupBelowDays ?? c.topupWhenTtlBelowSec / 86_400) * 86_400,
    topupTargetTtlSec: (o?.topupTargetDays ?? c.topupTargetTtlSec / 86_400) * 86_400,
    diluteWhenUtilizationAbove: o?.diluteAbove ?? c.diluteWhenUtilizationAbove,
    maxAutoDiluteDepth: o?.maxDiluteDepth ?? c.maxAutoDiluteDepth,
  };
}

/** Per-batch overrides; any null field inherits the global. */
export interface BatchPolicy {
  topupBelowDays: number | null;
  topupTargetDays: number | null;
  diluteAbove: number | null;
  maxDiluteDepth: number | null;
}

export function evaluateBatch(batch: Batch, ctx: EvalContext): Plan {
  const c = ctx.config;
  const p = policyFor(c, ctx.policies?.get(batch.batchID));
  const id = batch.batchID;

  if (ctx.inFlight.has(id)) {
    return { kind: 'none', batchId: id, reason: 'an action is already in flight for this batch' };
  }
  if (!batch.exists) {
    return { kind: 'none', batchId: id, reason: 'batch no longer exists on chain' };
  }

  // Capacity first: diluting halves the remaining TTL, so it must happen before
  // the top-up that brings TTL back to target — otherwise half of what we just
  // paid for is thrown away.
  // Immutable batches are NOT excluded. That exclusion was based on a belief
  // that Bee refuses to dilute them, which the source disproves: DiluteBatch
  // checks only that depth increases, and the on-chain increaseDepth never
  // reads immutableFlag. Dilution is in fact the only rescue for an immutable
  // batch that has filled a bucket — at that point it refuses ALL uploads, and
  // doubling bucket capacity is what makes it usable again.
  const needsDilute =
    c.diluteEnabled &&
    batch.depth < p.maxAutoDiluteDepth &&
    batch.utilizationRatio >= diluteTriggerFor(batch.depth, p.diluteWhenUtilizationAbove);

  if (needsDilute) {
    const newDepth = batch.depth + 1;
    // After dilution the same amount covers 2x the chunks, halving TTL.
    const ttlAfter = Math.floor(batch.batchTTL / 2);
    const seconds = Math.max(0, p.topupTargetTtlSec - ttlAfter);
    const perChunk = amountForDuration(ctx.chain.currentPrice, seconds, ctx.msPerBlock);
    const cost = costPlur(perChunk, newDepth);
    const verdict = checkCaps(cost, ctx);
    const why =
      `${(batch.utilizationRatio * 100).toFixed(1)}% full (over ${(p.diluteWhenUtilizationAbove * 100).toFixed(0)}%), ` +
      `diluting to depth ${newDepth} then restoring TTL to ${p.topupTargetTtlSec / 86400}d`;
    if (!verdict.allowed) {
      return { kind: 'blocked', batchId: id, reason: `${why} — ${verdict.reason}`, wouldHaveCost: cost };
    }
    return { kind: 'dilute', batchId: id, newDepth, thenTopup: perChunk, cost, reason: why };
  }

  if (batch.batchTTL <= 0) {
    return { kind: 'none', batchId: id, reason: 'batch has already expired — a new batch is needed, not a top-up' };
  }
  if (batch.batchTTL >= p.topupWhenTtlBelowSec) {
    const days = (batch.batchTTL / 86400).toFixed(1);
    return { kind: 'none', batchId: id, reason: `${days}d remaining, above the ${p.topupWhenTtlBelowSec / 86400}d threshold` };
  }

  const seconds = p.topupTargetTtlSec - batch.batchTTL;
  const perChunk = amountForDuration(ctx.chain.currentPrice, seconds, ctx.msPerBlock);
  const cost = costPlur(perChunk, batch.depth);
  const why =
    `${(batch.batchTTL / 86400).toFixed(1)}d remaining, below the ${p.topupWhenTtlBelowSec / 86400}d threshold; ` +
    `extending to ${p.topupTargetTtlSec / 86400}d`;

  const verdict = checkCaps(cost, ctx);
  if (!verdict.allowed) {
    return { kind: 'blocked', batchId: id, reason: `${why} — ${verdict.reason}`, wouldHaveCost: cost };
  }
  return { kind: 'topup', batchId: id, amountPerChunk: perChunk, cost, reason: why };
}

/**
 * Plan every batch, accumulating spend across the run so that two batches
 * needing top-ups in the same poll cannot together breach the daily cap.
 */
export function evaluateAll(batches: Batch[], ctx: EvalContext): Plan[] {
  const plans: Plan[] = [];
  let spent = ctx.spentLast24h;
  for (const batch of batches) {
    const plan = evaluateBatch(batch, { ...ctx, spentLast24h: spent });
    plans.push(plan);
    if (plan.kind === 'topup' || plan.kind === 'dilute') spent += plan.cost;
  }
  return plans;
}

/** Batches we knew about that are absent from the node's current list. */
export function findDisappeared(known: string[], current: Batch[]): string[] {
  const live = new Set(current.map((b) => b.batchID));
  return known.filter((id) => !live.has(id));
}

/** Total ongoing burn across all batches, in PLUR per 30 days. */
export function totalBurnPer30Days(batches: Batch[], price: bigint, msPerBlock?: number): bigint {
  let total = 0n;
  for (const b of batches) {
    if (b.batchTTL > 0) {
      total += costPlur(amountForDuration(price, 30 * 86_400, msPerBlock), b.depth);
    }
  }
  return total;
}

/**
 * Value already paid into the batches but not yet consumed, in PLUR.
 *
 * `amount` is the remaining balance PER CHUNK, so a batch's committed value is
 * that times its chunk count — the same shape as the burn above, which is why
 * the two are directly comparable.
 *
 * This is the only part of the node's holdings that moves continuously: it
 * drains every block, at exactly the burn rate, and that is precisely what
 * batchTTL measures. The wallet by contrast is flat between top-ups. So
 * (wallet + committed) / burn is the one runway figure that genuinely
 * decreases at one second per second rather than sitting still and then
 * stepping down when a top-up fires.
 */
export function totalCommitted(batches: Batch[]): bigint {
  let total = 0n;
  for (const b of batches) {
    if (b.batchTTL > 0) total += costPlur(b.amount, b.depth);
  }
  return total;
}
