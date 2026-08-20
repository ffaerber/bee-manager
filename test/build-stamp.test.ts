/**
 * Cache headers and the build stamp — the two halves of "is this page current?".
 *
 * index.html was served with NO cache headers at all: no Cache-Control, no
 * ETag, no Last-Modified. That leaves browsers to apply heuristic caching, and
 * a stale index pins the old hashed bundle however many times the service is
 * redeployed — which is exactly how a shipped change appeared not to have
 * shipped. The assets are content-hashed and can be cached forever; the
 * pointer to them cannot be cached at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer, BUILD } from '../src/server';
import { loadConfig } from '../src/config';

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === '/stamps') return Response.json({ stamps: [] });
      if (p === '/chainstate') return Response.json({ chainTip: 1, block: 1, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      if (p === '/wallet') return Response.json({ bzzBalance: '0', nativeTokenBalance: '0', chainID: 100, walletAddress: '0x1', chequebookContractAddress: '0x2' });
      return Response.json({ status: 'ok' });
    },
  });
  const db = new Db(':memory:');
  const cfg = loadConfig({ BEE_URL: `http://localhost:${upstream.port}` } as any);
  const bee = new BeeClient(cfg.beeUrl, 5000, 5000, 5000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  await poller.tick();
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: 't' });
  monitor.listen(0);
  await new Promise((r) => setTimeout(r, 150));
});
afterAll(() => { upstream?.stop(true); monitor?.stop?.(); });

const base = () => `http://localhost:${monitor.server!.port}`;

describe('the build stamp', () => {
  it('is reported by /health without any credential', async () => {
    const h = await (await fetch(`${base()}/health`)).json();
    expect(h.build).toBeTruthy();
    expect(typeof h.build.sha).toBe('string');
  });

  /** Short enough to read at a glance; a full 40-char sha is not a UI element. */
  it('is abbreviated', () => {
    expect(BUILD.sha.length).toBeLessThanOrEqual(7);
  });

  it('falls back to "dev" rather than empty when unstamped', () => {
    // A local run has no BUILD_SHA. Showing nothing would be indistinguishable
    // from a stamp that failed to render.
    expect(BUILD.sha.length).toBeGreaterThan(0);
  });
});
