/**
 * A dilute that cannot succeed must not be resent every poll.
 *
 * Seen live: pinkchainsaw-v2 was diluted to depth 18 on chain, but Bee's
 * /stamps kept reporting 17. Read at depth 17 the batch was 100% full, so each
 * 5-minute tick planned a dilute to 18 and sent it, and the contract reverted
 * every one — for over three weeks — because increaseDepth only accepts an
 * increase. The planner is stateless, so nothing ever stopped it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { loadConfig } from '../src/config';

const BATCH = 'cd'.repeat(32);

let upstream: ReturnType<typeof Bun.serve>;
let db: Db;
let poller: Poller;
let dilutes: string[] = [];
let alerts: { event: string; message: string }[] = [];
/** What /stamps (Bee's local issuer) reports. */
let localDepth = 17;
/** What /batches (the chain) reports. */
let chainDepth: number | null = 18;
/** Whether the next dilute succeeds or reverts. */
let diluteReverts = false;

/** Full at its local depth: the fullest bucket is at capacity. */
const stamp = () => ({
  batchID: BATCH, utilization: 2 ** (localDepth - 16), utilizationRatio: 1, usable: true,
  label: 'pinkchainsaw-v2', depth: localDepth, amount: '70820179200', bucketDepth: 16,
  blockNumber: 1, immutableFlag: false, exists: true, batchTTL: 60 * 60 * 24 * 10,
});

function boot() {
  const saved = { ...process.env };
  Object.assign(process.env, {
    BEE_URL: `http://127.0.0.1:${upstream.port}`, DB_PATH: ':memory:',
    AUTO_TOPUP_ENABLED: 'true', DRY_RUN: 'false',
    TOPUP_WHEN_TTL_BELOW_DAYS: '2', TOPUP_TARGET_TTL_DAYS: '60',
    DILUTE_WHEN_UTILIZATION_ABOVE: '0.9',
    MAX_TOPUP_BZZ_PER_BATCH: '500', MAX_TOPUP_BZZ_PER_DAY: '2000',
    MIN_WALLET_BZZ: '0', MIN_WALLET_XDAI: '0',
  });
  const cfg = loadConfig();
  process.env = saved;

  const alerter = new Alerter(db, null, 0);
  const real = alerter.send.bind(alerter);
  alerter.send = async (a: any) => { alerts.push({ event: a.event, message: a.message }); return real(a); };
  return new Poller(cfg, new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000), db, alerter);
}

beforeEach(() => {
  dilutes = []; alerts = [];
  localDepth = 17; chainDepth = 18; diluteReverts = false;
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/stamps/dilute/')) {
        dilutes.push(url.pathname);
        if (diluteReverts) return Response.json({ code: 400, message: 'cannot dilute batch' }, { status: 400 });
        localDepth = Number(url.pathname.split('/').pop());
        chainDepth = localDepth;
        return Response.json({ batchID: BATCH });
      }
      if (url.pathname.startsWith('/stamps/topup/')) return Response.json({ batchID: BATCH });
      if (url.pathname === '/stamps') return Response.json({ stamps: [stamp()] });
      if (url.pathname === `/stamps/${BATCH}`) return Response.json(stamp());
      if (url.pathname === '/batches') {
        return Response.json({ batches: chainDepth == null ? [] : [{
          batchID: BATCH, value: '1', start: 1, owner: 'aa', depth: chainDepth, bucketDepth: 16,
          immutable: false, batchTTL: 60 * 60 * 24 * 10,
        }] });
      }
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({ bzzBalance: '100000000000000000000', nativeTokenBalance: '5000000000000000000' });
      }
      if (url.pathname === '/health') return Response.json({ status: 'ok', version: '2.8.2' });
      return Response.json({}, { status: 404 });
    },
  });
  db = new Db(':memory:');
  poller = boot();
});

afterEach(() => { poller?.stop(); upstream?.stop(true); db?.close?.(); });

describe('dilute guards', () => {
  it('does not dilute when the chain already has the batch at the target depth', async () => {
    localDepth = 17; chainDepth = 18;          // Bee stale by one step

    await poller.tick();
    await poller.tick();

    expect(dilutes).toHaveLength(0);
    expect(alerts.some((a) => a.event === 'depth_stale' && a.message.includes('depth 18 on chain'))).toBe(true);
  });

  it('does not resend a dilute that just failed', async () => {
    localDepth = 17; chainDepth = 17;          // consistent, but the tx reverts
    diluteReverts = true;

    await poller.tick();
    await poller.tick();
    await poller.tick();

    expect(dilutes).toHaveLength(1);
    const row: any = db.recentActions(20).find((r: any) => r.kind === 'dilute');
    expect(row.status).toBe('failed');
  });

  it('still dilutes a full batch whose depth agrees with the chain', async () => {
    localDepth = 17; chainDepth = 17;

    await poller.tick();

    expect(dilutes).toEqual([`/stamps/dilute/${BATCH}/18`]);
  });

  it('is not blocked by an unreadable /batches alone', async () => {
    localDepth = 17; chainDepth = null;        // batch missing from /batches

    await poller.tick();

    expect(dilutes).toHaveLength(1);
  });
});
