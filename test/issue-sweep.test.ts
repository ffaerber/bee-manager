/**
 * Issues #4, #6, #7, #10, #11 and #12.
 *
 * Each one is tested against the behaviour it broke, not against the shape of
 * the fix — and each was run against the unfixed code first to confirm it
 * actually fails there.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { loadConfig } from '../src/config';
import { authenticate, signingMessage, MAX_SIGNATURE_AGE_MS, MAX_CLOCK_SKEW_MS } from '../src/auth';
import { Wallet } from 'ethers';

const BATCH = 'ee'.repeat(32);
const OTHER = 'ff'.repeat(32);

let db: Db;

beforeEach(() => { db = new Db(':memory:'); });
afterEach(() => { db?.close?.(); });

// ── #12 ───────────────────────────────────────────────────────────────────
describe('#12 — a buy has no batch id, so the guard must key on kind', () => {
  const buy = () => db.recordActionIfIdle({
    batchId: null, appName: 'site', kind: 'buy',
    amount: 1n, cost: 1n, status: 'submitted', reason: 'manual buy', error: null,
  });

  it('refuses a second concurrent buy', () => {
    expect(buy()).not.toBeNull();
    // Before the fix the guard read `WHERE batch_id = NULL`, which never
    // matches, so every buy was permitted and a double-click bought two
    // batches — neither refundable.
    expect(buy()).toBeNull();
  });

  it('allows another buy once the first settles', () => {
    const id = buy()!;
    db.updateActionStatus(id, 'confirmed');
    expect(buy()).not.toBeNull();
  });

  it('does not let a buy block an unrelated batch top-up', () => {
    buy();
    const topup = db.recordActionIfIdle({
      batchId: BATCH, appName: null, kind: 'topup',
      amount: 1n, cost: 1n, status: 'submitted', reason: 'x', error: null,
    });
    // Different scopes entirely — a pending purchase must not freeze renewals.
    expect(topup).not.toBeNull();
  });

  it('still scopes batch actions per batch', () => {
    expect(db.recordActionIfIdle({
      batchId: BATCH, appName: null, kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'x', error: null,
    })).not.toBeNull();
    expect(db.recordActionIfIdle({
      batchId: BATCH, appName: null, kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'x', error: null,
    })).toBeNull();
    expect(db.recordActionIfIdle({
      batchId: OTHER, appName: null, kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'x', error: null,
    })).not.toBeNull();
  });
});

// ── #7 ────────────────────────────────────────────────────────────────────
describe('#7 — signature age is directional, and a signature spends once', () => {
  const APP = 'site';
  const SHA = 'ab'.repeat(32);
  let signer: Wallet;
  let sig: string;
  const ts = 1_700_000_000_000;

  beforeEach(async () => {
    signer = Wallet.createRandom() as unknown as Wallet;
    sig = await signer.signMessage(signingMessage(APP, SHA, ts));
  });

  const req = (over: Record<string, unknown> = {}) => ({
    app: APP, contentSha256: SHA, address: signer.address, signature: sig, timestamp: ts, ...over,
  }) as any;

  it('accepts a fresh signature', async () => {
    const r = await authenticate(req(), null, ts + 1000);
    expect(r.ok).toBe(true);
  });

  it('rejects a timestamp from the future', async () => {
    // Math.abs used to accept this, doubling the window and permitting
    // pre-minted signatures.
    const r = await authenticate(req(), null, ts - (MAX_CLOCK_SKEW_MS + 60_000));
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/future/i);
  });

  it('tolerates ordinary clock skew', async () => {
    const r = await authenticate(req(), null, ts - (MAX_CLOCK_SKEW_MS - 5_000));
    expect(r.ok).toBe(true);
  });

  it('still rejects an expired signature', async () => {
    const r = await authenticate(req(), null, ts + MAX_SIGNATURE_AGE_MS + 1000);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/out of date/i);
  });

  it('lets a signature be spent exactly once', async () => {
    const consume = (h: string, e: number, n: number) => db.consumeSignature(h, e, n);
    const first = await authenticate(req(), null, ts + 1000, { consumeSignature: consume });
    expect(first.ok).toBe(true);
    // Replay of the identical captured tuple: same bytes, same window.
    const second = await authenticate(req(), null, ts + 2000, { consumeSignature: consume });
    expect(second.ok).toBe(false);
    expect((second as any).reason).toMatch(/already been used/i);
  });

  it('does not burn the slot on a bad signature', async () => {
    const consume = (h: string, e: number, n: number) => db.consumeSignature(h, e, n);
    const bad = await authenticate(req({ address: Wallet.createRandom().address }), null, ts + 1000,
      { consumeSignature: consume });
    expect(bad.ok).toBe(false);
    // The real one must still work — consumption happens only after the
    // signature verifies.
    const good = await authenticate(req(), null, ts + 1000, { consumeSignature: consume });
    expect(good.ok).toBe(true);
  });

  it('forgets signatures once they could no longer be valid', () => {
    expect(db.consumeSignature('h1', 1000, 500)).toBe(true);
    // Well past expiry: the row is pruned, and the hash is free again. It
    // could not be replayed anyway — the age check rejects it first.
    expect(db.consumeSignature('h2', 5000, 2000)).toBe(true);
    expect(db.consumeSignature('h1', 5000, 2000)).toBe(true);
  });
});

// ── #6 ────────────────────────────────────────────────────────────────────
describe('#6 — a failed webhook must not silence the next alert', () => {
  it('releases the dedup key when delivery fails', async () => {
    /**
     * The distinguishing assertion.
     *
     * Both a suppressed alert and a failed delivery return false, so comparing
     * return values proves nothing — my first attempt at this test passed
     * against the unfixed code for exactly that reason. What separates them is
     * whether the SAME key can still be delivered afterwards, so the webhook
     * is taken down, an alert is lost, the webhook comes back, and the
     * identical alert must get through.
     */
    let delivered = 0;
    // Claim a port, then free it — sends now fail the way a down webhook does.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    const port = probe.port ?? 0;
    probe.stop(true);

    const alerter = new Alerter(db, `http://127.0.0.1:${port}`, 60_000);
    const alert = {
      event: 'topup_failed' as const, level: 'warn' as const, batchId: BATCH,
      message: 'a top-up did not land',
    };

    expect(await alerter.send(alert)).toBe(false);   // webhook down, alert lost

    const hook = Bun.serve({ port, fetch() { delivered++; return new Response('ok'); } });
    try {
      // The same incident, inside the cooldown. With the dedup key left set by
      // a delivery that never happened, this one-shot alert about money would
      // be suppressed for the full hour and lost for good.
      expect(await alerter.send(alert)).toBe(true);
      expect(delivered).toBe(1);
    } finally {
      hook.stop(true);
    }
  });

  it('keeps deduping when delivery succeeds', async () => {
    let delivered = 0;
    const hook = Bun.serve({ port: 0, fetch() { delivered++; return new Response('ok'); } });
    const alerter = new Alerter(db, `http://127.0.0.1:${hook.port}`, 60_000);
    const alert = {
      event: 'batch_low' as const, level: 'warn' as const, batchId: BATCH, message: 'low',
    };
    expect(await alerter.send(alert)).toBe(true);
    // Second identical alert inside the cooldown is suppressed, as intended —
    // the fix must not turn the alerter into a firehose.
    expect(await alerter.send(alert)).toBe(false);
    expect(delivered).toBe(1);
    hook.stop(true);
  });
});

// ── #10 and #11 ───────────────────────────────────────────────────────────
describe('#10 / #11 — bad readings and stranded composites', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let stamps: any[] = [];
  let topUps: string[] = [];
  let dilutes: string[] = [];
  let poller: Poller;
  let alerts: string[] = [];

  const stamp = (id: string) => ({
    batchID: id, utilization: 1, utilizationRatio: 0.25, usable: true, label: 'site',
    depth: 18, amount: '70820179200', bucketDepth: 16, blockNumber: 1,
    immutableFlag: false, exists: true, batchTTL: 60 * 60 * 24 * 40,
  });

  beforeEach(async () => {
    stamps = [stamp(BATCH)]; topUps = []; dilutes = []; alerts = [];
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith('/stamps/topup/')) { topUps.push(url.pathname); return Response.json({ batchID: BATCH }); }
        if (url.pathname.startsWith('/stamps/dilute/')) { dilutes.push(url.pathname); return Response.json({ batchID: BATCH }); }
        if (url.pathname === '/stamps') return Response.json({ stamps });
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
      DILUTE_ENABLED: 'true', DILUTE_WHEN_UTILIZATION_ABOVE: '0.8',
    });
    const cfg = loadConfig();
    process.env = saved;

    const alerter = new Alerter(db, null, 0);
    const realSend = alerter.send.bind(alerter);
    alerter.send = async (a: any) => { alerts.push(a.event); return realSend(a); };
    poller = new Poller(cfg, new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000), db, alerter);
    await poller.tick();
  });

  afterEach(() => { poller.stop(); upstream?.stop(true); });

  it('#10 — does not declare every batch dead when /stamps comes back empty', async () => {
    expect(db.liveKnownBatchIds()).toContain(BATCH);
    alerts.length = 0;

    stamps = [];                 // a node restarting mid-sync looks exactly like this
    await poller.tick();

    // No storm, and above all no "your data is unrecoverable" for a batch that
    // is perfectly alive.
    expect(alerts.filter((e) => e === 'batch_disappeared')).toHaveLength(0);
    expect(db.liveKnownBatchIds()).toContain(BATCH);
  });

  it('#10 — still reports a single batch that genuinely expired', async () => {
    stamps = [stamp(BATCH), stamp(OTHER)];
    await poller.tick();
    alerts.length = 0;

    stamps = [stamp(BATCH)];     // one gone, the rest present
    await poller.tick();
    expect(alerts.filter((e) => e === 'batch_disappeared')).toHaveLength(1);
    expect(db.liveKnownBatchIds()).not.toContain(OTHER);
  });

  it('#4 — a dilute and its restore are one spend in the ledger, not two', async () => {
    // Depth 20, not 18: at depth 18 a bucket holds 4 chunks, and the shallow-
    // batch rule requires a genuinely full bucket (trigger 1.0) rather than a
    // ratio. Depth 20 is where the configured 0.8 threshold actually applies.
    stamps = [{ ...stamp(BATCH), depth: 20, utilizationRatio: 0.97, utilization: 63_000 }];
    await poller.tick();

    const rows = db.recentActions(50);
    const dilute = rows.find((r: any) => r.kind === 'dilute');
    const restore = rows.find((r: any) => r.kind === 'topup');
    expect(dilute).toBeTruthy();
    expect(restore).toBeTruthy();

    // Dilution moves no money — it spreads the same per-chunk amount over
    // twice the chunks. Only the restore is a spend, and the 24h ledger must
    // say so once. Before the fix both rows carried plan.cost and the daemon
    // throttled itself at half its configured budget.
    expect((dilute as any).cost).toBe(0n);
    expect(db.spentLast24h()).toBe((restore as any).cost);
    expect((restore as any).cost).toBeGreaterThan(0n);
    expect(dilutes).toHaveLength(1);
  });

  it('#11 — resumes a dilute whose restoring top-up never landed', async () => {
    // Exactly the state a crash between the two transactions leaves behind:
    // the dilute is done, the restore is not, and the batch is at half the TTL
    // it was paid for.
    const perChunk = 12345n;
    db.recordAction({
      batchId: BATCH, appName: null, kind: 'dilute', amount: perChunk, cost: 0n,
      status: 'awaiting-topup', reason: 'diluted, restore pending', error: null,
    });
    topUps.length = 0;

    await poller.tick();

    // Resumed on the very next poll, without waiting for TTL to fall under the
    // threshold — which for a 40d batch diluted to 20d would have been days.
    expect(topUps).toHaveLength(1);
    expect(db.awaitingTopup()).toHaveLength(0);
  });

  it('#11 — pays exactly the amount that was decided before the dilute', async () => {
    const perChunk = 987_654n;
    db.recordAction({
      batchId: BATCH, appName: null, kind: 'dilute', amount: perChunk, cost: 0n,
      status: 'awaiting-topup', reason: 'diluted, restore pending', error: null,
    });
    topUps.length = 0;
    await poller.tick();
    // Replanning against a chain state that has since moved would buy a
    // different amount of time than was intended and paid for.
    expect(topUps[0]).toContain(String(perChunk));
  });

  it('#11 — a stranded composite does not lock the batch out of the planner', async () => {
    db.recordAction({
      batchId: BATCH, appName: null, kind: 'dilute', amount: 1n, cost: 0n,
      status: 'awaiting-topup', reason: 'diluted, restore pending', error: null,
    });
    // `awaiting-topup` must not read as in-flight: that is what once locked a
    // batch out of the planner permanently and ran it to expiry.
    expect(db.inFlightBatchIds().has(BATCH)).toBe(false);
    await poller.tick();
    expect(db.awaitingTopup()).toHaveLength(0);
  });
});
