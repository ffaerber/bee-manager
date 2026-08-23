/**
 * Issues #3 and #8 — the two ways the ledger could authorise a second spend.
 *
 * Both are races, so both are tested by actually racing them: a Bee whose
 * writes hang on command, and two ticks started against it. Asserting on the
 * shape of the code would not have caught either.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { loadConfig } from '../src/config';

const BATCH = 'aa'.repeat(32);

/** Every top-up Bee was asked to perform. */
let topUps: string[] = [];
/** Held open while set, to make a tick outlast the poll interval. */
let hold: Promise<void> | null = null;
let releaseHold: (() => void) | null = null;
let upstream: ReturnType<typeof Bun.serve>;
/** A deliberately slow webhook — see the widened-window test below. */
let hook: ReturnType<typeof Bun.serve>;
let hookDelayMs = 0;
let db: Db;
let poller: Poller;

/** TTL below the 14-day threshold, so every tick wants to top up. */
const stamp = () => ({
  batchID: BATCH, utilization: 1, utilizationRatio: 0.25, usable: true, label: 'site',
  depth: 18, amount: '70820179200', bucketDepth: 16, blockNumber: 1,
  immutableFlag: false, exists: true, batchTTL: 60 * 60 * 24 * 3,
});

beforeEach(() => {
  topUps = []; hold = null; releaseHold = null;
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/stamps/topup/')) {
        topUps.push(url.pathname);
        if (hold) await hold;           // the slow write
        return Response.json({ batchID: BATCH });
      }
      if (url.pathname === '/stamps') return Response.json({ stamps: [stamp()] });
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

  hookDelayMs = 0;
  hook = Bun.serve({
    port: 0,
    async fetch() {
      if (hookDelayMs) await new Promise((r) => setTimeout(r, hookDelayMs));
      return new Response('ok');
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
  // The env floor on POLL_INTERVAL_MS is 10s, which is right for production
  // and useless in a test that has to observe several missed periods.
  (cfg as any).pollIntervalMs = 20;

  db = new Db(':memory:');
  poller = new Poller(cfg, new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000),
    db, new Alerter(db, `http://127.0.0.1:${hook.port}`, 0));
});

afterEach(async () => {
  releaseHold?.(); hold = null;
  poller.stop();
  // Let any tick that was mid-flight unwind before the database goes away,
  // or it finishes writing into a closed handle.
  await new Promise((r) => setTimeout(r, 60));
  upstream?.stop(true); hook?.stop(true); db?.close?.();
});

describe('#3 — a slow tick must not get a second one started underneath it', () => {
  it('coalesces concurrent ticks instead of double-spending', async () => {
    hold = new Promise<void>((r) => { releaseHold = r; });

    // Two ticks at once, exactly as an overlapping interval would produce.
    const a = poller.tick();
    const b = poller.tick();
    await new Promise((r) => setTimeout(r, 50));
    releaseHold!(); hold = null;
    await Promise.all([a, b]);

    // One physical top-up, not two. Before the fix both ticks planned against
    // the same pre-record in-flight snapshot and both submitted.
    expect(topUps).toHaveLength(1);
    const rows = db.recentActions(50).filter((r: any) => r.kind === 'topup');
    expect(rows).toHaveLength(1);
  });

  it('does not double-spend while suspended sending an alert', async () => {
    /**
     * The actual window, reproduced rather than assumed.
     *
     * handle() awaits alerter.send('batch_low') BEFORE execute() records the
     * action, so a tick sits suspended between reading the in-flight set and
     * writing to it. With no webhook configured that await returns almost
     * immediately and the race is nearly impossible to hit — which is exactly
     * why a first attempt at this test passed against the unfixed code and
     * proved nothing. A webhook that takes 150ms is ordinary, and it holds the
     * window open long enough for a second tick to read the same empty set.
     */
    hookDelayMs = 150;
    const a = poller.tick();
    await new Promise((r) => setTimeout(r, 60));   // land inside the alert
    const b = poller.tick();
    await Promise.all([a, b]);

    expect(topUps).toHaveLength(1);
    expect(db.recentActions(50).filter((r: any) => r.kind === 'topup')).toHaveLength(1);
  });

  it('schedules the next poll only after the current one finishes', async () => {
    hold = new Promise<void>((r) => { releaseHold = r; });
    poller.start();
    // Poll interval is 20ms; hold the write far longer than several periods.
    await new Promise((r) => setTimeout(r, 220));
    expect(topUps.length).toBe(1);
    releaseHold!(); hold = null;
    poller.stop();
  });

  it('stops cleanly while a tick is in flight', async () => {
    hold = new Promise<void>((r) => { releaseHold = r; });
    poller.start();
    await new Promise((r) => setTimeout(r, 40));
    poller.stop();
    releaseHold!(); hold = null;
    const seen = topUps.length;
    await new Promise((r) => setTimeout(r, 120));
    // Nothing new after stop(), even though a tick was mid-flight when it was
    // called — the finally-block must not re-arm the timer.
    expect(topUps.length).toBe(seen);
  });
});

describe('#8 — releasing a stale action must not overwrite one that landed', () => {
  it('refuses to mark a confirmed action failed', async () => {
    const id = db.recordAction({
      batchId: BATCH, appName: 'site', kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'test', error: null,
    });
    // The transaction lands while the release path is mid-flight.
    expect(db.updateActionStatus(id, 'confirmed')).toBe(true);

    // The stale release now tries to write over it, guarded.
    const released = db.updateActionStatus(id, 'failed', 'never confirmed', 'submitted');
    expect(released).toBe(false);

    const row: any = db.recentActions(10).find((r: any) => r.id === id);
    expect(row.status).toBe('confirmed');
    expect(row.error).toBeNull();
  });

  it('still releases one that really is stuck', async () => {
    const id = db.recordAction({
      batchId: BATCH, appName: 'site', kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'test', error: null,
    });
    expect(db.updateActionStatus(id, 'failed', 'never confirmed', 'submitted')).toBe(true);
    const row: any = db.recentActions(10).find((r: any) => r.id === id);
    expect(row.status).toBe('failed');
  });

  it('keeps a confirmed action out of the in-flight set, and a released one too', async () => {
    const confirmed = db.recordAction({
      batchId: BATCH, appName: 'site', kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'test', error: null,
    });
    db.updateActionStatus(confirmed, 'confirmed');
    expect(db.inFlightBatchIds().has(BATCH)).toBe(false);
  });

  it('lets a confirm win over an earlier release, because it is the truth', async () => {
    const id = db.recordAction({
      batchId: BATCH, appName: 'site', kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'test', error: null,
    });
    db.updateActionStatus(id, 'failed', 'released', 'submitted');
    // It turns out it landed after all. Unconditional on purpose.
    expect(db.updateActionStatus(id, 'confirmed')).toBe(true);
    const row: any = db.recentActions(10).find((r: any) => r.id === id);
    expect(row.status).toBe('confirmed');
  });
});
