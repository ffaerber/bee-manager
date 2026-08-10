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
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init?: RequestInit, opts: { write?: boolean; operation?: string } = {}): Promise<any> {
    const timeout = opts.write ? this.writeTimeoutMs : this.timeoutMs;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e: any) {
      // A read that times out is simply a failed read — nothing happened. A
      // write that times out may have spent money, and must be surfaced as
      // such so the caller records it as in-flight rather than failed.
      if (opts.write && (e?.name === 'TimeoutError' || e?.name === 'AbortError')) {
        throw new BeeIndeterminateError(opts.operation ?? path, e);
      }
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
      const [node, stake, cheque, reserve, topology] = await Promise.all([
        settle(this.request('/node')),
        settle(this.request('/stake')),
        settle(this.request('/chequebook/balance')),
        settle(this.request('/reservestate')),
        settle(this.request('/topology')),
      ]);
      if (node) { status.beeMode = node.beeMode; status.chequebookEnabled = node.chequebookEnabled; }
      if (stake?.stakedAmount != null) status.stakedAmount = BigInt(stake.stakedAmount);
      if (cheque?.totalBalance != null) status.chequebookBalance = BigInt(cheque.totalBalance);
      if (cheque?.availableBalance != null) status.chequebookAvailable = BigInt(cheque.availableBalance);
      if (reserve?.storageRadius != null) status.storageRadius = reserve.storageRadius;
      if (topology?.connected != null) status.peers = topology.connected;
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
    const headers: Record<string, string> = {};
    if (opts.immutable !== undefined) headers.immutable = String(opts.immutable);
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
    const d = await this.request(`/bzz${qs}`, { method: 'POST', headers, body: body as any });
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
