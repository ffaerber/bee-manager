/**
 * Issues #9 and #5 — check-then-act on the interactive paths.
 *
 * Both are races, so both are raced. The Bee here is slow on purpose: a fast
 * upstream closes the window and the test passes against broken code, which is
 * the trap the first #3 race test fell into.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';
import { PIPELINE_LIMITS } from '../src/quota';

const BATCH = 'cc'.repeat(32);
const ADMIN = 'test-admin';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;
let db: Db;
/** Every write Bee was asked to perform. */
let writes: string[] = [];
/** Milliseconds every Bee write takes, to hold the race window open. */
let writeDelayMs = 0;

const stamp = () => ({
  batchID: BATCH, utilization: 1, utilizationRatio: 0.25, usable: true, label: 'site',
  depth: 18, amount: '70820179200', bucketDepth: 16, blockNumber: 1,
  immutableFlag: false, exists: true, batchTTL: 60 * 60 * 24 * 20,
});

const base = () => `http://localhost:${monitor.server!.port}`;
const admin = (p: string, init: RequestInit = {}) =>
  fetch(base() + p, { ...init, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN, ...(init.headers ?? {}) } });

beforeEach(async () => {
  writes = []; writeDelayMs = 0;
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/stamps/topup/') || url.pathname.startsWith('/stamps/dilute/')) {
        writes.push(url.pathname);
        if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
        return Response.json({ batchID: BATCH });
      }
      if (req.method === 'POST' && (url.pathname === '/bzz' || url.pathname === '/bytes')) {
        writes.push(url.pathname);
        if (writeDelayMs) await new Promise((r) => setTimeout(r, writeDelayMs));
        return Response.json({ reference: 'ff'.repeat(32) });
      }
      if (url.pathname === '/stamps') return Response.json({ stamps: [stamp()] });
      if (url.pathname === `/stamps/${BATCH}`) return Response.json(stamp());
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({ bzzBalance: '100000000000000000000', nativeTokenBalance: '5000000000000000000' });
      }
      if (url.pathname === '/health') return Response.json({ status: 'ok', version: '2.8.1' });
      return Response.json({}, { status: 404 });
    },
  });

  const saved = { ...process.env };
  Object.assign(process.env, {
    BEE_URL: `http://127.0.0.1:${upstream.port}`, DB_PATH: ':memory:',
    AUTO_TOPUP_ENABLED: 'true', DRY_RUN: 'false',
    TOPUP_WHEN_TTL_BELOW_DAYS: '14', TOPUP_TARGET_TTL_DAYS: '60',
    MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '2000',
    MIN_WALLET_BZZ: '0', MIN_WALLET_XDAI: '0',
  });
  const cfg = loadConfig();
  process.env = saved;

  db = new Db(':memory:');
  const bee = new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: ADMIN });
  monitor.listen(0);
  await poller.tick();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 40));
  upstream?.stop(true); monitor?.stop?.(); db?.close?.();
});

describe('#9 — a double-click must not become a double spend', () => {
  it('accepts one concurrent manual top-up and refuses the rest', async () => {
    writeDelayMs = 200;
    const body = JSON.stringify({ days: 60, confirm: true });
    const [a, b, c] = await Promise.all([
      admin(`/api/admin/batches/${BATCH}/topup`, { method: 'POST', body }),
      admin(`/api/admin/batches/${BATCH}/topup`, { method: 'POST', body }),
      admin(`/api/admin/batches/${BATCH}/topup`, { method: 'POST', body }),
    ]);
    const codes = [a.status, b.status, c.status].sort();

    // Exactly one on-chain write, whatever the HTTP outcomes.
    expect(writes.filter((w) => w.includes('/topup/'))).toHaveLength(1);
    // One success, two refusals — and the refusal says why.
    expect(codes.filter((s) => s === 200)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(2);
    expect(db.recentActions(50).filter((r: any) => r.kind === 'topup')).toHaveLength(1);
  });

  it('refuses a manual dilute while a top-up is in flight', async () => {
    writeDelayMs = 200;
    const topup = admin(`/api/admin/batches/${BATCH}/topup`, {
      method: 'POST', body: JSON.stringify({ days: 60, confirm: true }),
    });
    await new Promise((r) => setTimeout(r, 40));
    const dilute = await admin(`/api/admin/batches/${BATCH}/dilute`, {
      method: 'POST', body: JSON.stringify({ depth: 19, confirm: true }),
    });
    // Dilution is irreversible; doing it under an in-flight top-up is worse
    // than refusing once.
    expect(dilute.status).toBe(409);
    await topup;
    expect(writes.filter((w) => w.includes('/dilute/'))).toHaveLength(0);
  });

  it('lets a second top-up through once the first has settled', async () => {
    writeDelayMs = 0;
    const body = JSON.stringify({ days: 60, confirm: true });
    const first = await admin(`/api/admin/batches/${BATCH}/topup`, { method: 'POST', body });
    expect(first.status).toBe(200);
    // Sequential, not concurrent — the lock must not be sticky.
    const second = await admin(`/api/admin/batches/${BATCH}/topup`, { method: 'POST', body });
    expect(second.status).not.toBe(409);
  });
});

describe('#5 — concurrent uploads must not overshoot the daily budget', () => {
  /** Issue an app key and point an app at the batch. */
  async function appKey(): Promise<string> {
    const r = await admin(`/api/admin/batches/${BATCH}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'site' }),
    });
    const j: any = await r.json();
    if (!j?.key) throw new Error(`key issue failed: ${r.status} ${JSON.stringify(j)}`);
    return j.key;
  }

  it('does not let parallel uploads all pass the same pre-upload totals', async () => {
    const key = await appKey();
    writeDelayMs = 120;

    /**
     * Raced on the UPLOAD COUNT rather than on bytes.
     *
     * Both dimensions go through the same reservation, and the byte budget for
     * an API key is 256 MB — allocating that in a test to prove a point is
     * silly when the count limit is 50 and a 1 kB body costs nothing.
     */
    const limit = PIPELINE_LIMITS.addressDailyUploads;
    const attempts = limit + 20;
    const payload = new Uint8Array(1024);

    const results = await Promise.all(Array.from({ length: attempts }, () =>
      fetch(`${base()}/bytes`, {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/octet-stream' },
        body: payload,
      }).then((r) => r.status).catch(() => 0)));

    const accepted = results.filter((s) => s === 200).length;

    // The cap must hold under concurrency. Before the fix every request read
    // the same pre-upload count of 0 and all of them passed.
    expect(accepted).toBeLessThanOrEqual(limit);
    expect(accepted).toBeGreaterThan(0);
    // The ledger must agree with what Bee was actually asked to store.
    expect(writes.filter((w) => w === '/bytes')).toHaveLength(accepted);
    // Quota is accounted per KEY, not per batch: an API key resolves to the
    // app name `key:<name>`, so revoking one key cannot spend another's
    // budget. Asserted explicitly because it is the scope the cap applies to.
    expect(db.uploadCount('key:site')).toBe(accepted);
  });

  it('claims byte budgets atomically too', () => {
    // The bytes dimension, exercised directly so the limit can be small.
    const limits = { appDailyBytes: 1000, addressDailyBytes: 1000, addressDailyUploads: 100 };
    const ids = Array.from({ length: 5 }, () => db.reserveUpload('site', '0xabc', 300, limits));
    // 3 x 300 fits in 1000; the fourth and fifth must be refused.
    expect(ids.filter((i) => i != null)).toHaveLength(3);
    expect(db.bytesUploaded('site')).toBe(900);
  });

  it('counts a reservation against the budget the moment it is made', () => {
    const limits = { appDailyBytes: 1000, addressDailyBytes: 1000, addressDailyUploads: 100 };
    const id = db.reserveUpload('site', '0xabc', 600, limits);
    expect(id).not.toBeNull();
    // Not yet finalised, but already spending budget — that is the point.
    expect(db.bytesUploaded('site')).toBe(600);
    expect(db.reserveUpload('site', '0xabc', 600, limits)).toBeNull();
    db.releaseUpload(id!);
    expect(db.reserveUpload('site', '0xabc', 600, limits)).not.toBeNull();
  });

  it('gives the budget back when the upload fails', async () => {
    const key = await appKey();
    const before = db.bytesUploaded('site');
    // Point Bee's write at a 404 so the upload throws.
    upstream.stop(true);
    upstream = Bun.serve({ port: upstream.port, fetch: () => Response.json({}, { status: 500 }) });

    const r = await fetch(`${base()}/bytes`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(1024),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    // A failed upload stored nothing and must not consume quota, or a flapping
    // client locks itself out of a budget it never used.
    expect(db.bytesUploaded('site')).toBe(before);
  });
});
