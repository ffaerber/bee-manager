/**
 * Issues #13, #14, #15, #16, #17 — the second-round findings, all of them in
 * code added by the first round.
 *
 * The resume path was written to rescue a batch stranded at half its TTL, and
 * in doing so it became the one place money moved without a cap check, without
 * an atomic claim, and against a snapshot it had itself invalidated. Fixing a
 * money bug by adding an unguarded spending path is worth a test each.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { loadConfig } from '../src/config';

const BATCH = 'ab'.repeat(32);
const PLUR_PER_BZZ = 10n ** 16n;

let upstream: ReturnType<typeof Bun.serve>;
let db: Db;
let poller: Poller;
let topUps: string[] = [];
let alerts: { event: string; message: string }[] = [];
let stamps: any[] = [];
let bzzBalance = '100000000000000000000';   // 10,000 xBZZ

/** Depth 20, healthy TTL, unless a test says otherwise. */
const stamp = (over: Record<string, unknown> = {}) => ({
  batchID: BATCH, utilization: 1, utilizationRatio: 0.25, usable: true, label: 'site',
  depth: 20, amount: '70820179200', bucketDepth: 16, blockNumber: 1,
  immutableFlag: false, exists: true, batchTTL: 60 * 60 * 24 * 20, ...over,
});

function boot(env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    BEE_URL: `http://127.0.0.1:${upstream.port}`, DB_PATH: ':memory:',
    AUTO_TOPUP_ENABLED: 'true', DRY_RUN: 'false',
    TOPUP_WHEN_TTL_BELOW_DAYS: '14', TOPUP_TARGET_TTL_DAYS: '60',
    MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '2000',
    MIN_WALLET_BZZ: '0', MIN_WALLET_XDAI: '0', ...env,
  });
  const cfg = loadConfig();
  process.env = saved;

  const alerter = new Alerter(db, null, 0);
  const real = alerter.send.bind(alerter);
  alerter.send = async (a: any) => { alerts.push({ event: a.event, message: a.message }); return real(a); };
  return new Poller(cfg, new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000), db, alerter);
}

/** The exact state a crash between dilute and restore leaves behind. */
const strand = (perChunk: bigint) => db.recordAction({
  batchId: BATCH, appName: null, kind: 'dilute', amount: perChunk, cost: 0n,
  status: 'awaiting-topup', reason: 'diluted, restore pending', error: null,
});

beforeEach(() => {
  topUps = []; alerts = []; stamps = [stamp()];
  bzzBalance = '100000000000000000000';
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/stamps/topup/')) {
        topUps.push(url.pathname);
        // A restored batch reads back at the target TTL.
        stamps = [stamp({ batchTTL: 60 * 60 * 24 * 60 })];
        return Response.json({ batchID: BATCH });
      }
      if (url.pathname === '/stamps') return Response.json({ stamps });
      if (url.pathname === `/stamps/${BATCH}`) return Response.json(stamps[0] ?? stamp());
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({ bzzBalance, nativeTokenBalance: '5000000000000000000' });
      }
      if (url.pathname === '/health') return Response.json({ status: 'ok', version: '2.8.1' });
      return Response.json({}, { status: 404 });
    },
  });
  db = new Db(':memory:');
  poller = boot();
});

afterEach(() => { poller?.stop(); upstream?.stop(true); db?.close?.(); });

describe('#13 — the resume path is not exempt from the spend guards', () => {
  it('refuses to resume when the wallet is below its floor', async () => {
    bzzBalance = String(1n * PLUR_PER_BZZ);          // 1 xBZZ left
    poller = boot({ MIN_WALLET_BZZ: '50' });         // floor far above it
    strand(50_000_000n);

    await poller.tick();

    // Caps were checked before the crash; the wallet can have been drained by
    // anything since. Nothing may be spent without re-checking.
    expect(topUps).toHaveLength(0);
    expect(alerts.some((a) => a.event === 'topup_blocked')).toBe(true);
    // Still pending, so it resumes once the wallet recovers.
    expect(db.awaitingTopup()).toHaveLength(1);
  });

  it('refuses to resume beyond the per-action cap', async () => {
    poller = boot({ MAX_TOPUP_BZZ_PER_BATCH: '0.0001' });
    strand(50_000_000n);
    await poller.tick();
    expect(topUps).toHaveLength(0);
    expect(alerts.some((a) => a.event === 'topup_blocked')).toBe(true);
  });

  it('resumes normally when the guards allow it', async () => {
    strand(50_000_000n);
    await poller.tick();
    expect(topUps).toHaveLength(1);
    expect(db.awaitingTopup()).toHaveLength(0);
  });

  it('records the real cost, so a resumed spend is visible to the daily cap', async () => {
    strand(50_000_000n);
    await poller.tick();
    const row: any = db.recentActions(20).find((r: any) => r.kind === 'topup');
    // Recording 0 kept a real, landed spend out of spentLast24h entirely.
    expect(row.cost).toBeGreaterThan(0n);
    expect(db.spentLast24h()).toBe(row.cost);
  });

  it('gives up on a batch that no longer exists rather than paying into it', async () => {
    stamps = [];                    // expired while the restore was outstanding
    strand(50_000_000n);
    await poller.tick();
    expect(topUps).toHaveLength(0);
    expect(db.awaitingTopup()).toHaveLength(0);
    const row: any = db.recentActions(20).find((r: any) => r.kind === 'dilute');
    expect(row.status).toBe('failed');
  });
});

describe('#14 — a resume must not leave a stale snapshot to plan against', () => {
  it('does not top up twice in the tick that resumes', async () => {
    // TTL below the threshold is what makes this dangerous: the pre-resume
    // snapshot says "needs a top-up", and the resume has just given it one.
    stamps = [stamp({ batchTTL: 60 * 60 * 24 * 3 })];
    strand(50_000_000n);

    await poller.tick();

    // Exactly one. The in-flight guard cannot catch this on its own — the
    // resume row is `confirmed` by the time evaluateAll runs, so a planned
    // duplicate would be claimed and submitted.
    expect(topUps).toHaveLength(1);
    expect(db.recentActions(50).filter((r: any) => r.kind === 'topup')).toHaveLength(1);
  });

  it('still tops up normally on a later tick if it is genuinely needed', async () => {
    stamps = [stamp({ batchTTL: 60 * 60 * 24 * 3 })];
    await poller.tick();          // nothing stranded; ordinary low-TTL top-up
    expect(topUps.length).toBeGreaterThan(0);
  });
});

describe('#15 — the resume claims the batch like every other spender', () => {
  it('skips while another action is already in flight for that batch', async () => {
    // An operator topping this batch up from the dashboard.
    db.recordAction({
      batchId: BATCH, appName: null, kind: 'topup', amount: 1n, cost: 1n,
      status: 'submitted', reason: 'manual', error: null,
    });
    strand(50_000_000n);

    await poller.tick();

    expect(topUps).toHaveLength(0);
    // Not lost — still pending for the next tick, once the manual one settles.
    expect(db.awaitingTopup()).toHaveLength(1);
  });
});

describe('#16 — reservations must not survive the process that made them', () => {
  it('releases budget held by a reservation from a dead process', () => {
    const limits = { appDailyBytes: 1000, addressDailyBytes: 1000, addressDailyUploads: 100 };
    // A reservation made 'before boot', i.e. by a process that was killed
    // between reserving and releasing.
    const id = db.reserveUpload('site', '0xabc', 900, limits, 86_400_000, 1_000);
    expect(id).not.toBeNull();
    expect(db.bytesUploaded('site', 86_400_000, undefined, 1_000)).toBe(900);

    expect(db.clearStaleReservations(2_000)).toBe(1);
    // The budget is back: nothing was stored, so nothing should have been held.
    expect(db.bytesUploaded('site', 86_400_000, undefined, 2_000)).toBe(0);
  });

  it('leaves an upload that is still in flight alone', () => {
    const limits = { appDailyBytes: 1000, addressDailyBytes: 1000, addressDailyUploads: 100 };
    const id = db.reserveUpload('site', '0xabc', 500, limits, 86_400_000, 5_000);
    expect(id).not.toBeNull();
    // Boot was BEFORE this reservation, so it belongs to the running process.
    // Deleting it would hand the same budget out twice.
    expect(db.clearStaleReservations(1_000)).toBe(0);
    expect(db.bytesUploaded('site', 86_400_000, undefined, 5_000)).toBe(500);
  });

  it('never touches a completed upload', () => {
    db.recordUpload('site', '0xabc', 400, 'cc'.repeat(32), {}, 1_000);
    expect(db.clearStaleReservations(9_999)).toBe(0);
    expect(db.bytesUploaded('site', 86_400_000, undefined, 2_000)).toBe(400);
  });
});

describe('#17 — spending a signature is one transaction', () => {
  it('still claims exactly once', () => {
    expect(db.consumeSignature('sig-a', 10_000, 1_000)).toBe(true);
    expect(db.consumeSignature('sig-a', 10_000, 1_000)).toBe(false);
  });

  it('prunes and claims atomically under a shared clock', () => {
    expect(db.consumeSignature('old', 2_000, 1_000)).toBe(true);
    // Past its expiry: pruned, and the claim for a different hash still works.
    expect(db.consumeSignature('new', 20_000, 5_000)).toBe(true);
    expect(db.consumeSignature('new', 20_000, 5_000)).toBe(false);
  });
});
