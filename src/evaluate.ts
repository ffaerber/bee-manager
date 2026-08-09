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
}

/** A cap check, separated so it can be reported even when it passes. */
export interface CapVerdict {
  allowed: boolean;
  reason: string;
}

export function checkCaps(cost: bigint, ctx: EvalContext): CapVerdict {
  const { config: c, wallet } = ctx;
  const bzz = (p: bigint) => plurToBzz(p).toFixed(4);

  if (cost <= 0n) return { allowed: false, reason: 'computed cost was zero' };

  if (cost > c.maxTopupPlurPerBatch) {
    return { allowed: false, reason: `costs ${bzz(cost)} BZZ, over the ${bzz(c.maxTopupPlurPerBatch)} BZZ per-action cap` };
  }
  if (ctx.spentLast24h + cost > c.maxTopupPlurPerDay) {
    return {
      allowed: false,
      reason: `would bring 24h spend to ${bzz(ctx.spentLast24h + cost)} BZZ, over the ${bzz(c.maxTopupPlurPerDay)} BZZ daily cap`,
    };
  }
  if (wallet.bzzBalance - cost < c.minWalletPlur) {
    return {
      allowed: false,
      reason: `would leave ${bzz(wallet.bzzBalance - cost)} BZZ, under the ${bzz(c.minWalletPlur)} BZZ floor`,
    };
  }
  if (wallet.nativeTokenBalance < c.minWalletXdaiWei) {
    return {
      allowed: false,
      reason: `xDAI balance ${(Number(wallet.nativeTokenBalance) / 1e18).toFixed(3)} is under the gas floor — the transaction would not land`,
    };
  }
  return { allowed: true, reason: `within caps (${bzz(cost)} BZZ)` };
}

/** Plan a single batch. */
export function evaluateBatch(batch: Batch, ctx: EvalContext): Plan {
  const c = ctx.config;
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
  const needsDilute =
    c.diluteEnabled &&
    !batch.immutableFlag &&
    batch.utilizationRatio > c.diluteWhenUtilizationAbove;

  if (needsDilute) {
    const newDepth = batch.depth + 1;
    // After dilution the same amount covers 2x the chunks, halving TTL.
    const ttlAfter = Math.floor(batch.batchTTL / 2);
    const seconds = Math.max(0, c.topupTargetTtlSec - ttlAfter);
    const perChunk = amountForDuration(ctx.chain.currentPrice, seconds, ctx.msPerBlock);
    const cost = costPlur(perChunk, newDepth);
    const verdict = checkCaps(cost, ctx);
    const why =
      `${(batch.utilizationRatio * 100).toFixed(1)}% full (over ${(c.diluteWhenUtilizationAbove * 100).toFixed(0)}%), ` +
      `diluting to depth ${newDepth} then restoring TTL to ${c.topupTargetTtlSec / 86400}d`;
    if (!verdict.allowed) {
      return { kind: 'blocked', batchId: id, reason: `${why} — ${verdict.reason}`, wouldHaveCost: cost };
    }
    return { kind: 'dilute', batchId: id, newDepth, thenTopup: perChunk, cost, reason: why };
  }

  if (batch.batchTTL <= 0) {
    return { kind: 'none', batchId: id, reason: 'batch has already expired — a new batch is needed, not a top-up' };
  }
  if (batch.batchTTL >= c.topupWhenTtlBelowSec) {
    const days = (batch.batchTTL / 86400).toFixed(1);
    return { kind: 'none', batchId: id, reason: `${days}d remaining, above the ${c.topupWhenTtlBelowSec / 86400}d threshold` };
  }

  const seconds = c.topupTargetTtlSec - batch.batchTTL;
  const perChunk = amountForDuration(ctx.chain.currentPrice, seconds, ctx.msPerBlock);
  const cost = costPlur(perChunk, batch.depth);
  const why =
    `${(batch.batchTTL / 86400).toFixed(1)}d remaining, below the ${c.topupWhenTtlBelowSec / 86400}d threshold; ` +
    `extending to ${c.topupTargetTtlSec / 86400}d`;

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
