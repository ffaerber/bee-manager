/**
 * Manual actions work on an unmanaged batch, and say so.
 *
 * `managed` governs AUTOMATION — whether the poller acts on its own. It does
 * not govern whether a human may act. An earlier version of this file asserted
 * the opposite, blocking manual top-up and dilution with a 409; that conflated
 * the two and removed the case that most needs them, keeping a superseded batch
 * alive by hand while migrating off it.
 *
 * The guard was a reaction to a 63 xBZZ mistake whose real causes were a cap
 * sized for a batch that no longer needed it and a confirm:true sent as a test.
 * Both were fixed directly. What remains here is that the preview SAYS the
 * batch is unmanaged, so spending on one is a visible decision.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';

const MANAGED = 'aa'.repeat(32);
const LAPSING = 'bb'.repeat(32);
const ADMIN = 'test-admin';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;

const stamp = (id: string, label: string) => ({
  batchID: id, utilization: 1, utilizationRatio: 0.25, usable: true, label,
  depth: 18, amount: '70820179200', bucketDepth: 16, blockNumber: 1,
  immutableFlag: false, exists: true, batchTTL: 4_838_400,
});

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/stamps') {
        return Response.json({ stamps: [stamp(MANAGED, 'keep'), stamp(LAPSING, 'lapsing')] });
      }
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({
          bzzBalance: '5000000000000000000', nativeTokenBalance: '5000000000000000000',
          chainID: 100, walletAddress: '0x1', chequebookContractAddress: '0x2',
        });
      }
      return Response.json({ status: 'ok' });
    },
  });

  const db = new Db(':memory:');
  const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}` } as any);
  const bee = new BeeClient(cfg.beeUrl, 5000, 5000, 5000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  await poller.tick();
  db.setManaged(LAPSING, false);
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: ADMIN });
  // Listen on a real port and use fetch, as the other server tests do:
  // Elysia's handle() did not route POSTs correctly in this harness.
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

describe('unmanaged batches accept manual actions', () => {
  it('previews a top-up', async () => {
    const res = await post(`/api/admin/batches/${LAPSING}/topup`, { days: 90 });
    expect(res.status).toBe(200);
    expect((await res.json()).preview).toBeTruthy();
  });

  it('flags the preview as unmanaged, so the UI can warn', () => {
    return post(`/api/admin/batches/${LAPSING}/topup`, { days: 90 })
      .then((r: Response) => r.json())
      .then((b: any) => expect(b.preview.unmanaged).toBe(true));
  });

  it('previews dilution', async () => {
    const res = await post(`/api/admin/batches/${LAPSING}/dilute`, { newDepth: 19 });
    expect(res.status).toBe(200);
    expect((await res.json()).preview.unmanaged).toBe(true);
  });

  it('does not flag a managed batch', async () => {
    const res = await post(`/api/admin/batches/${MANAGED}/topup`, { days: 90 });
    expect((await res.json()).preview.unmanaged).toBe(false);
  });

  it('still enforces the caps, which is the guard that matters', async () => {
    // The protection against overspending is the cap, not the managed flag.
    const res = await post(`/api/admin/batches/${LAPSING}/topup`, { days: 3650 });
    const body = await res.json();
    expect(body.preview.allowed).toBe(false);
    expect(body.preview.reason).toMatch(/cap/i);
  });
});

