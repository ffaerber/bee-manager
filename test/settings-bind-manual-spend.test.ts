/**
 * A cap edited on the Settings page must bind the paths a human drives.
 *
 * It did not. The poller read `applySettings(cfg, db.settings())`, but the buy
 * wizard and the manual top-up both read the raw env `cfg`, so the Settings
 * page bound the daemon and neither manual path. Found by raising the per-batch
 * cap to buy a batch, having the PATCH report `applied: {maxTopupBzzPerBatch:
 * 30}`, and then watching the buy refuse at the old env value of 5.
 *
 * The loosening direction merely annoys. The dangerous one is TIGHTENING: a cap
 * lowered to hold something back kept displaying the stricter number while
 * still permitting the looser env value — a guard that reads as armed and is
 * not. That is the case asserted here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';

const BATCH = 'cc'.repeat(32);
const ADMIN = 'test-admin';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;
let db: Db;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stamps') {
        return Response.json({
          stamps: [{
            batchID: BATCH, utilization: 1, utilizationRatio: 0.25, usable: true,
            label: 'existing', depth: 18, amount: '70820179200', bucketDepth: 16,
            blockNumber: 1, immutableFlag: false, exists: true, batchTTL: 4_838_400,
          }],
        });
      }
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({
          bzzBalance: '100000000000000000000', nativeTokenBalance: '5000000000000000000',
          chainID: 100, walletAddress: '0x1', chequebookContractAddress: '0x2',
        });
      }
      return Response.json({ status: 'ok' });
    },
  });

  db = new Db(':memory:');
  // Env permits a large per-action spend; the stored setting will tighten it.
  const cfg = loadConfig({
    BEE_URL: `http://localhost:${upstream.port}`,
    MAX_TOPUP_BZZ_PER_BATCH: '50',
    MAX_TOPUP_BZZ_PER_DAY: '50',
    MIN_WALLET_BZZ: '0',
    MIN_WALLET_XDAI: '0',
    DRY_RUN: 'false',
  } as any);
  const bee = new BeeClient(cfg.beeUrl, 5000, 5000, 5000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  await poller.tick();
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: ADMIN });
  monitor.listen(0);
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(() => { upstream?.stop(true); monitor?.stop?.(); });

const post = (path: string, body: unknown) =>
  fetch(`http://localhost:${monitor.server!.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
    body: JSON.stringify(body),
  });

/** A depth-18 year costs ~11.9 xBZZ: comfortably inside 50, well outside 1. */
const buy = (confirm: boolean) =>
  post('/api/admin/wizard/buy', { depth: 18, days: 365, label: 'probe', immutable: false, confirm });

describe('a tightened cap binds the buy wizard', () => {
  it('permits the buy while only the loose env cap applies', async () => {
    const preview = await (await buy(false)).json();
    // Sanity: the quote sits between the tightened and the env cap, so the
    // assertions below distinguish the two rather than passing either way.
    expect(preview.preview.costBzz).toBeGreaterThan(1);
    expect(preview.preview.costBzz).toBeLessThan(50);
  });

  it('refuses once the setting tightens it, rather than using the env value', async () => {
    db.setSetting('maxTopupBzzPerBatch', '1');
    const res = await buy(true);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/per-action cap/);
  });

  it('and the daily cap tightens the same way', async () => {
    db.setSetting('maxTopupBzzPerBatch', '50');
    db.setSetting('maxTopupBzzPerDay', '1');
    const res = await buy(true);
    expect(res.status).toBe(403);
  });
});

describe('a tightened cap binds the manual top-up', () => {
  it('refuses a top-up the env config alone would have allowed', async () => {
    db.setSetting('maxTopupBzzPerBatch', '1');
    db.setSetting('maxTopupBzzPerDay', '50');
    const res = await post(`/api/admin/batches/${BATCH}/topup`, { days: 400 });
    const body = await res.json();
    // The preview reports the verdict rather than 403-ing, so assert on it.
    expect(body.preview.allowed).toBe(false);
    expect(body.preview.reason).toMatch(/cap/);
  });
});
