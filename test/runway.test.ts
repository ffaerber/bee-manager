/**
 * The runway the hero counts down.
 *
 * The point of these is one property: the total runway must fall at exactly
 * one second per second. That is what separates a real countdown from an
 * animation — and the wallet-only figure, which the hero used to show, fails
 * it by construction because the wallet does not move between top-ups.
 */

import { describe, expect, it } from 'bun:test';
import { totalBurnPer30Days, totalCommitted } from '../src/evaluate';
import { amountForDuration, costPlur, runwaySeconds } from '../src/math';
import type { Batch } from '../src/bee';

const PRICE = 24_000n;          // PLUR per chunk per block
const MS_PER_BLOCK = 5_000;
const WALLET = 200n * 10_000_000_000_000_000n;   // 200 xBZZ in PLUR

/** A batch holding `seconds` worth of prepaid life at PRICE. */
const batch = (depth: number, seconds: number): Batch => ({
  batchID: `${depth}-${seconds}`, label: 'b', depth, bucketDepth: 16,
  amount: amountForDuration(PRICE, seconds, MS_PER_BLOCK),
  batchTTL: seconds, utilization: 0, utilizationRatio: 0,
  usable: true, immutableFlag: false, exists: true, blockNumber: 1,
} as unknown as Batch);

describe('totalCommitted', () => {
  it('is the per-chunk balance times the chunk count, summed', () => {
    const b = batch(20, 30 * 86_400);
    expect(totalCommitted([b])).toBe(costPlur(b.amount, 20));
  });

  it('ignores batches that have already expired', () => {
    const live = batch(20, 30 * 86_400);
    const dead = { ...batch(24, 0), batchTTL: 0 } as Batch;
    expect(totalCommitted([live, dead])).toBe(totalCommitted([live]));
  });

  it('is zero when there are no batches', () => {
    expect(totalCommitted([])).toBe(0n);
  });
});

describe('the hero runway falls at one second per second', () => {
  // Drain every batch by `seconds` of prepaid life, as blocks passing would.
  const advance = (bs: Batch[], seconds: number): Batch[] =>
    bs.map((b) => ({
      ...b,
      amount: b.amount - amountForDuration(PRICE, seconds, MS_PER_BLOCK),
      batchTTL: b.batchTTL - seconds,
    }) as Batch);

  const totalRunway = (bs: Batch[], wallet = WALLET) =>
    runwaySeconds(wallet + totalCommitted(bs), totalBurnPer30Days(bs, PRICE, MS_PER_BLOCK));

  it('drops by exactly the elapsed time, over whole blocks', () => {
    const bs = [batch(20, 40 * 86_400), batch(22, 12 * 86_400), batch(18, 55 * 86_400)];
    for (const elapsed of [5, 60, 3_600, 86_400, 7 * 86_400]) {
      const drop = totalRunway(bs) - totalRunway(advance(bs, elapsed));
      // Exact but for integer division in the PLUR arithmetic.
      expect(Math.abs(drop - elapsed)).toBeLessThanOrEqual(1);
    }
  });

  it('drains in block-sized steps, not continuously', () => {
    // Value leaves a batch when a block is mined, so the true curve is a
    // staircase with a 5s tread, not a slope. Asking for 1s of drain still
    // costs a whole block. The average rate over any real interval is still
    // exactly 1 s/s, which is what makes the smooth clock honest between
    // polls — but the underlying quantity moves in steps.
    const bs = [batch(20, 40 * 86_400)];
    const oneSecond = totalRunway(bs) - totalRunway(advance(bs, 1));
    expect(oneSecond).toBeGreaterThan(1);
    expect(Math.abs(oneSecond - MS_PER_BLOCK / 1000)).toBeLessThanOrEqual(1);
  });

  it('is what the wallet-only figure fails to do — it does not move at all', () => {
    const bs = [batch(20, 40 * 86_400), batch(22, 12 * 86_400)];
    const walletOnly = (x: Batch[]) =>
      runwaySeconds(WALLET, totalBurnPer30Days(x, PRICE, MS_PER_BLOCK));
    // A day passes and the wallet-only runway is unchanged: nothing left the
    // wallet, so it reports the same number. This is exactly why a ticking
    // clock on it was a fiction, and why reloading reset it.
    expect(walletOnly(advance(bs, 86_400))).toBe(walletOnly(bs));
  });

  it('exceeds the wallet-only figure by the prepaid batch life', () => {
    const bs = [batch(20, 40 * 86_400)];
    const burn = totalBurnPer30Days(bs, PRICE, MS_PER_BLOCK);
    expect(totalRunway(bs) - runwaySeconds(WALLET, burn))
      .toBeCloseTo(runwaySeconds(totalCommitted(bs), burn), -1);
  });

  it('is infinite when nothing is burning', () => {
    expect(totalRunway([])).toBe(Infinity);
  });
});
