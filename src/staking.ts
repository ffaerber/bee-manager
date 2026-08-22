/**
 * What the node has staked, and at what height.
 *
 * `height` on the stake and `--reserve-capacity-doubling` on the node are the
 * same number, set in two different places by two different means: one is a
 * contract call, the other a startup flag. Nothing checks that they agree.
 *
 * When they drift, the node stores more than it is collateralised for, and the
 * symptom is a frozen deposit or rounds it never wins — never anything local.
 * `/reservestate` reports the flag happily whatever the chain says. That is the
 * same shape as the six weeks of advertising a WAN address that had rotated
 * away: a fact decided elsewhere, with no local signal when it stops matching.
 *
 * Reading it needs the chain, because Bee's own API does not expose the staked
 * height — `/stake` returns an amount and nothing else.
 *
 * ── Never influences a spending decision. ──
 *
 * Like the price and reachability feeds, this is an external reading, is
 * allowed to be null at any moment, and gates nothing. A node whose stake
 * cannot be read still needs its batches renewed.
 */

import { Contract, JsonRpcProvider } from 'ethers';

/**
 * Swarm's StakeRegistry on Gnosis.
 *
 * Found by following the homelab node's own stake: a 15.00 xBZZ ERC-20
 * transfer to this address, which blockscout names StakeRegistry and whose
 * verified ABI carries `manageStake(bytes32 nonce, uint256 amount, uint8
 * height)` — height being the reserve doubling, which is what makes the two
 * settings one decision.
 */
export const STAKE_REGISTRY = '0xda2a16ee889e7f04980a8d597b48c8d51b9518f4';

/**
 * Only the two views that exist and are needed.
 *
 * Notably absent from the real ABI: any `minimumStakeAmount()`. The minimum is
 * not readable from this contract, so nothing here computes a required stake —
 * asserting one from memory is how a wrong number ends up in a transaction.
 */
const ABI = [
  'function heightOfAddress(address) view returns (uint8)',
  'function nodeEffectiveStake(address) view returns (uint256)',
  /**
   * Reads msg.sender, so it only answers when called AS the node's wallet.
   * Queried with `from` set for that reason — called plainly it returns 0 and
   * would read as "nothing to withdraw" for every node on the network.
   */
  'function withdrawableStake() view returns (uint256)',
];

/** 1 xBZZ in wei. xBZZ has 16 decimals on Gnosis, not 18. */
const PLUR_PER_BZZ = 10n ** 16n;

export interface StakeInfo {
  /** The wallet this describes, so a stale reading cannot be misattributed. */
  address: string;
  /** Effective stake as the contract computes it, in xBZZ. Not the deposit. */
  effectiveBzz: number;
  /** Staked height. Must match the node's reserve-capacity-doubling. */
  height: number;
  /**
   * The part of the deposit not currently committed, and withdrawable now.
   *
   * A residual, not a dial: the contract decides how much of the deposit is
   * effective and this is whatever is left over. It moves on its own —
   * measured 1.4479 one day and shrinking as the effective portion grew — so
   * it is an observation, never a target.
   */
  withdrawableBzz: number;
  fetchedAt: number;
}

export interface StakeOptions {
  enabled?: boolean;
  rpcUrl?: string;
  /** Long: a stake changes when someone deliberately changes it, not on a timer. */
  ttlMs?: number;
  contract?: string;
  /** Injected in tests. */
  providerFactory?: (url: string) => any;
}

export class StakeFeed {
  private cached: StakeInfo | null = null;
  private inflight: Promise<StakeInfo | null> | null = null;

  private readonly enabled: boolean;
  private readonly rpcUrl: string;
  private readonly ttlMs: number;
  private readonly contract: string;
  private readonly providerFactory: (url: string) => any;

  constructor(opts: StakeOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? 'https://rpc.gnosischain.com';
    // Disabled by an empty RPC as well as by the flag: a deployment that has
    // deliberately removed the endpoint should not have one reintroduced here.
    this.enabled = (opts.enabled ?? true) && !!this.rpcUrl;
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
    this.contract = opts.contract ?? STAKE_REGISTRY;
    this.providerFactory = opts.providerFactory ?? ((url: string) => new JsonRpcProvider(url));
  }

  get last(): StakeInfo | null {
    return this.cached;
  }

  /** Never throws. A failed read keeps the previous answer rather than blanking it. */
  async get(address: string, now = Date.now()): Promise<StakeInfo | null> {
    if (!this.enabled || !address) return null;
    const fresh = this.cached
      && this.cached.address.toLowerCase() === address.toLowerCase()
      && now - this.cached.fetchedAt < this.ttlMs;
    if (fresh) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.read(address, now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(address: string, now: number): Promise<StakeInfo | null> {
    try {
      const c = new Contract(this.contract, ABI, this.providerFactory(this.rpcUrl));
      const [height, stake, withdrawable] = await Promise.all([
        c.heightOfAddress(address),
        c.nodeEffectiveStake(address),
        // `from` matters: this one reads msg.sender.
        c.withdrawableStake({ from: address }).catch(() => 0n),
      ]);
      const h = Number(height);
      // A height outside what Bee will accept means we misread the call, not
      // that the chain holds something exotic. Better no reading than a wrong
      // one that then raises a mismatch alert against a real config.
      if (!Number.isInteger(h) || h < 0 || h > 8) return this.cached;
      return (this.cached = {
        address,
        effectiveBzz: Number((BigInt(stake) * 10_000n) / PLUR_PER_BZZ) / 10_000,
        withdrawableBzz: Number((BigInt(withdrawable) * 10_000n) / PLUR_PER_BZZ) / 10_000,
        height: h,
        fetchedAt: now,
      });
    } catch {
      return this.cached;
    }
  }
}

/**
 * Do the staked height and the configured doubling agree?
 *
 * Returns null when either side is unknown — an unread stake is not evidence
 * of a mismatch, and raising one on a failed RPC would be crying wolf on
 * someone else's outage.
 */
export function heightMismatch(
  stake: StakeInfo | null | undefined,
  configuredDoubling: number | null | undefined,
): { staked: number; configured: number } | null {
  if (!stake || configuredDoubling == null) return null;
  if (stake.height === configuredDoubling) return null;
  return { staked: stake.height, configured: configuredDoubling };
}
