import { describe, it, expect } from 'bun:test';
import {
  burnRate, amountForDuration, quote, depthForBytes, recommendDepth, depthLadder,
  reviewQuote, chunksForBytes, formatBytes, MIN_DEPTH,
} from '../src/wizard';
import { capacityBytes, storedBytes, plurToBzz } from '../src/math';
import type { Batch, ChainState } from '../src/bee';

// Live state from the live Bee node, 2026-08-09.
const t4t: Batch = {
  batchID: '49aebf397afc8b83306c15d459bf08ecfef9fb8304bcd6e01d4cbdd2fba7b3b2',
  utilization: 1, utilizationRatio: 0.00390625, usable: true, label: 't4t',
  depth: 24, amount: 70_820_179_200n, bucketDepth: 16, blockNumber: 47_214_002,
  immutableFlag: false, exists: true, batchTTL: 2_972_090,
};
const chain: ChainState = {
  chainTip: 47_635_695, block: 47_635_690, totalAmount: 743_218_851_684n,
  currentPrice: 70_638n, minimumValidityBlocks: 17_280,
};
const WALLET = 2_044_839_309_272_645_597n; // 204.48 BZZ
const STORED = storedBytes(t4t.utilizationRatio, t4t.depth); // ~268 MB

describe('burnRate', () => {
  it('uses the chain price with a measured block time', () => {
    const r = burnRate([t4t], chain, 4997);
    expect(r.source).toBe('measured');
    expect(r.price).toBe(chain.currentPrice);
    expect(r.msPerBlock).toBe(4997);
  });

  it('falls back to the Gnosis nominal when no measurement is available', () => {
    const r = burnRate([t4t], chain);
    expect(r.source).toBe('assumed');
    expect(r.msPerBlock).toBe(5000);
  });

  it('does not depend on any batch — amount/batchTTL is not the burn rate', () => {
    expect(burnRate([], chain, 5000)).toEqual(burnRate([t4t], chain, 5000));
  });

  it('sizes a 30-day extension at price x 17280 x 30', () => {
    expect(amountForDuration(burnRate([t4t], chain, 5000), 30 * 86_400)).toBe(36_618_739_200n);
  });
});

describe('quote', () => {
  const rate = burnRate([t4t], chain, 5000);

  it('prices a 30-day depth-24 batch at ~61.4 BZZ', () => {
    const q = quote(rate, 24, 30, WALLET);
    expect(q.costBzz).toBeCloseTo(61.44, 1);
    expect(q.capacityGb).toBeCloseTo(68.7, 1);
    expect(q.affordable).toBe(true);
  });

  it('prices the same duration at depth 20 for 1/16th the cost', () => {
    const at24 = quote(rate, 24, 30, WALLET);
    const at20 = quote(rate, 20, 30, WALLET);
    expect(at20.costBzz).toBeCloseTo(at24.costBzz / 16, 2);
    expect(at20.costBzz).toBeCloseTo(3.84, 1);
  });

  it('reports runway after purchase — the number that exposes the real problem', () => {
    const q = quote(rate, 24, 30, WALLET);
    // ~143 BZZ left after a 61 BZZ purchase, burning ~61/30d.
    expect(q.runwayDaysAfter).toBeGreaterThan(50);
    expect(q.runwayDaysAfter).toBeLessThan(100);
    // Same money at depth 20 lasts far longer.
    expect(quote(rate, 20, 30, WALLET).runwayDaysAfter).toBeGreaterThan(1000);
  });

  it('marks an unaffordable batch rather than letting it be submitted', () => {
    const q = quote(rate, 30, 365, WALLET);
    expect(q.affordable).toBe(false);
    expect(q.runwayDaysAfter).toBe(0);
  });

  it('cost scales linearly with duration', () => {
    const a = quote(rate, 20, 30, WALLET).costPlur;
    const b = quote(rate, 20, 60, WALLET).costPlur;
    expect(Number(b) / Number(a)).toBeCloseTo(2, 3);
  });
});

describe('depth selection', () => {
  it('picks the smallest depth that fits', () => {
    expect(capacityBytes(depthForBytes(1n))).toBeGreaterThanOrEqual(1n);
    expect(depthForBytes(capacityBytes(20))).toBe(20);
    expect(depthForBytes(capacityBytes(20) + 1n)).toBe(21);
  });

  it('never returns a depth Bee would reject', () => {
    expect(depthForBytes(0n)).toBeGreaterThanOrEqual(MIN_DEPTH);
    expect(recommendDepth(0n).depth).toBeGreaterThan(16);
  });

  it('recommends ~1 GB for the 268 MB actually stored, not 68.7 GB', () => {
    const rec = recommendDepth(STORED, 4);
    expect(rec.depth).toBe(18);
    expect(Number(capacityBytes(rec.depth)) / 1e9).toBeCloseTo(1.07, 2);
    expect(rec.reason).toContain('never reduced');
  });

  it('scales the recommendation with the headroom asked for', () => {
    expect(recommendDepth(STORED, 1).depth).toBeLessThan(recommendDepth(STORED, 16).depth);
  });
});

describe('depthLadder', () => {
  it('produces one quote per selectable depth for the slider', () => {
    const ladder = depthLadder(burnRate([t4t], chain, 5000), 30, WALLET, 0n, 17, 24);
    expect(ladder).toHaveLength(8);
    expect(ladder[0].depth).toBe(17);
    expect(ladder.at(-1)!.depth).toBe(24);
  });

  it('cost doubles with each depth step', () => {
    const ladder = depthLadder(burnRate([t4t], chain, 5000), 30, WALLET, 0n, 18, 22);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].costPlur).toBe(ladder[i - 1].costPlur * 2n);
    }
  });
});

describe('reviewQuote warnings', () => {
  const rate = burnRate([t4t], chain, 5000);

  it('flags the exact mistake that caused this project to exist', () => {
    const w = reviewQuote(quote(rate, 24, 30, WALLET), STORED, WALLET);
    expect(w.join(' ')).toMatch(/larger than the .* stored/);
  });

  it('stays quiet for a sensibly sized batch', () => {
    const w = reviewQuote(quote(rate, 19, 30, WALLET), STORED, WALLET);
    expect(w).toHaveLength(0);
  });

  it('flags an unaffordable purchase', () => {
    const w = reviewQuote(quote(rate, 30, 365, WALLET), STORED, WALLET);
    expect(w.join(' ')).toContain('wallet holds');
  });

  it('flags spending over half the wallet at once', () => {
    const w = reviewQuote(quote(rate, 24, 60, WALLET), STORED, WALLET);
    expect(w.join(' ')).toContain('half the wallet');
  });
});

describe('byte helpers', () => {
  it('rounds partial chunks up', () => {
    expect(chunksForBytes(1n)).toBe(1n);
    expect(chunksForBytes(4096n)).toBe(1n);
    expect(chunksForBytes(4097n)).toBe(2n);
  });

  it('formats readably', () => {
    expect(formatBytes(268_435_456n)).toBe('268.4 MB');
    expect(formatBytes(68_719_476_736n)).toBe('68.72 GB');
  });
});
