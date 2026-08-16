/**
 * Money math for postage batches. Everything here is bigint.
 *
 * PLUR is the base unit; 1 BZZ = 1e16 PLUR (16 decimals on Gnosis). A batch's
 * `amount` is PLUR *per chunk*, so the total value locked in a batch is
 * `amount × 2^depth` — at depth 24 that is a 16.7M multiplier, which is why a
 * float anywhere in this file would be a bug that spends real money.
 */

/** 1 BZZ in PLUR. */
export const PLUR_PER_BZZ = 10_000_000_000_000_000n;

/** Bytes per chunk in Swarm. */
export const CHUNK_BYTES = 4096;

/** ceil(a / b) for non-negative bigints. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be positive');
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/** Number of chunks a batch of this depth covers. */
export function chunksForDepth(depth: number): bigint {
  if (!Number.isInteger(depth) || depth < 0 || depth > 64) {
    throw new RangeError(`chunksForDepth: implausible depth ${depth}`);
  }
  return 1n << BigInt(depth);
}

/** Storage capacity of a batch, in bytes. */
export function capacityBytes(depth: number): bigint {
  return chunksForDepth(depth) * BigInt(CHUNK_BYTES);
}

/** Gnosis block time. Measured at 4.997 s/block against the live chain. */
export const GNOSIS_MS_PER_BLOCK = 5000;

/** Blocks elapsed in `seconds`, rounded up. */
export function blocksForSeconds(seconds: number, msPerBlock = GNOSIS_MS_PER_BLOCK): bigint {
  if (msPerBlock <= 0) throw new RangeError('blocksForSeconds: msPerBlock must be > 0');
  if (seconds <= 0) return 0n;
  return ceilDiv(BigInt(Math.ceil(seconds)) * 1000n, BigInt(Math.round(msPerBlock)));
}

/**
 * PLUR-per-chunk needed to buy `seconds` of life, at the current chain price.
 *
 * A batch is charged `currentPrice` per chunk per block, so duration is simply
 * price × blocks. Note this cannot be derived from a batch's own
 * `amount / batchTTL`: `amount` is the *cumulative* per-chunk value ever
 * deposited, not the remaining balance. For the live `t4t` batch that ratio
 * overstates the true rate by 1.687x — it was bought with 58 days, 24.4 have
 * elapsed, and ~34 remain, so amount/TTL measures 58 days of deposit against
 * 34 days of remainder. Sizing a top-up that way over-buys by the same factor.
 */
export function amountForDuration(
  pricePerChunkPerBlock: bigint,
  seconds: number,
  msPerBlock = GNOSIS_MS_PER_BLOCK,
): bigint {
  if (seconds <= 0) return 0n;
  return pricePerChunkPerBlock * blocksForSeconds(seconds, msPerBlock);
}

/** How long a given per-chunk balance lasts at the current price, in seconds. */
export function ttlSecondsForAmount(
  remainingAmount: bigint,
  pricePerChunkPerBlock: bigint,
  msPerBlock = GNOSIS_MS_PER_BLOCK,
): number {
  if (pricePerChunkPerBlock <= 0n) throw new RangeError('ttlSecondsForAmount: price must be positive');
  if (remainingAmount <= 0n) return 0;
  return Number(remainingAmount / pricePerChunkPerBlock) * (msPerBlock / 1000);
}

/** Total PLUR a top-up of `deltaAmount` per chunk costs at this depth. */
export function costPlur(deltaAmount: bigint, depth: number): bigint {
  return deltaAmount * chunksForDepth(depth);
}

/** Cost of keeping a batch of this depth alive for 30 days, in PLUR. */
export function costPer30Days(
  pricePerChunkPerBlock: bigint,
  depth: number,
  msPerBlock = GNOSIS_MS_PER_BLOCK,
): bigint {
  return costPlur(amountForDuration(pricePerChunkPerBlock, 30 * 86400, msPerBlock), depth);
}

/** BZZ as a display number. Lossy by design — never feed this back into math. */
export function plurToBzz(plur: bigint): number {
  return Number(plur) / Number(PLUR_PER_BZZ);
}

/** Parse a user-facing BZZ amount (e.g. "10.5") into exact PLUR. */
export function bzzToPlur(bzz: string | number): bigint {
  const s = typeof bzz === 'number' ? bzz.toString() : bzz.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RangeError(`bzzToPlur: not a positive decimal: ${s}`);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(16)).slice(0, 16);
  return BigInt(whole) * PLUR_PER_BZZ + BigInt(padded || '0');
}

/** Bytes actually stored, from the node's utilizationRatio. */
export function storedBytes(utilizationRatio: number, depth: number): bigint {
  const ratio = Math.max(0, Math.min(1, utilizationRatio));
  return BigInt(Math.round(ratio * Number(capacityBytes(depth))));
}

/**
 * How long the wallet can sustain the current batches, in seconds.
 * This is the number that makes over-provisioning obvious.
 */
export function runwaySeconds(walletPlur: bigint, burnPlurPer30Days: bigint): number {
  if (burnPlurPer30Days <= 0n) return Infinity;
  return Number((walletPlur * BigInt(30 * 86400)) / burnPlurPer30Days);
}

/**
 * Bandwidth spend rate and chequebook runway, from two settlement readings.
 *
 * Derived from `settlementsSent` rather than from the balance on purpose.
 * Sent is cumulative and only ever increases, so it measures exactly what left
 * for bandwidth in the window. The balance also moves when the chequebook is
 * topped up or a peer cashes a cheque, and a deposit would otherwise read as
 * negative spend and put the runway at infinity right after you funded it.
 *
 * `sent` going BACKWARDS means a different chequebook — a redeployed node, or
 * a wiped database — so the window is treated as having no usable baseline
 * rather than as a negative rate.
 */
export function chequebookSpendPer30Days(
  sentNow: bigint,
  sentThen: bigint,
  windowMs: number,
): bigint | null {
  if (windowMs <= 0 || sentNow < sentThen) return null;
  return ((sentNow - sentThen) * BigInt(30 * 86_400_000)) / BigInt(windowMs);
}

/**
 * Days of bandwidth the chequebook can still pay for.
 *
 * Null rather than Infinity when nothing is being spent: Infinity does not
 * survive JSON.stringify — it becomes null on the wire anyway — so the absence
 * is made explicit here instead of being discovered by the client.
 */
export function chequebookRunwayDays(availablePlur: bigint, spentPer30Days: bigint | null): number | null {
  if (spentPer30Days == null || spentPer30Days <= 0n) return null;
  return Number((availablePlur * BigInt(30 * 86400)) / spentPer30Days) / 86_400;
}
