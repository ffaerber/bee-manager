import { describe, it, expect } from 'bun:test';
import {
  ceilDiv, chunksForDepth, capacityBytes, blocksForSeconds, amountForDuration,
  ttlSecondsForAmount, costPlur, costPer30Days, plurToBzz, bzzToPlur, storedBytes,
  runwaySeconds, PLUR_PER_BZZ, GNOSIS_MS_PER_BLOCK,
} from '../src/math';

// Live values captured from the live Bee node for batch `t4t` on 2026-08-09.
const T4T = { amount: 70_820_179_200n, batchTTL: 2_972_090, depth: 24, utilizationRatio: 0.00390625 };
const PRICE = 70_638n; // chainstate.currentPrice, live
const DAY = 86_400;

describe('ceilDiv', () => {
  it('rounds up, never down — a short top-up buys less time than asked', () => {
    expect(ceilDiv(10n, 3n)).toBe(4n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(ceilDiv(1n, 1_000_000n)).toBe(1n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
  });

  it('rejects a zero divisor rather than throwing a division error mid-spend', () => {
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe('depth arithmetic', () => {
  it('matches the live batch: depth 24 is 16.7M chunks / ~68.7 GB', () => {
    expect(chunksForDepth(24)).toBe(16_777_216n);
    expect(capacityBytes(24)).toBe(68_719_476_736n);
  });

  it('each depth step doubles capacity', () => {
    for (const d of [16, 20, 22, 24]) {
      expect(chunksForDepth(d + 1)).toBe(chunksForDepth(d) * 2n);
    }
  });

  it('rejects implausible depths instead of shifting into nonsense', () => {
    expect(() => chunksForDepth(-1)).toThrow(RangeError);
    expect(() => chunksForDepth(65)).toThrow(RangeError);
    expect(() => chunksForDepth(1.5)).toThrow(RangeError);
  });
});

describe('amountForDuration', () => {
  // Sizing is price x blocks. It cannot come from a batch's own amount/batchTTL:
  // `amount` is the cumulative value ever deposited, not the remainder, so that
  // ratio overstates the rate by 1.687x for the live batch.
  it('sizes 30 days exactly at the live price', () => {
    expect(amountForDuration(PRICE, 30 * DAY)).toBe(36_618_739_200n);
  });

  it('sizes 60 days exactly', () => {
    expect(amountForDuration(PRICE, 60 * DAY)).toBe(73_237_478_400n);
  });

  it('is linear in time', () => {
    expect(amountForDuration(PRICE, 60 * DAY)).toBe(amountForDuration(PRICE, 30 * DAY) * 2n);
  });

  it('uses 17280 blocks per day at the measured 5s block time', () => {
    expect(blocksForSeconds(DAY)).toBe(17_280n);
    expect(blocksForSeconds(DAY, GNOSIS_MS_PER_BLOCK)).toBe(17_280n);
  });

  it('a faster chain needs more blocks for the same wall-clock time', () => {
    expect(blocksForSeconds(DAY, 2500)).toBe(34_560n);
  });

  it('returns zero for non-positive durations rather than a negative spend', () => {
    expect(amountForDuration(PRICE, 0)).toBe(0n);
    expect(amountForDuration(PRICE, -DAY)).toBe(0n);
  });

  it('rejects a zero block time', () => {
    expect(() => blocksForSeconds(DAY, 0)).toThrow(RangeError);
  });
});

describe('ttlSecondsForAmount', () => {
  it('inverts amountForDuration', () => {
    const amount = amountForDuration(PRICE, 30 * DAY);
    expect(ttlSecondsForAmount(amount, PRICE) / DAY).toBeCloseTo(30, 5);
  });

  it('treats an empty balance as expired', () => {
    expect(ttlSecondsForAmount(0n, PRICE)).toBe(0);
  });

  it('rejects a zero price rather than dividing by it', () => {
    expect(() => ttlSecondsForAmount(1n, 0n)).toThrow(RangeError);
  });
});

describe('cost', () => {
  it('a 30-day depth-24 batch costs ~61.44 BZZ', () => {
    const cost = costPer30Days(PRICE, 24);
    expect(cost).toBe(614_360_497_206_067_200n);
    expect(plurToBzz(cost)).toBeCloseTo(61.436, 2);
  });

  it('right-sizing to depth 20 is 16x cheaper — the whole point of the tool', () => {
    expect(costPer30Days(PRICE, 24) / costPer30Days(PRICE, 20)).toBe(16n);
    expect(plurToBzz(costPer30Days(PRICE, 20))).toBeCloseTo(3.84, 2);
  });

  it('depth 17, the floor, is under half a BZZ per month', () => {
    expect(plurToBzz(costPer30Days(PRICE, 17))).toBeCloseTo(0.48, 2);
  });

  it('cost scales with chunk count', () => {
    expect(costPlur(100n, 10)).toBe(100n * 1024n);
  });
});

describe('BZZ <-> PLUR conversion', () => {
  it('round-trips whole and fractional amounts exactly', () => {
    expect(bzzToPlur('1')).toBe(PLUR_PER_BZZ);
    expect(bzzToPlur('0.5')).toBe(PLUR_PER_BZZ / 2n);
    expect(bzzToPlur('204.4839309272645597')).toBe(2_044_839_309_272_645_597n);
    expect(plurToBzz(bzzToPlur('10.25'))).toBeCloseTo(10.25, 10);
  });

  it('does not silently truncate beyond 16 decimals into a wrong number', () => {
    expect(bzzToPlur('0.00000000000000005')).toBe(0n); // below one PLUR
    expect(bzzToPlur('0.0000000000000001')).toBe(1n);
  });

  it('rejects junk rather than coercing it to a spend', () => {
    for (const bad of ['', '-1', 'abc', '1.2.3', '1e5', ' ']) {
      expect(() => bzzToPlur(bad)).toThrow(RangeError);
    }
  });
});

describe('utilization and runway', () => {
  it('reports the live batch as ~268 MB stored in 68.7 GB', () => {
    const stored = storedBytes(T4T.utilizationRatio, T4T.depth);
    expect(Number(stored) / 1e6).toBeCloseTo(268.4, 1);
    expect(Number(stored) / Number(capacityBytes(T4T.depth))).toBeCloseTo(0.0039, 4);
  });

  it('clamps a nonsensical ratio instead of extrapolating past capacity', () => {
    expect(storedBytes(2, 20)).toBe(capacityBytes(20));
    expect(storedBytes(-1, 20)).toBe(0n);
  });

  it('computes the ~100 day runway at depth 24, vs ~1600 at depth 20', () => {
    const wallet = 2_044_839_309_272_645_597n; // 204.48 BZZ, live
    expect(runwaySeconds(wallet, costPer30Days(PRICE, 24)) / DAY).toBeCloseTo(99.9, 0);
    expect(runwaySeconds(wallet, costPer30Days(PRICE, 20)) / DAY).toBeCloseTo(1597.6, 0);
  });

  it('treats a zero burn rate as unlimited rather than dividing by zero', () => {
    expect(runwaySeconds(1n, 0n)).toBe(Infinity);
  });
});
