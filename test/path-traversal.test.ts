/**
 * Issue #2: can an app API key reach Bee's wallet through /bzz/:ref/*?
 *
 * The download route builds a Bee path by concatenating an unvalidated
 * wildcard segment. Whether that is exploitable depends on where dot segments
 * get resolved — the router may normalise them away before the handler runs,
 * or they may survive percent-encoded and be resolved later by fetch(). That
 * is not something to reason about; it is something to fire at a real socket
 * and watch.
 *
 * fetch() collapses `..` in a URL before it ever reaches the wire, so the
 * literal case is sent down a raw TCP connection instead. Testing traversal
 * through a client that silently repairs the attack would prove nothing.
 *
 * The upstream records every path it is asked for, so the assertions are about
 * what Bee WOULD have been asked — not merely about what came back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Db } from '../src/db';
import { BeeClient } from '../src/bee';
import { Alerter } from '../src/alerts';
import { Poller } from '../src/poller';
import { createServer } from '../src/server';
import { loadConfig } from '../src/config';

const BATCH = 'dd'.repeat(32);
const ADMIN = 'test-admin';
const REF = 'ab'.repeat(32);

let upstream: ReturnType<typeof Bun.serve>;
let monitor: any;
let db: Db;
let apiKey: string;
/** Every path the fake Bee was asked for. */
const asked: string[] = [];

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
      asked.push(url.pathname);
      if (url.pathname === '/stamps') return Response.json({ stamps: [stamp(BATCH, 'site')] });
      if (url.pathname === '/chainstate') {
        return Response.json({ chainTip: 100, block: 100, totalAmount: '1', currentPrice: '72052', minimumValidityBlocks: 17280 });
      }
      if (url.pathname === '/wallet') {
        // The secret. If a low-privilege key can make this body come back, the
        // admin-only passthrough has been bypassed.
        return Response.json({
          bzzBalance: '100000000000000000000', nativeTokenBalance: '5000000000000000000',
          walletAddress: '0xSECRET_WALLET', chequebookContractAddress: '0xSECRET_CHEQUEBOOK',
        });
      }
      if (url.pathname === '/chequebook/balance') {
        return Response.json({ totalBalance: '1', availableBalance: '1', note: 'SECRET_CHEQUEBOOK' });
      }
      if (url.pathname === '/health') return Response.json({ status: 'ok', version: '2.8.1' });
      if (url.pathname.startsWith('/bzz/') || url.pathname.startsWith('/bytes/')) {
        return new Response('file-content', { status: 200 });
      }
      return Response.json({}, { status: 404 });
    },
  });

  const saved = { ...process.env };
  Object.assign(process.env, {
    BEE_URL: `http://127.0.0.1:${upstream.port}`, DB_PATH: ':memory:',
    AUTO_TOPUP_ENABLED: 'false', DRY_RUN: 'true',
  });
  const cfg = loadConfig();
  process.env = saved;

  db = new Db(':memory:');
  const bee = new BeeClient(`http://127.0.0.1:${upstream.port}`, 5000, 5000, 10000);
  const alerter = new Alerter(db, null, 0);
  const poller = new Poller(cfg, bee, db, alerter);
  monitor = createServer({ cfg, bee, db, alerter, poller, adminToken: ADMIN });
  monitor.listen(0);

  // The key endpoint only issues against a batch the poller has seen.
  await poller.tick();

  const res = await fetch(`http://localhost:${monitor.server!.port}/api/admin/batches/${BATCH}/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN },
    body: JSON.stringify({ name: 'deploy' }),
  });
  const payload: any = await res.json();
  if (!payload?.key) throw new Error(`key issue failed: ${res.status} ${JSON.stringify(payload)}`);
  apiKey = payload.key;
});

afterAll(() => { upstream?.stop(true); monitor?.stop?.(); db?.close?.(); });

/**
 * A GET whose path reaches the socket exactly as written.
 *
 * Bun's fetch resolves `..` against the base URL before sending, which would
 * quietly repair the very thing under test.
 */
function rawGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = setTimeout(() => resolve(buf), 4000);
    Bun.connect({
      hostname: '127.0.0.1',
      port: monitor.server!.port,
      socket: {
        open(sock) {
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: localhost\r\n`
            + `x-api-key: ${apiKey}\r\nConnection: close\r\n\r\n`,
          );
        },
        data(_s, chunk) { buf += new TextDecoder().decode(chunk); },
        close() { clearTimeout(done); resolve(buf); },
        error(_s, e) { clearTimeout(done); reject(e); },
      },
    }).catch(reject);
  });
}

describe('an app key must not reach the node through the download route', () => {
  it('serves an ordinary file, so the route itself still works', async () => {
    expect(await rawGet(`/bzz/${REF}/index.html`)).toContain('file-content');
  });

  for (const attack of [
    `/bzz/${REF}/../../wallet`,
    `/bzz/${REF}/%2e%2e/%2e%2e/wallet`,
    `/bzz/${REF}/%2E%2E/%2E%2E/wallet`,
    `/bzz/${REF}/..%2f..%2fwallet`,
    `/bzz/${REF}/%252e%252e/%252e%252e/wallet`,
    `/bzz/${REF}/../../chequebook/balance`,
    `/bzz/${REF}/..%5c..%5cwallet`,
    `/bzz/${REF}/./../../wallet`,
  ]) {
    it(`refuses ${attack.replace(REF, '<ref>')}`, async () => {
      asked.length = 0;
      const res = await rawGet(attack);

      // The secret must never come back...
      expect(res).not.toContain('SECRET_WALLET');
      expect(res).not.toContain('SECRET_CHEQUEBOOK');
      // ...and Bee must never even have been ASKED for a non-content path.
      // Checking only the response would miss a leak that merely 500s.
      const escaped = asked.filter((p) => !p.startsWith('/bzz/') && !p.startsWith('/bytes/'));
      expect(escaped).toEqual([]);
    });
  }

  it('rejects a reference that is not a hex swarm address', async () => {
    expect(await rawGet('/bzz/not-a-ref/index.html')).toMatch(/HTTP\/1\.[01] 4\d\d/);
  });
});
