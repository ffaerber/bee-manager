/**
 * Bee API client.
 *
 * Read calls are safe to run anywhere. The three write calls (`buyBatch`,
 * `topUp`, `dilute`) each create an on-chain transaction that moves BZZ out of
 * the node's wallet — they are never called directly by the poller, only via
 * `executeAction`, which enforces the spend caps first.
 */

export interface Batch {
  batchID: string;
  utilization: number;
  utilizationRatio: number;
  usable: boolean;
  label: string;
  depth: number;
  amount: bigint;
  bucketDepth: number;
  blockNumber: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
}

/** Occupancy of every bucket in a batch. `buckets[i]` is the stamp count in bucket i. */
export interface BucketReport {
  depth: number;
  bucketDepth: number;
  /** Capacity of ONE bucket: 2^(depth - bucketDepth). */
  bucketUpperBound: number;
  buckets: number[];
}

export interface ChainState {
  chainTip: number;
  block: number;
  totalAmount: bigint;
  currentPrice: bigint;
  minimumValidityBlocks: number;
}

export interface Wallet {
  bzzBalance: bigint;
  nativeTokenBalance: bigint;
  chainID: number;
  walletAddress: string;
  chequebookContractAddress: string;
}

/** Node health beyond the stamps themselves — the "is the node itself okay" view. */
export interface NodeStatus {
  healthy: boolean;
  version?: string;
  apiVersion?: string;
  beeMode?: string;
  chequebookEnabled?: boolean;
  stakedAmount?: bigint;
  chequebookBalance?: bigint;
  chequebookAvailable?: bigint;
  /**
   * Lifetime SWAP settlement, in PLUR.
   *
   * Bandwidth is paid for by the node doing the retrieving, so a node that
   * uploads and reads more than it serves is a net payer. These are cumulative
   * and only ever increase, which is what makes them usable as a rate.
   */
  settlementsSent?: bigint;
  settlementsReceived?: bigint;
  /** Peers this node has written a cheque to, or received one from. */
  chequePeers?: number;
  /** Peers whose cheque to us has not been cashed — money owed, sitting idle. */
  peersOwingUs?: number;
  peers?: number;
  storageRadius?: number;
  error?: string;
}

export class BeeError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number) {
    super(message);
    this.name = 'BeeError';
  }
}

/** Bee reports errors as {"code":404,"message":"issuer does not exist"}. */
function beeErrorFrom(status: number, body: string): BeeError {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === 'string') {
      return new BeeError(parsed.message, status, parsed.code);
    }
  } catch { /* fall through to the raw body */ }
  return new BeeError(body.slice(0, 200) || `HTTP ${status}`, status);
}

/**
 * A write timed out client-side. The transaction may still be mined —
 * abandoning an HTTP request does not cancel a blockchain transaction — so the
 * outcome is UNKNOWN, not failed. Callers must not retry on this.
 */
export class BeeIndeterminateError extends Error {
  constructor(readonly operation: string, readonly cause?: unknown) {
    super(`${operation} timed out client-side; the transaction may still be mined — do not retry`);
    this.name = 'BeeIndeterminateError';
  }
}

export class BeeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
    /**
     * Writes create on-chain transactions and routinely take far longer than a
     * read. A short timeout here does not make anything safer — it just means
     * giving up while the money is already moving.
     */
    private readonly writeTimeoutMs = 300_000,
    /**
     * Uploads are data transfers, not chain operations, and they routinely
     * outlast a read. They were sharing the 15s read timeout, which aborted
     * any file slow enough to take longer — a size-independent failure that
     * looked like "large uploads do not work".
     */
    private readonly uploadTimeoutMs = 300_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request(
    path: string,
    init?: RequestInit,
    opts: { write?: boolean; upload?: boolean; operation?: string } = {},
  ): Promise<any> {
    const timeout = opts.write ? this.writeTimeoutMs : opts.upload ? this.uploadTimeoutMs : this.timeoutMs;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e: any) {
      // Nothing came back at all. For a read that is simply a failed read. For
      // a write it means the request never completed — and abandoning an HTTP
      // request does not cancel a blockchain transaction, so the outcome is
      // UNKNOWN and must not be recorded as failed.
      //
      // Every fetch rejection counts, not just timeouts. A live dilution was
      // lost to "The socket connection was closed unexpectedly", which is
      // neither TimeoutError nor AbortError: it was logged failed while the
      // transaction actually landed, leaving the ledger disagreeing with the
      // chain and inviting a second dilution on the next poll.
      //
      // The distinction that matters is fetch throwing versus an HTTP error
      // response: a 4xx/5xx means Bee answered and rejected it, which is a
      // real failure, and that path is below.
      if (opts.write) throw new BeeIndeterminateError(opts.operation ?? path, e);
      throw e;
    }
    const body = await res.text();
    if (!res.ok) throw beeErrorFrom(res.status, body);
    return body ? JSON.parse(body) : null;
  }

  // ── reads ────────────────────────────────────────────────────────────

  async stamps(): Promise<Batch[]> {
    const data = await this.request('/stamps');
    return (data?.stamps ?? []).map(toBatch);
  }

  async stamp(batchId: string): Promise<Batch> {
    return toBatch(await this.request(`/stamps/${batchId}`));
  }

  /**
   * Per-bucket occupancy for a batch — the exact shape of what is stored.
   *
   * A batch is split into 2^bucketDepth (65,536) buckets, and the leading bits
   * of a chunk's address decide which bucket its stamp must go in. You cannot
   * choose; the content's hash chooses for you. Each bucket holds
   * 2^(depth-bucketDepth) stamps, reported as `bucketUpperBound`.
   *
   * This is the only endpoint that reports what is *actually* stored.
   * `utilizationRatio` on /stamps is a coarse upper bound derived from the
   * fullest bucket — on the live node it reported 268 MB for a batch holding
   * 115 chunks (0.47 MB), a 570x overstatement. Anything claiming to show real
   * usage has to come from here.
   */
  async buckets(batchId: string): Promise<BucketReport> {
    const d = await this.request(`/stamps/${batchId}/buckets`);
    return {
      depth: d.depth,
      bucketDepth: d.bucketDepth,
      bucketUpperBound: d.bucketUpperBound,
      buckets: (d.buckets ?? []).map((b: any) => b.collisions as number),
    };
  }

  async chainstate(): Promise<ChainState> {
    const d = await this.request('/chainstate');
    return {
      chainTip: d.chainTip,
      block: d.block,
      totalAmount: BigInt(d.totalAmount),
      currentPrice: BigInt(d.currentPrice),
      minimumValidityBlocks: d.minimumValidityBlocks,
    };
  }

  async wallet(): Promise<Wallet> {
    const d = await this.request('/wallet');
    return {
      bzzBalance: BigInt(d.bzzBalance),
      nativeTokenBalance: BigInt(d.nativeTokenBalance),
      chainID: d.chainID,
      walletAddress: d.walletAddress,
      chequebookContractAddress: d.chequebookContractAddress,
    };
  }

  /**
   * Best-effort node health. Individual sub-checks are allowed to fail without
   * failing the whole call — a node with the chequebook disabled is still a
   * node worth reporting on.
   */
  async nodeStatus(): Promise<NodeStatus> {
    try {
      const health = await this.request('/health');
      const status: NodeStatus = {
        healthy: health?.status === 'ok',
        version: health?.version,
        apiVersion: health?.apiVersion,
      };
      const settle = async <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);
      const [node, stake, cheque, reserve, topology, settlements, cheques] = await Promise.all([
        settle(this.request('/node')),
        settle(this.request('/stake')),
        settle(this.request('/chequebook/balance')),
        settle(this.request('/reservestate')),
        settle(this.request('/topology')),
        settle(this.request('/settlements')),
        settle(this.request('/chequebook/cheque')),
      ]);
      if (node) { status.beeMode = node.beeMode; status.chequebookEnabled = node.chequebookEnabled; }
      if (stake?.stakedAmount != null) status.stakedAmount = BigInt(stake.stakedAmount);
      if (cheque?.totalBalance != null) status.chequebookBalance = BigInt(cheque.totalBalance);
      if (cheque?.availableBalance != null) status.chequebookAvailable = BigInt(cheque.availableBalance);
      if (reserve?.storageRadius != null) status.storageRadius = reserve.storageRadius;
      if (topology?.connected != null) status.peers = topology.connected;
      if (settlements?.totalSent != null) status.settlementsSent = BigInt(settlements.totalSent);
      if (settlements?.totalReceived != null) status.settlementsReceived = BigInt(settlements.totalReceived);
      if (Array.isArray(cheques?.lastcheques)) {
        status.chequePeers = cheques.lastcheques.length;
        // `lastreceived` is null for a peer we have only ever paid. A non-null
        // one is a cheque written TO us; whether it has been cashed is a
        // separate per-peer call, so this counts claims rather than value.
        status.peersOwingUs = cheques.lastcheques.filter((c: any) => c?.lastreceived != null).length;
      }
      return status;
    } catch (e: any) {
      return { healthy: false, error: e?.message ?? String(e) };
    }
  }

  // ── writes: each of these spends BZZ ─────────────────────────────────

  /**
   * Buy a new batch. `amountPerChunk` is PLUR per chunk; total cost is
   * `amountPerChunk × 2^depth`. Depth must exceed the bucket depth (16).
   */
  async buyBatch(
    amountPerChunk: bigint,
    depth: number,
    opts: { label?: string; immutable?: boolean } = {},
  ): Promise<string> {
    if (depth <= 16) throw new BeeError(`depth must be greater than bucketDepth 16, got ${depth}`);
    if (amountPerChunk <= 0n) throw new BeeError('amount must be positive');
    const qs = opts.label ? `?label=${encodeURIComponent(opts.label)}` : '';
    // Always send the flag explicitly rather than inheriting whatever Bee
    // happens to default to. Silently inheriting it is how two batches were
    // bought immutable by accident; the value is a decision, so it travels.
    //
    // Defaults to immutable, matching Bee. When a bucket fills, an immutable
    // batch refuses the write while a mutable one discards its oldest chunk in
    // that bucket — silently, with no error, so a stored reference just stops
    // resolving. Refusing is the better failure for data meant to persist, and
    // dilution recovers from it (verified against DiluteBatch and the on-chain
    // increaseDepth, neither of which looks at immutableFlag).
    const headers: Record<string, string> = { immutable: String(opts.immutable ?? true) };
    const d = await this.request(`/stamps/${amountPerChunk}/${depth}${qs}`, { method: 'POST', headers },
      { write: true, operation: `buyBatch(depth ${depth})` });
    return d.batchID;
  }

  /**
   * Upload bytes stamped with `batchId`, returning the Swarm reference.
   *
   * This is what replaces dapps talking to the node directly — it is the only
   * write the public API exposes, and it consumes batch *capacity* rather than
   * moving BZZ directly (a full batch forces a dilution, which is what costs).
   */
  async upload(
    batchId: string,
    body: Uint8Array,
    opts: {
      name?: string;
      contentType?: string;
      /** Upload a tar as a directory ("collection") rather than a single blob. */
      collection?: boolean;
      /** Served for the collection root — index.html for a site. */
      indexDocument?: string;
      /** Served for unmatched paths; an SPA points this at index.html too. */
      errorDocument?: string;
    } = {},
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Swarm-Postage-Batch-Id': batchId,
      'Content-Type': opts.contentType ?? 'application/octet-stream',
    };
    if (opts.collection) {
      headers['Swarm-Collection'] = 'true';
      if (opts.indexDocument) headers['Swarm-Index-Document'] = opts.indexDocument;
      if (opts.errorDocument) headers['Swarm-Error-Document'] = opts.errorDocument;
    }
    const qs = opts.name ? `?name=${encodeURIComponent(opts.name)}` : '';
    const d = await this.request(`/bzz${qs}`, { method: 'POST', headers, body: body as any },
      { upload: true, operation: `upload(${body.byteLength} bytes)` });
    return d.reference;
  }

  /**
   * Rename a batch. The label is the only human-meaningful handle that lives on
   * the node itself, so it survives this service's database being lost — and
   * other tools discover batches by it (t4t's own manager matches on label).
   *
   * Bee wants JSON here; a text/plain body is rejected with 400. Verified
   * against Bee 2.8.1 with a rename-and-revert round trip.
   */
  async setLabel(batchId: string, label: string): Promise<void> {
    await this.request(`/stamps/${batchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    });
  }

  /** Raw passthrough, for proxying reads. Caller owns the Response body. */
  async raw(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  /** POST /bytes — raw data upload, what bee-js `uploadData` uses. */
  async uploadBytes(batchId: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<string> {
    const d = await this.request('/bytes', {
      method: 'POST',
      headers: { 'Swarm-Postage-Batch-Id': batchId, 'Content-Type': contentType },
      body: body as any,
    }, { upload: true, operation: `uploadBytes(${body.byteLength} bytes)` });
    return d.reference;
  }

  /** Add `amountPerChunk` PLUR per chunk to an existing batch, extending its TTL. */
  async topUp(batchId: string, amountPerChunk: bigint): Promise<string> {
    if (amountPerChunk <= 0n) throw new BeeError('top-up amount must be positive');
    const d = await this.request(`/stamps/topup/${batchId}/${amountPerChunk}`, { method: 'PATCH' },
      { write: true, operation: `topUp(${batchId.slice(0, 12)}…)` });
    return d.batchID;
  }

  /**
   * Increase a batch's depth. Note this *halves* remaining TTL per depth step,
   * since the same per-chunk amount now covers twice as many chunks — callers
   * should top up afterwards, not before.
   */
  async dilute(batchId: string, newDepth: number): Promise<string> {
    const d = await this.request(`/stamps/dilute/${batchId}/${newDepth}`, { method: 'PATCH' },
      { write: true, operation: `dilute(${batchId.slice(0, 12)}… -> ${newDepth})` });
    return d.batchID;
  }
}

function toBatch(d: any): Batch {
  return {
    batchID: d.batchID,
    utilization: d.utilization,
    utilizationRatio: d.utilizationRatio ?? 0,
    usable: d.usable,
    label: d.label ?? '',
    depth: d.depth,
    amount: BigInt(d.amount),
    bucketDepth: d.bucketDepth,
    blockNumber: d.blockNumber,
    immutableFlag: d.immutableFlag,
    exists: d.exists ?? true,
    batchTTL: d.batchTTL,
  };
}
