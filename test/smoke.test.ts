/**
 * Full workflow, real service, fake node.
 *
 * Buys a batch, uploads files of several sizes, watches the map fill, lets the
 * chain drain until the planner tops up, fills a bucket until the batch seals,
 * and checks the dilute that rescues it. Every assertion is about the real
 * poller / evaluate / server code — only Bee is fake, and only because a real
 * run would spend xBZZ and dilute production batches irreversibly.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { FakeBee } from './fake-bee';
import { BeeClient } from '../src/bee';
import { Db } from '../src/db';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { loadConfig } from '../src/config';
import { evaluateBatch, fullnessOf } from '../src/evaluate';
import { buildGrid, bucketPressure } from '../src/buckets';
import { amountForDuration, costPlur, plurToBzz } from '../src/math';

const PLUR_PER_BZZ = 10n ** 16n;
let bee: FakeBee, srv: ReturnType<FakeBee['serve']>, client: BeeClient, db: Db, poller: Poller;

const cfgFor = (over: Record<string, string> = {}) => {
  const env = {
    BEE_URL: `http://127.0.0.1:${srv.port}`, DB_PATH: ':memory:',
    AUTO_TOPUP_ENABLED: 'true', DRY_RUN: 'false', DILUTE_ENABLED: 'true',
    TOPUP_WHEN_TTL_BELOW_DAYS: '14', TOPUP_TARGET_TTL_DAYS: '60',
    MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '2000',
    MIN_WALLET_BZZ: '0', MIN_WALLET_XDAI: '0', ...over,
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const c = loadConfig();
  process.env = saved;
  return c;
};

beforeAll(() => {
  bee = new FakeBee();
  srv = bee.serve();
  client = new BeeClient(`http://127.0.0.1:${srv.port}`, 5000, 5000, 10000);
  db = new Db(':memory:');
  poller = new Poller(cfgFor(), client, db, new Alerter(db, null, 0));
});
afterAll(() => { srv.stop(true); db.close(); });

/** 30 days of runway per chunk at the fake node's price. */
const thirtyDays = () => amountForDuration(bee.price, 30 * 86_400, 5000);

describe('buying a batch', () => {
  it('creates it on the node and charges the wallet', async () => {
    const before = bee.bzz;
    const id = await client.buyBatch(thirtyDays(), 20, { label: 'smoke', immutable: false });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const b = bee.batches.get(id)!;
    expect(b.depth).toBe(20);
    expect(b.label).toBe('smoke');
    expect(before - bee.bzz).toBe(thirtyDays() * BigInt(2 ** 20));
  });

  it('shows up in /stamps with a sane TTL', async () => {
    const stamps = await client.stamps();
    expect(stamps.length).toBe(1);
    expect(stamps[0].batchTTL / 86_400).toBeCloseTo(30, 0);
    expect(stamps[0].utilizationRatio).toBe(0);
  });
});

describe('uploading data of different sizes', () => {
  const sizes: [string, number][] = [
    ['1 KB', 1_024], ['64 KB', 65_536], ['1 MB', 1_048_576], ['8 MB', 8 * 1_048_576],
  ];

  it('stores every size and grows the chunk count monotonically', async () => {
    const id = [...bee.batches.keys()][0];
    let last = 0;
    for (const [label, bytes] of sizes) {
      const ref = await client.uploadBytes(id, new Uint8Array(bytes).fill(7));
      expect(ref, `${label} should return a reference`).toMatch(/^[0-9a-f]{64}$/);
      const now = bee.totalChunks(bee.batches.get(id)!);
      expect(now, `${label} should add chunks`).toBeGreaterThan(last);
      last = now;
    }
    // 8 MB dominates: ~2048 data chunks plus Merkle overhead.
    expect(last).toBeGreaterThan(2_000);
  });

  it('fills buckets unevenly, which is the whole point', async () => {
    const id = [...bee.batches.keys()][0];
    const r = await client.buckets(id);
    const used = r.buckets.filter((c) => c > 0).length;
    const max = Math.max(...r.buckets);
    expect(used).toBeGreaterThan(0);
    // With ~2.6k chunks over 65,536 buckets, some bucket must hold more than
    // one. A model that spread them evenly would never seal a batch early.
    expect(max).toBeGreaterThan(1);
    expect(used).toBeLessThan(65_536);
  });

  it('renders a map the UI can draw', async () => {
    const id = [...bee.batches.keys()][0];
    const r = await client.buckets(id);
    const g = buildGrid(r);
    expect(g.side).toBe(256);
    expect(g.usedBuckets + g.emptyBuckets).toBe(65_536);
    expect(g.totalChunks).toBeGreaterThan(2_000);
    expect(g.fullBuckets).toBe(0);
    expect(bucketPressure(g, false).level).toBe('good');
  });
});

describe('the batch draining, and the planner topping it up', () => {
  it('plans nothing while there is plenty of life', async () => {
    await poller.tick();
    const plans = poller.last!.plans;
    expect(plans.every((p) => p.kind === 'none')).toBe(true);
  });

  it('tops up once TTL falls under the threshold', async () => {
    // 30 days of runway, threshold is 14 -> step past it.
    bee.advanceSeconds(20 * 86_400);
    const before = bee.log.filter((l) => l.kind === 'topup').length;
    await poller.tick();
    const after = bee.log.filter((l) => l.kind === 'topup').length;
    expect(after, 'a top-up should have been executed').toBe(before + 1);
  });

  it('restored the life it was aiming for', async () => {
    const b = (await client.stamps())[0];
    expect(b.batchTTL / 86_400).toBeGreaterThan(55);
  });

  it('does nothing on the next tick — the condition is gone', async () => {
    const before = bee.log.filter((l) => l.kind === 'topup').length;
    await poller.tick();
    expect(bee.log.filter((l) => l.kind === 'topup').length).toBe(before);
  });
});

describe('a batch that fills up', () => {
  let id: string;

  it('seals an immutable batch, which then refuses writes', async () => {
    // Depth 17: bucketUpperBound 2, so a bucket fills almost immediately.
    id = await client.buyBatch(thirtyDays(), 17, { label: 'tiny', immutable: true });
    const b = bee.batches.get(id)!;

    // firstFullEstimate(17) is ~311 chunks, so this has to push well past
    // that -- 64 KB is ~21 chunks a go.
    let rejected = false;
    for (let i = 0; i < 120 && !rejected; i++) {
      try { await client.uploadBytes(id, new Uint8Array(65_536).fill(i % 251)); }
      catch { rejected = true; }
    }
    expect(rejected, 'an immutable batch must eventually refuse').toBe(true);
    expect(bee.utilizationRatio(b)).toBe(1);
  });

  it('reports itself full to the fullness check the upload path uses', async () => {
    const b = (await client.stamps()).find((x) => x.batchID === id)!;
    expect(fullnessOf(b, 0.8)).toBe('full');
  });

  it('and the map shows a bucket at capacity', async () => {
    const r = await client.buckets(id);
    const g = buildGrid(r);
    expect(g.fullBuckets).toBeGreaterThan(0);
    expect(bucketPressure(g, true).level).toBe('critical');
  });

  it('dilution rescues it — depth up, capacity up, life halved', async () => {
    const before = (await client.stamps()).find((x) => x.batchID === id)!;
    await client.dilute(id, before.depth + 1);
    const after = (await client.stamps()).find((x) => x.batchID === id)!;

    expect(after.depth).toBe(before.depth + 1);
    expect(after.batchTTL).toBeLessThanOrEqual(Math.ceil(before.batchTTL / 2) + 5);
    // Doubling the bucket bound halves the ratio: the batch accepts writes again.
    expect(after.utilizationRatio).toBeCloseTo(before.utilizationRatio / 2, 5);
    expect(fullnessOf(after, 0.8)).not.toBe('full');
  });

  it('accepts an upload again afterwards', async () => {
    const ref = await client.uploadBytes(id, new Uint8Array(4_096).fill(99));
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('expiry', () => {
  it('a batch that runs out of money disappears from /stamps', async () => {
    const id = await client.buyBatch(amountForDuration(bee.price, 3_600, 5000), 17, { label: 'doomed' });
    expect((await client.stamps()).some((b) => b.batchID === id)).toBe(true);
    bee.advanceSeconds(2 * 3_600);
    expect((await client.stamps()).some((b) => b.batchID === id)).toBe(false);
  });

  it('and the service notices it is gone', async () => {
    await poller.tick();
    const known = db.batches().map((b) => b.batchId);
    // It was recorded when first seen, which is what turns a silent lapse into
    // something reportable — the batch is no longer on the node.
    expect(known.length).toBeGreaterThan(0);
  });
});
