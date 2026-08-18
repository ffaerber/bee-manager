/**
 * A fake Bee node, complete enough to drive the real service end to end.
 *
 * Exists because the alternative is testing against the live node, where every
 * run buys batches, tops them up and dilutes them with real xBZZ — and dilution
 * cannot be undone, since depth only ever increases. A smoke test that costs
 * money and mutates production is a smoke test nobody runs.
 *
 * What it models properly, because the service's behaviour depends on it:
 *
 *   buckets      A chunk's address decides its bucket — the first `bucketDepth`
 *                bits — so occupancy is uneven and the FIRST bucket to fill is
 *                what ends a batch, long before the nominal capacity does. A
 *                fake that just counted bytes would never produce the birthday
 *                behaviour the whole product is about.
 *   immutability A full bucket refuses the write on an immutable batch and
 *                recycles silently on a mutable one. Opposite failures.
 *   time         Blocks advance on demand, so a batch really does drain and the
 *                planner really does decide to top it up. Nothing here sleeps.
 *
 * Deliberately NOT modelled: chunk-level content addressing (references are
 * hashes of the payload, which is enough to be unique and stable), retrieval,
 * and anything to do with the network.
 */

const PLUR_PER_BZZ = 10n ** 16n;
const BUCKET_DEPTH = 16;
const BUCKETS = 1 << BUCKET_DEPTH;
const CHUNK = 4096;

export interface FakeBatch {
  batchID: string;
  label: string;
  depth: number;
  bucketDepth: number;
  immutableFlag: boolean;
  /** Remaining balance per chunk, in PLUR. Drains as blocks pass. */
  amount: bigint;
  blockNumber: number;
  /** collisions per bucket, sparse */
  buckets: Map<number, number>;
  exists: boolean;
}

export class FakeBee {
  batches = new Map<string, FakeBatch>();
  block = 41_000_000;
  price = 73_850n;
  bzz = 200n * PLUR_PER_BZZ;
  xdai = 2n * 10n ** 18n;
  /** Every write the node was asked to make, for assertions. */
  log: { kind: string; batchId?: string; detail?: string }[] = [];
  private seed = 20260818;
  private nonce = 0;

  /** Deterministic PRNG — a flaky smoke test is worse than none. */
  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  private bucketUpperBound(depth: number) { return Math.pow(2, depth - BUCKET_DEPTH); }

  /** PLUR per chunk consumed per block at the current price. */
  private drainPerBlock() { return this.price; }

  /** Advance the chain, draining every live batch exactly as Swarm would. */
  advanceBlocks(n: number) {
    this.block += n;
    const drain = this.drainPerBlock() * BigInt(n);
    for (const b of this.batches.values()) {
      if (!b.exists) continue;
      b.amount = b.amount > drain ? b.amount - drain : 0n;
      if (b.amount === 0n) b.exists = false;   // expired batches vanish from /stamps
    }
  }
  advanceSeconds(s: number) { this.advanceBlocks(Math.floor(s / 5)); }

  ttlSeconds(b: FakeBatch): number {
    if (b.amount <= 0n) return 0;
    return Number(b.amount / this.price) * 5;
  }

  maxCollisions(b: FakeBatch): number {
    let m = 0;
    for (const v of b.buckets.values()) if (v > m) m = v;
    return m;
  }

  utilizationRatio(b: FakeBatch): number {
    return this.maxCollisions(b) / this.bucketUpperBound(b.depth);
  }

  totalChunks(b: FakeBatch): number {
    let t = 0;
    for (const v of b.buckets.values()) t += v;
    return t;
  }

  private view(b: FakeBatch) {
    return {
      batchID: b.batchID, label: b.label, depth: b.depth, bucketDepth: b.bucketDepth,
      immutableFlag: b.immutableFlag, amount: b.amount.toString(),
      blockNumber: b.blockNumber, exists: b.exists, usable: b.exists,
      utilization: this.maxCollisions(b),
      utilizationRatio: this.utilizationRatio(b),
      batchTTL: this.ttlSeconds(b),
    };
  }

  /**
   * Stamp `chunks` chunks into a batch, assigning each a random bucket.
   *
   * Returns the number actually stored. On an immutable batch a full bucket
   * ends the upload — Bee rejects it — whereas a mutable one recycles, which
   * shows up as the count not growing rather than as an error.
   */
  stamp(b: FakeBatch, chunks: number): { stored: number; rejected: boolean } {
    const cap = this.bucketUpperBound(b.depth);
    let stored = 0;
    for (let i = 0; i < chunks; i++) {
      const bucket = Math.floor(this.rnd() * BUCKETS);
      const have = b.buckets.get(bucket) ?? 0;
      if (have >= cap) {
        if (b.immutableFlag) return { stored, rejected: true };
        continue;                       // mutable: recycles, count does not grow
      }
      b.buckets.set(bucket, have + 1);
      stored++;
    }
    return { stored, rejected: false };
  }

  /** Swarm adds Merkle and manifest chunks above the data chunks. */
  chunksFor(bytes: number) { return Math.ceil(bytes / CHUNK * 1.25) + 1; }

  private id(): string {
    const n = (this.nonce++).toString(16).padStart(8, '0');
    return (n + 'a3e41d8b06f5c1e9a72d4b83f10c6e5a9184b2d7c30f8a1e6b95d4c20').slice(0, 64);
  }

  private json(v: unknown, status = 200) {
    return new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const live = () => [...this.batches.values()].filter((b) => b.exists);

    if (p === '/health') return this.json({ status: 'ok', version: '2.8.1-fake', apiVersion: '7.2.0' });
    if (p === '/node') return this.json({ beeMode: 'full', chequebookEnabled: true });
    if (p === '/stake') return this.json({ stakedAmount: (10n * PLUR_PER_BZZ).toString() });
    if (p === '/reservestate') return this.json({ storageRadius: 11 });
    if (p === '/topology') return this.json({ connected: 142 });
    if (p === '/chequebook/balance') return this.json({ totalBalance: '99818545999999200', availableBalance: '99285055999995600' });
    if (p === '/chequebook/cheque') return this.json({ lastcheques: [] });
    if (p === '/settlements') return this.json({ totalReceived: '773000000200', totalSent: '714944000004400', settlements: [] });

    if (p === '/chainstate') {
      return this.json({
        chainTip: this.block, block: this.block, totalAmount: '1000000000',
        currentPrice: this.price.toString(), minimumValidityBlocks: 17280,
      });
    }
    if (p === '/wallet') {
      return this.json({
        bzzBalance: this.bzz.toString(), nativeTokenBalance: this.xdai.toString(),
        chainID: 100, walletAddress: '0x1D0aB2c5f9E47b6C83a0F5e214D7b9C60Ae38f41',
        chequebookContractAddress: '0x6aB5935F17e4F29fAEaF2f85CFD0887a2f993651',
      });
    }

    if (p === '/stamps' && m === 'GET') return this.json({ stamps: live().map((b) => this.view(b)) });

    // POST /stamps/{amountPerChunk}/{depth}
    let mt = p.match(/^\/stamps\/(\d+)\/(\d+)$/);
    if (mt && m === 'POST') {
      const amount = BigInt(mt[1]), depth = Number(mt[2]);
      const cost = amount * BigInt(Math.pow(2, depth));
      if (cost > this.bzz) return this.json({ code: 400, message: 'insufficient funds' }, 400);
      this.bzz -= cost;
      const id = this.id();
      this.batches.set(id, {
        // Real Bee takes the label as ?label=, and immutability as a header.
        batchID: id, label: url.searchParams.get('label') ?? '',
        depth, bucketDepth: BUCKET_DEPTH,
        immutableFlag: /^true$/i.test(req.headers.get('immutable') ?? ''),
        amount, blockNumber: this.block, buckets: new Map(), exists: true,
      });
      this.log.push({ kind: 'create', batchId: id, detail: `depth=${depth} amount=${amount}` });
      return this.json({ batchID: id });
    }

    mt = p.match(/^\/stamps\/topup\/([0-9a-f]+)\/(\d+)$/);
    if (mt && m === 'PATCH') {
      const b = this.batches.get(mt[1]);
      if (!b || !b.exists) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      const add = BigInt(mt[2]);
      const cost = add * BigInt(Math.pow(2, b.depth));
      if (cost > this.bzz) return this.json({ code: 400, message: 'insufficient funds' }, 400);
      this.bzz -= cost;
      b.amount += add;
      this.log.push({ kind: 'topup', batchId: b.batchID, detail: `+${add}/chunk` });
      return this.json({ batchID: b.batchID });
    }

    mt = p.match(/^\/stamps\/dilute\/([0-9a-f]+)\/(\d+)$/);
    if (mt && m === 'PATCH') {
      const b = this.batches.get(mt[1]);
      if (!b || !b.exists) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      const nd = Number(mt[2]);
      // Bee checks only that depth increases — immutability is NOT a bar.
      if (nd <= b.depth) return this.json({ code: 400, message: 'depth must increase' }, 400);
      // The paid-for amount now covers 2^(nd-depth) times as many chunks.
      b.amount = b.amount / BigInt(Math.pow(2, nd - b.depth));
      b.depth = nd;
      this.log.push({ kind: 'dilute', batchId: b.batchID, detail: `-> depth ${nd}` });
      return this.json({ batchID: b.batchID });
    }

    mt = p.match(/^\/stamps\/([0-9a-f]+)\/buckets$/);
    if (mt && m === 'GET') {
      const b = this.batches.get(mt[1]);
      if (!b) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      const arr = new Array(BUCKETS).fill(0).map((_, i) => ({ bucketID: i, collisions: b.buckets.get(i) ?? 0 }));
      return this.json({ depth: b.depth, bucketDepth: b.bucketDepth, bucketUpperBound: this.bucketUpperBound(b.depth), buckets: arr });
    }

    mt = p.match(/^\/stamps\/([0-9a-f]+)$/);
    if (mt && m === 'GET') {
      const b = this.batches.get(mt[1]);
      if (!b) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      return this.json(this.view(b));
    }
    if (mt && m === 'PATCH') {                       // setLabel
      const b = this.batches.get(mt[1]);
      if (!b) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      b.label = url.searchParams.get('label') ?? b.label;
      return this.json({ batchID: b.batchID });
    }

    if ((p === '/bzz' || p === '/bytes') && m === 'POST') {
      const id = req.headers.get('swarm-postage-batch-id') ?? '';
      const b = this.batches.get(id);
      if (!b || !b.exists) return this.json({ code: 404, message: 'issuer does not exist' }, 404);
      const body = new Uint8Array(await req.arrayBuffer());
      const { stored, rejected } = this.stamp(b, this.chunksFor(body.byteLength));
      if (rejected) {
        this.log.push({ kind: 'upload-rejected', batchId: id, detail: `${body.byteLength}B` });
        return this.json({ code: 400, message: 'batch is full' }, 400);
      }
      this.log.push({ kind: 'upload', batchId: id, detail: `${body.byteLength}B -> ${stored} chunks` });
      // Reference: stable hash of the payload. Uniqueness is all the service needs.
      let h = 2166136261 >>> 0;
      for (let i = 0; i < body.length; i++) { h ^= body[i]; h = Math.imul(h, 16777619) >>> 0; }
      const ref = (h.toString(16).padStart(8, '0') + 'b95d4c2073a1e6b93f10c6e5a9184b2d7c30f8a1e6b95d4c2073a1e6b9').slice(0, 64);
      return this.json({ reference: ref });
    }

    return this.json({ code: 404, message: `fake-bee: unhandled ${m} ${p}` }, 404);
  };

  serve(port = 0) {
    return Bun.serve({ port, fetch: this.handle });
  }
}
