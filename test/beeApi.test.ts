import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Bee } from '@ethersphere/bee-js';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';
import { hashApiKey } from '../src/auth';

const REF = 'f30dbdffbfff1d0c00aab04f512c85db917ce2d4ae1be71a4dcdcb311a6e70ac';
const BATCH = '7cab9c13e491b58ff4b6673190db8cf5c859ffb01a39cb05202cfcfff157e8ac';
const KEY = 'test-deploy-key';
const ADMIN = 'test-admin-token';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;
let bee: Bee;
let seen: { batchId?: string | null; path?: string } = {};

beforeAll(async () => {
  // Stand-in for the Bee node.
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen = { batchId: req.headers.get('swarm-postage-batch-id'), path: url.pathname };
      if (url.pathname.startsWith('/bytes/') || url.pathname.startsWith('/bzz/')) {
        return new Response('hello swarm', { headers: { 'content-type': 'text/plain' } });
      }
      if (req.method === 'POST') return Response.json({ reference: REF });
      return Response.json({ stamps: [] });
    },
  });

  const db = new Db(':memory:');
  db.upsertApp({
    name: 'pinkchainsaw', policy: 'ephemeral', depth: 17, durationDays: 60,
    batchId: BATCH, budgetPlurPerDay: 0n, ensName: null,
    apiKeyHash: await hashApiKey(KEY),
  });

  const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}` } as any);
  const client = new BeeClient(cfg.beeUrl, 5000, 5000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, client, db, alerter);
  // Pretend a poll happened, with the app's batch present.
  (poller as any).last = {
    ok: true, plans: [], msPerBlock: 5000, burnPer30DaysBzz: 0, runwayDays: 999,
    batches: [{
      batchID: BATCH, utilization: 1, utilizationRatio: 0.004, usable: true, label: 't4t-v3',
      depth: 18, amount: 100n, bucketDepth: 16, blockNumber: 1, immutableFlag: false,
      exists: true, batchTTL: 5_184_000,
    }],
  };

  monitor = createServer({ cfg, bee: client, db, alerter, poller, adminToken: ADMIN });
  monitor.listen(0);
  await new Promise((r) => setTimeout(r, 150));

  bee = new Bee(`http://localhost:${monitor.server!.port}`, { headers: { 'x-api-key': KEY } });
});

afterAll(() => { upstream?.stop(true); monitor?.stop?.(); });

describe('an unmodified bee-js client can drive the monitor', () => {
  // bee-js probes the BASE URL root for this, not /health — verified against
  // bee-js v11. The root must answer 200 whether or not the dashboard is built.
  it('isConnected() succeeds', async () => {
    expect(await bee.isConnected()).toBe(true);
  });

  it('uploadData() returns a reference', async () => {
    const r = await bee.uploadData(BATCH, new TextEncoder().encode('hello swarm'));
    expect(r.reference.toString()).toBe(REF);
  });

  it('substitutes the app batch and IGNORES the one the caller passed', async () => {
    await bee.uploadData('00'.repeat(32), new TextEncoder().encode('x'));
    // Whatever bee-js sent, the node saw the app's real batch.
    expect(seen.batchId).toBe(BATCH);
  });

  it('downloadData() proxies through to the node', async () => {
    const d = await bee.downloadData(REF);
    expect(d.toUtf8()).toBe('hello swarm');
  });

  it('getAllPostageBatch() shows the app its own batch', async () => {
    const b = await bee.getAllPostageBatch();
    expect(b).toHaveLength(1);
    expect(b[0].batchID.toString()).toBe(BATCH);
    expect(b[0].usable).toBe(true);
  });

  it('rejects a client with no key, in Bee error shape', async () => {
    const anon = new Bee(`http://localhost:${monitor.server!.port}`);
    await expect(anon.uploadData(BATCH, new TextEncoder().encode('x'))).rejects.toThrow();
  });

  it('passes through to arbitrary node endpoints with the admin token', async () => {
    const res = await fetch(`http://localhost:${monitor.server!.port}/chainstate`, {
      headers: { 'x-admin-token': ADMIN },
    });
    expect(res.status).toBe(200);
    expect(seen.path).toBe('/chainstate');
  });

  it('an app key alone cannot reach the passthrough', async () => {
    const res = await fetch(`http://localhost:${monitor.server!.port}/wallet`, {
      headers: { 'x-api-key': KEY },
    });
    expect(res.status).toBe(401);
  });

  it('never hands the monitor its own paths to the node', async () => {
    for (const p of ['/api/admin/state', '/health']) {
      const res = await fetch(`http://localhost:${monitor.server!.port}${p}`);
      // Handled by the monitor (200 or its own 401) — never proxied upstream.
      expect(seen.path).not.toBe(p);
      expect([200, 401, 404, 503]).toContain(res.status);
    }
  });

  it('rejects a wrong key', async () => {
    const bad = new Bee(`http://localhost:${monitor.server!.port}`, { headers: { 'x-api-key': 'nope' } });
    await expect(bad.uploadData(BATCH, new TextEncoder().encode('x'))).rejects.toThrow();
  });
});
