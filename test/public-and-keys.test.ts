/**
 * The three tiers, and the lines between them.
 *
 *   anonymous    read the node and its batches, and nothing else
 *   api key      upload to ONE batch, revocable on its own
 *   admin token  everything, including issuing keys
 *
 * The public tier is the one worth testing hardest: it is reachable by anyone
 * on the internet, and it fronts a service that spends money. The assertions
 * below are mostly about what is ABSENT — a leak here is a field quietly
 * appearing in a payload, not a route anyone opened on purpose.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';

const BATCH = 'dd'.repeat(32);
const OTHER = 'ee'.repeat(32);
const ADMIN = 'test-admin';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;
let db: Db;
const uploads: { batch: string; bytes: number }[] = [];

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
        return Response.json({ stamps: [stamp(BATCH, 'site'), stamp(OTHER, 'other')] });
      }
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        return Response.json({
          bzzBalance: '100000000000000000000', nativeTokenBalance: '5000000000000000000',
          chainID: 100, walletAddress: '0xWALLET', chequebookContractAddress: '0xCHEQUE',
        });
      }
      if (url.pathname === '/bzz' || url.pathname === '/bytes') {
        uploads.push({ batch: req.headers.get('swarm-postage-batch-id') ?? '', bytes: 1 });
        return Response.json({ reference: 'ab'.repeat(32) });
      }
      return Response.json({ status: 'ok' });
    },
  });

  db = new Db(':memory:');
  const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}` } as any);
  const bee = new BeeClient(cfg.beeUrl, 5000, 5000, 5000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  await poller.tick();
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: ADMIN });
  monitor.listen(0);
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(() => { upstream?.stop(true); monitor?.stop?.(); });

const base = () => `http://localhost:${monitor.server!.port}`;
const pub = (p: string) => fetch(base() + p);
const admin = (p: string, init: RequestInit = {}) =>
  fetch(base() + p, { ...init, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN, ...(init.headers ?? {}) } });

describe('the public tier shows the node without exposing intent', () => {
  it('serves state with no credentials at all', async () => {
    const r = await pub('/api/public/state');
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.readOnly).toBe(true);
    expect(s.batches.length).toBe(2);
    expect(s.node).toBeTruthy();
  });

  it('includes the wallet — it is on-chain anyway, and it is the point', async () => {
    const s = await (await pub('/api/public/state')).json();
    expect(s.wallet.bzz).toBeGreaterThan(0);
    expect(s.wallet.address).toBe('0xWALLET');
  });

  it('shows fullness and expiry, which is what makes it worth publishing', async () => {
    const s = await (await pub('/api/public/state')).json();
    const b = s.batches[0];
    expect(b.utilizationRatio).toBe(0.25);
    expect(b.ttlDays).toBeGreaterThan(0);
    expect(b.storedHuman).toBeTruthy();
  });

  /** The planner's next moves and the caps behind them are not public. */
  it('withholds plans and config', async () => {
    const s = await (await pub('/api/public/state')).json();
    expect(s.plans).toBeUndefined();
    expect(s.config).toBeUndefined();
  });

  it('withholds per-batch policy and thresholds', async () => {
    const s = await (await pub('/api/public/state')).json();
    for (const b of s.batches) {
      expect(b.policy).toBeUndefined();
      expect(b.effective).toBeUndefined();
    }
  });

  it('never carries key material anywhere in the payload', async () => {
    await admin(`/api/admin/batches/${BATCH}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'leak-probe' }),
    });
    const raw = await (await pub('/api/public/state')).text();
    expect(raw).not.toMatch(/ssm_[0-9a-f]{8}/);
    expect(raw.toLowerCase()).not.toContain('apikeyhash');
    expect(raw).not.toContain(ADMIN);
  });
});

describe('the public tier cannot write or reach the admin surface', () => {
  const denied = [
    ['GET', '/api/admin/state'],
    ['GET', '/api/admin/settings'],
    ['GET', '/api/admin/apps'],
    ['GET', `/api/admin/batches/${BATCH}/keys`],
    ['POST', '/api/admin/poll'],
    ['POST', '/api/admin/wizard/buy'],
  ] as const;

  for (const [method, path] of denied) {
    it(`refuses ${method} ${path}`, async () => {
      const r = await fetch(base() + path, { method });
      expect(r.status).toBe(401);
    });
  }

  it('refuses an upload with no key', async () => {
    const before = uploads.length;
    const r = await fetch(`${base()}/bzz`, { method: 'POST', body: 'x' });
    expect(r.status).toBe(401);
    expect(uploads.length).toBe(before);
  });
});

describe('per-batch keys', () => {
  let key = '';
  let id = 0;

  it('returns the plaintext exactly once, at creation', async () => {
    const r = await admin(`/api/admin/batches/${BATCH}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'ci' }),
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    key = b.key; id = b.id;
    expect(key).toMatch(/^ssm_[0-9a-f]{64}$/);

    // Every later read of the key list is metadata only.
    const list = await (await admin(`/api/admin/batches/${BATCH}/keys`)).json();
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(key);
    expect(JSON.stringify(list)).not.toMatch(/hash/i);
  });

  it('uploads with the key, and stamps the batch it belongs to', async () => {
    const before = uploads.length;
    const r = await fetch(`${base()}/bzz`, {
      method: 'POST', headers: { 'x-api-key': key }, body: 'hello',
    });
    expect(r.status).toBe(200);
    expect(uploads.length).toBe(before + 1);
    expect(uploads.at(-1)!.batch).toBe(BATCH);
  });

  /**
   * The isolation the separate batches were bought for. A key names its batch;
   * a caller cannot redirect it by asking for a different one.
   */
  it('ignores a batch id supplied by the caller', async () => {
    const before = uploads.length;
    await fetch(`${base()}/bzz`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'swarm-postage-batch-id': OTHER },
      body: 'hello',
    });
    expect(uploads.length).toBe(before + 1);
    expect(uploads.at(-1)!.batch).toBe(BATCH);
  });

  it('records when the key was last used, so a stale one is visible', async () => {
    const list = await (await admin(`/api/admin/batches/${BATCH}/keys`)).json();
    const row = list.find((k: any) => k.id === id);
    expect(row.lastUsedAt).toBeGreaterThan(0);
  });

  it('revoking takes effect on the next request, with no restart', async () => {
    expect((await admin(`/api/admin/keys/${id}`, { method: 'DELETE' })).status).toBe(200);
    const before = uploads.length;
    const r = await fetch(`${base()}/bzz`, {
      method: 'POST', headers: { 'x-api-key': key }, body: 'hello',
    });
    expect(r.status).toBe(401);
    expect(uploads.length).toBe(before);
  });

  it('leaves a second key on the same batch working — that is the point of plural', async () => {
    const a = await (await admin(`/api/admin/batches/${BATCH}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'rotate-a' }),
    })).json();
    const b = await (await admin(`/api/admin/batches/${BATCH}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'rotate-b' }),
    })).json();
    expect(a.key).not.toBe(b.key);

    await admin(`/api/admin/keys/${a.id}`, { method: 'DELETE' });
    expect((await fetch(`${base()}/bzz`, { method: 'POST', headers: { 'x-api-key': a.key }, body: 'x' })).status).toBe(401);
    expect((await fetch(`${base()}/bzz`, { method: 'POST', headers: { 'x-api-key': b.key }, body: 'x' })).status).toBe(200);
  });

  it('refuses to issue a key for a batch the node does not have', async () => {
    const r = await admin(`/api/admin/batches/${'ff'.repeat(32)}/keys`, {
      method: 'POST', body: JSON.stringify({ name: 'ghost' }),
    });
    expect(r.status).toBe(404);
  });
});
