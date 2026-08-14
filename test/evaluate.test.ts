import { describe, it, expect } from 'bun:test';
import { evaluateBatch, evaluateAll, checkCaps, findDisappeared, totalBurnPer30Days, type EvalContext } from '../src/evaluate';
import { loadConfig } from '../src/config';
import { bzzToPlur } from '../src/math';
import type { Batch, ChainState, Wallet } from '../src/bee';

const DAY = 86_400;

const baseBatch: Batch = {
  batchID: 'aa'.repeat(32), utilization: 1, utilizationRatio: 0.0039, usable: true,
  label: 't4t', depth: 24, amount: 70_820_179_200n, bucketDepth: 16,
  blockNumber: 47_214_002, immutableFlag: false, exists: true, batchTTL: 2_972_090,
};
const chain: ChainState = {
  chainTip: 47_635_695, block: 47_635_690, totalAmount: 743_218_851_684n,
  currentPrice: 70_638n, minimumValidityBlocks: 17_280,
};

/**
 * A batch with `days` of TTL left, at the *same* burn rate as the live one.
 * `amount` and `batchTTL` are not independent — amount/TTL is the chain-wide
 * PLUR-per-chunk-per-second rate, so moving one without the other describes a
 * batch that cannot exist and silently changes every cost in the test.
 */
function withTTL(days: number, over: Partial<Batch> = {}): Batch {
  const ttl = Math.round(days * DAY);
  const amount = (baseBatch.amount * BigInt(ttl)) / BigInt(baseBatch.batchTTL);
  return { ...baseBatch, batchTTL: ttl, amount, ...over };
}
const wallet: Wallet = {
  bzzBalance: bzzToPlur('204.48'), nativeTokenBalance: 4_707_630_109_881_458_130n,
  chainID: 100, walletAddress: '0x0', chequebookContractAddress: '0x0',
};

/** Caps generous enough that only the rule under test can block. */
function ctx(over: Partial<EvalContext> = {}, envOver: Record<string, string> = {}): EvalContext {
  return {
    config: loadConfig({
      MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '1000',
      MIN_WALLET_BZZ: '0', MIN_WALLET_XDAI: '0', ...envOver,
    } as any),
    wallet, chain, spentLast24h: 0n, inFlight: new Set(), ...over,
  };
}

describe('TTL threshold', () => {
  it('leaves a healthy batch alone', () => {
    const p = evaluateBatch(baseBatch, ctx());
    expect(p.kind).toBe('none');
    expect(p.reason).toContain('above the 14d threshold');
  });

  it('tops up once TTL falls below the threshold', () => {
    const p = evaluateBatch(withTTL(10), ctx());
    expect(p.kind).toBe('topup');
    if (p.kind !== 'topup') throw new Error();
    expect(p.amountPerChunk).toBeGreaterThan(0n);
    expect(p.reason).toContain('extending to 60d');
  });

  it('tops up to the target, not merely past the threshold', () => {
    const batch = withTTL(10);
    const p = evaluateBatch(batch, ctx());
    if (p.kind !== 'topup') throw new Error();
    // 50 more days on top of the 10 remaining, at price x 17280 per day.
    expect(p.amountPerChunk).toBe(70_638n * 17_280n * 50n);
  });

  it('does not try to top up an already-expired batch', () => {
    const p = evaluateBatch({ ...baseBatch, batchTTL: 0 }, ctx());
    expect(p.kind).toBe('none');
    expect(p.reason).toContain('already expired');
  });

  it('skips a batch with an action in flight', () => {
    const p = evaluateBatch(withTTL(1), ctx({ inFlight: new Set([baseBatch.batchID]) }));
    expect(p.kind).toBe('none');
    expect(p.reason).toContain('in flight');
  });
});

describe('dilution', () => {
  // Depth 20: under the automatic ceiling, so these exercise the dilution
  // rules rather than the ceiling. The live t4t at depth 24 is deliberately
  // above it — see the ceiling tests below.
  const full = withTTL(40, { utilizationRatio: 0.95, depth: 20 });
  // Diluting and restoring TTL is a large spend against the live wallet — a
  // real affordability block, not a dilution bug. Fund these cases.
  const funded = { wallet: { ...wallet, bzzBalance: bzzToPlur('5000') } };

  it('dilutes a full mutable batch, and orders dilute before top-up', () => {
    const p = evaluateBatch(full, ctx(funded));
    expect(p.kind).toBe('dilute');
    if (p.kind !== 'dilute') throw new Error();
    expect(p.newDepth).toBe(21);
    expect(p.thenTopup).toBeGreaterThan(0n);
    expect(p.reason).toContain('95.0% full');
  });

  it('dilutes an immutable batch too — that is the only rescue for one', () => {
    // This asserted the opposite, on the belief that Bee refuses to dilute
    // immutable batches. Verified against the source: DiluteBatch checks only
    // that depth increases, and PostageStamp.increaseDepth never reads
    // immutableFlag. A full bucket makes an immutable batch refuse ALL
    // uploads, so dilution is the difference between dead and usable.
    const p = evaluateBatch({ ...full, immutableFlag: true }, ctx(funded));
    expect(p.kind).toBe('dilute');
  });

  it('honours DILUTE_ENABLED=false', () => {
    const p = evaluateBatch(full, ctx(funded, { DILUTE_ENABLED: 'false' }));
    expect(p.kind).not.toBe('dilute');
  });

  it('takes capacity pressure ahead of a TTL top-up', () => {
    const p = evaluateBatch(withTTL(2, { utilizationRatio: 0.95, depth: 20 }), ctx(funded));
    expect(p.kind).toBe('dilute'); // not 'topup', despite TTL also being low
  });

  it('fires before a bucket is full once buckets are big enough', () => {
    // Depth 19: bucketUpperBound 8, so 0.875 is one slot from full and clears
    // the 0.8 threshold — genuine early warning.
    const p = evaluateBatch(withTTL(40, { utilizationRatio: 0.875, depth: 19 }), ctx(funded));
    expect(p.kind).toBe('dilute');
  });

  it('leaves a barely-used shallow batch alone', () => {
    // The case that nearly fired in production: depth 17, one chunk in the
    // fullest bucket, reads 0.5 because bucketUpperBound is 2. Diluting here
    // would halve the life of a batch with almost nothing in it.
    const p = evaluateBatch(withTTL(40, { utilizationRatio: 0.5, depth: 17 }), ctx(funded));
    expect(p.kind).not.toBe('dilute');
  });

  it('still dilutes a shallow batch once a bucket is actually full', () => {
    const p = evaluateBatch(withTTL(40, { utilizationRatio: 1, depth: 17 }), ctx(funded));
    expect(p.kind).toBe('dilute');
  });

  describe('automatic depth ceiling', () => {
    it('refuses to dilute past MAX_AUTO_DILUTE_DEPTH', () => {
      // The live t4t shape. Cost scales with 2^depth, so an automatic
      // dilution here would permanently double an already-large burn —
      // exactly the decision that should stay human.
      const p = evaluateBatch(withTTL(40, { utilizationRatio: 0.95, depth: 24 }), ctx(funded));
      expect(p.kind).not.toBe('dilute');
    });

    it('still dilutes just below the ceiling', () => {
      const p = evaluateBatch(withTTL(40, { utilizationRatio: 0.95, depth: 21 }), ctx(funded));
      expect(p.kind).toBe('dilute');
    });

    it('follows a raised ceiling', () => {
      const p = evaluateBatch(withTTL(40, { utilizationRatio: 0.95, depth: 24 }),
        ctx(funded, { MAX_AUTO_DILUTE_DEPTH: '26' }));
      expect(p.kind).toBe('dilute');
    });
  });
});

describe('spend caps', () => {
  const low = withTTL(10);

  it('blocks a single action over the per-action cap', () => {
    const p = evaluateBatch(low, ctx({}, { MAX_TOPUP_BZZ_PER_BATCH: '1', MAX_TOPUP_BZZ_PER_DAY: '1000' }));
    expect(p.kind).toBe('blocked');
    expect(p.reason).toContain('per-action cap');
  });

  it('blocks once the rolling daily budget is exhausted', () => {
    const p = evaluateBatch(low, ctx({ spentLast24h: bzzToPlur('999') }, {
      MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '1000',
    }));
    expect(p.kind).toBe('blocked');
    expect(p.reason).toContain('daily cap');
  });

  it('blocks a spend that would breach the wallet floor', () => {
    const p = evaluateBatch(low, ctx({}, { MIN_WALLET_BZZ: '200' }));
    expect(p.kind).toBe('blocked');
    expect(p.reason).toContain('floor');
  });

  it('blocks when xDAI is too low for the transaction to land', () => {
    const p = evaluateBatch(low, ctx({ wallet: { ...wallet, nativeTokenBalance: 1n } }, { MIN_WALLET_XDAI: '0.5' }));
    expect(p.kind).toBe('blocked');
    expect(p.reason).toContain('gas floor');
  });

  it('reports what it would have cost, so a block is actionable', () => {
    const p = evaluateBatch(low, ctx({}, { MAX_TOPUP_BZZ_PER_BATCH: '1', MAX_TOPUP_BZZ_PER_DAY: '1000' }));
    if (p.kind !== 'blocked') throw new Error();
    expect(p.wouldHaveCost).toBeGreaterThan(0n);
  });

  it('checkCaps passes a modest spend', () => {
    expect(checkCaps(bzzToPlur('1'), ctx()).allowed).toBe(true);
  });

  it('rejects a zero-cost action rather than submitting a no-op transaction', () => {
    expect(checkCaps(0n, ctx()).allowed).toBe(false);
  });
});

describe('evaluateAll', () => {
  it('accumulates spend across batches so two top-ups cannot jointly breach the daily cap', () => {
    const a = withTTL(10, { batchID: 'a'.repeat(64) });
    const b = withTTL(10, { batchID: 'b'.repeat(64) });
    // Each 10d->60d extension costs ~102.4 BZZ; a 150 BZZ daily cap admits exactly one.
    const plans = evaluateAll([a, b], ctx({}, {
      MAX_TOPUP_BZZ_PER_BATCH: '150', MAX_TOPUP_BZZ_PER_DAY: '150', MIN_WALLET_BZZ: '0',
    }));
    expect(plans[0].kind).toBe('topup');
    expect(plans[1].kind).toBe('blocked');
    expect(plans[1].reason).toContain('daily cap');
  });
});

describe('disappearance detection', () => {
  it('flags a known batch that has vanished from the node', () => {
    expect(findDisappeared(['a', 'b'], [{ ...baseBatch, batchID: 'a' }])).toEqual(['b']);
  });

  it('reports nothing when all known batches are present', () => {
    expect(findDisappeared(['a'], [{ ...baseBatch, batchID: 'a' }])).toEqual([]);
  });
});

describe('burn rate', () => {
  it('is ~61.4 BZZ/30d for a live depth-24 batch', () => {
    expect(Number(totalBurnPer30Days([baseBatch], chain.currentPrice)) / 1e16).toBeCloseTo(61.44, 1);
  });

  it('ignores expired batches', () => {
    expect(totalBurnPer30Days([{ ...baseBatch, batchTTL: 0 }], chain.currentPrice)).toBe(0n);
  });
});

describe('config validation', () => {
  it('defaults to not spending anything', () => {
    const c = loadConfig({} as any);
    expect(c.autoTopupEnabled).toBe(false);
    expect(c.dryRun).toBe(true);
  });

  it('rejects a target TTL below the trigger threshold', () => {
    expect(() => loadConfig({ TOPUP_TARGET_TTL_DAYS: '5', TOPUP_WHEN_TTL_BELOW_DAYS: '14' } as any)).toThrow(/must exceed/);
  });

  it('rejects a per-action cap above the daily cap', () => {
    expect(() => loadConfig({ MAX_TOPUP_BZZ_PER_BATCH: '100', MAX_TOPUP_BZZ_PER_DAY: '10' } as any)).toThrow(/never be respected/);
  });

  it('rejects a malformed BZZ cap instead of coercing it', () => {
    expect(() => loadConfig({ MAX_TOPUP_BZZ_PER_BATCH: 'lots' } as any)).toThrow(/BZZ amount/);
  });
});
