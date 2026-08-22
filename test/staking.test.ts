/**
 * Staked height vs configured reserve doubling.
 *
 * They are one setting kept in two places — `manageStake(nonce, amount,
 * height)` on-chain, `--reserve-capacity-doubling` in the node's config — and
 * nothing compares them. Out of step, the node stores more than its stake
 * covers and keeps running normally: no local symptom, just rounds it cannot
 * win or a frozen deposit.
 *
 * Same shape as advertising a WAN address that had rotated away six weeks
 * earlier: a fact decided elsewhere, with nothing local to notice the drift.
 */
import { describe, it, expect } from 'bun:test';
import { StakeFeed, heightMismatch, STAKE_REGISTRY } from '../src/staking';

const ADDR = '0x56de993e7abbc14b7b1ecdcc3272a07900129a92';

const feed = (height: any, stake: bigint, opts: any = {}) => {
  let calls = 0;
  const f = new StakeFeed({
    ttlMs: 60_000, ...opts,
    providerFactory: () => {
      calls++;
      return {};
    },
  });
  // ethers Contract is constructed against the stub provider; intercept by
  // replacing the read path rather than mocking the whole of ethers.
  (f as any).read = async (address: string, now: number) => {
    calls++;
    const h = Number(height);
    if (!Number.isInteger(h) || h < 0 || h > 8) return (f as any).cached;
    return ((f as any).cached = {
      address, height: h,
      effectiveBzz: Number((stake * 10_000n) / 10n ** 16n) / 10_000,
      withdrawableBzz: 0,
      fetchedAt: now,
    });
  };
  return { f, calls: () => calls };
};

describe('the mismatch rule', () => {
  const stake = (height: number) => ({ address: ADDR, effectiveBzz: 13.4789, withdrawableBzz: 1.4479, height, fetchedAt: 1 });

  it('is silent when the two agree', () => {
    expect(heightMismatch(stake(0), 0)).toBeNull();
    expect(heightMismatch(stake(1), 1)).toBeNull();
  });

  it('reports both numbers when they differ', () => {
    expect(heightMismatch(stake(0), 1)).toEqual({ staked: 0, configured: 1 });
    // The dangerous direction: staked for more than configured wastes capital;
    // configured for more than staked stores what nothing collateralises.
    expect(heightMismatch(stake(1), 0)).toEqual({ staked: 1, configured: 0 });
  });

  /**
   * An unread stake is not evidence of a mismatch. Raising one on a failed RPC
   * would be crying wolf on someone else's outage — the same mistake already
   * made once with the reachability observer's circuit breaker.
   */
  it('stays silent when either side is unknown', () => {
    expect(heightMismatch(null, 1)).toBeNull();
    expect(heightMismatch(undefined, 0)).toBeNull();
    expect(heightMismatch(stake(0), null)).toBeNull();
    expect(heightMismatch(stake(0), undefined)).toBeNull();
  });
});

describe('reading the stake', () => {
  it('reports height and effective stake', async () => {
    const { f } = feed(0, 134_789_000_000_000_000n);
    const s = await f.get(ADDR);
    expect(s!.height).toBe(0);
    // xBZZ has 16 decimals, not 18 — getting this wrong misreports by 100x.
    expect(s!.effectiveBzz).toBeCloseTo(13.4789, 4);
  });

  it('rejects a height Bee could never run, rather than alerting on it', async () => {
    // Out of range means the call was misread, not that the chain holds
    // something exotic. A bad value here would raise a mismatch against a
    // perfectly good config.
    const { f } = feed(99, 0n);
    expect(await f.get(ADDR)).toBeNull();
  });

  it('caches, because a stake changes when someone changes it', async () => {
    const { f, calls } = feed(0, 10n ** 17n);
    await f.get(ADDR, 1_000);
    await f.get(ADDR, 2_000);
    expect(calls()).toBe(1);
  });

  it('refetches for a different wallet rather than reusing the cache', async () => {
    const { f, calls } = feed(0, 10n ** 17n);
    await f.get(ADDR, 1_000);
    await f.get('0x195ef28b049a4686168ad7a380ba965bf0b7d832', 1_500);
    expect(calls()).toBe(2);
  });

  it('returns null when disabled, without touching the chain', async () => {
    const { f, calls } = feed(0, 10n ** 17n, { enabled: false });
    expect(await f.get(ADDR)).toBeNull();
    expect(calls()).toBe(0);
  });

  it('is disabled by an empty RPC url, not silently defaulted', async () => {
    const { f } = feed(0, 10n ** 17n, { rpcUrl: '' });
    expect(await f.get(ADDR)).toBeNull();
  });
});

describe('the contract it reads', () => {
  it('is the StakeRegistry the nodes actually staked to', () => {
    // Found by following a 15.00 xBZZ transfer from the homelab bee wallet.
    expect(STAKE_REGISTRY.toLowerCase()).toBe('0xda2a16ee889e7f04980a8d597b48c8d51b9518f4');
  });
});
