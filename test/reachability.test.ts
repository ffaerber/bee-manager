/**
 * The outside view, and the ways it is allowed to be wrong.
 *
 * This exists because every other health signal is self-reported. The homelab
 * node advertised a WAN address that had rotated away six weeks earlier and
 * reported ~120 peers the entire time — all outbound. Nothing local could tell
 * the difference between "reachable" and "has a lot of outbound connections".
 *
 * The hard rule under test: unknown is never rendered as fine. A third party
 * being down is not evidence about the node.
 */
import { describe, it, expect } from 'bun:test';
import { ReachabilityFeed } from '../src/reachability';

const OVERLAY = 'bd85c9a7508a61d3fc128144da3ae36a1977bcb6ad93b8f4a07e7e644e14706e';
const OTHER = 'ff896a936f4c6b39c8c123a3d5d2b252c054af6dec567afe3220a1490d53eeb2';

const feed = (body: any, status = 200, opts: any = {}) => {
  let calls = 0;
  const f = new ReachabilityFeed({
    baseUrl: 'http://x', timeoutMs: 100, ...opts,
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as any,
  });
  return { f, calls: () => calls };
};

describe('reading the observer', () => {
  it('reports an undialable node, with the reason', async () => {
    const { f } = feed({
      overlay: OVERLAY, unreachable: true,
      error: 'dial tcp4 62.228.26.141:1634: i/o timeout\nsecond line',
      handshakeDurationMilliseconds: 5012, lastCheckTime: '2026-08-20T14:24:36Z',
    });
    const r = await f.get(OVERLAY);
    expect(r!.unreachable).toBe(true);
    expect(r!.handshakeMs).toBe(5012);
    // Trimmed to one line: the address that was tried is the useful part.
    expect(r!.error).toBe('dial tcp4 62.228.26.141:1634: i/o timeout');
  });

  /**
   * The field is only present on failure, so absent means the dial worked.
   * Coerced explicitly, because `undefined` reading as "unknown" would hide a
   * healthy node behind a permanent question mark.
   */
  it('treats a missing unreachable flag as reachable', async () => {
    const { f } = feed({ overlay: OVERLAY, userAgent: 'bee/2.8.1', handshakeDurationMilliseconds: 717 });
    const r = await f.get(OVERLAY);
    expect(r!.unreachable).toBe(false);
    expect(r!.userAgent).toBe('bee/2.8.1');
  });

  it('says unknown — not fine — when the node is not indexed', async () => {
    const { f } = feed({}, 404);
    const r = await f.get(OVERLAY);
    expect(r!.unreachable).toBeNull();
    expect(r!.error).toMatch(/not indexed/);
  });
});

describe('refusing to mislead', () => {
  it('never attributes one node\'s answer to another overlay', async () => {
    const { f } = feed({ overlay: OTHER, unreachable: false });
    // A payload about a different node is discarded rather than shown under
    // the overlay we asked about.
    expect(await f.get(OVERLAY)).toBeNull();
  });

  it('keeps the last reading when upstream fails', async () => {
    let ok = true;
    const f = new ReachabilityFeed({
      baseUrl: 'http://x', ttlMs: 0, timeoutMs: 50,
      fetchImpl: (async () => {
        if (!ok) throw new Error('offline');
        return new Response(JSON.stringify({ overlay: OVERLAY, unreachable: true }), { status: 200 });
      }) as any,
    });
    expect((await f.get(OVERLAY))!.unreachable).toBe(true);
    ok = false;
    // Reachability changes on the scale of router configs; one failed fetch
    // must not blank a finding that is still true.
    expect((await f.get(OVERLAY))!.unreachable).toBe(true);
  });

  it('returns null when disabled, without calling out', async () => {
    const { f, calls } = feed({ overlay: OVERLAY, unreachable: true }, 200, { enabled: false });
    expect(await f.get(OVERLAY)).toBeNull();
    expect(calls()).toBe(0);
  });
});

describe('being a good citizen upstream', () => {
  it('serves from cache within the ttl', async () => {
    const { f, calls } = feed({ overlay: OVERLAY, unreachable: true }, 200, { ttlMs: 60_000 });
    await f.get(OVERLAY, 1_000);
    await f.get(OVERLAY, 2_000);
    await f.get(OVERLAY, 3_000);
    // The observer re-checks on its own schedule, in tens of minutes. Polling
    // harder produces no fresher answer at someone else's expense.
    expect(calls()).toBe(1);
  });

  it('refetches for a different overlay rather than reusing the cache', async () => {
    const { f, calls } = feed({ unreachable: false }, 200, { ttlMs: 60_000 });
    await f.get(OVERLAY, 1_000);
    await f.get(OTHER, 1_500);
    expect(calls()).toBe(2);
  });
});

/**
 * The observer's own backoff is not a fact about the node.
 *
 * libp2p keeps a per-peer circuit breaker: after some failures it stops
 * dialling for a window and fails instantly with "breaker closed" — reported
 * as unreachable=true, indistinguishable from a real failure unless you look
 * at the duration. A genuine timeout takes seconds; a breaker refusal takes
 * microseconds.
 *
 * This shipped wrong once. The gateway showed "undialable" on the dashboard
 * while its port was accepting connections, on the strength of a 14µs
 * "breaker closed". Asserting a fault from an observer that never touched the
 * network is the crying-wolf the whole module is written to avoid.
 */
describe('telling a refusal apart from a failure', () => {
  const mk = (body: any) => new ReachabilityFeed({
    baseUrl: 'http://x', timeoutMs: 100,
    fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as any,
  });

  it('reports unknown when the observer declined to dial', async () => {
    const r = await mk({
      overlay: OVERLAY, unreachable: true,
      error: 'network status unknown: breaker closed',
      handshakeDurationMilliseconds: 0,
      userAgent: 'bee/2.8.1-7cf53193',
    }).get(OVERLAY);
    expect(r!.unreachable).toBeNull();
    // The reason is still carried, so the UI can explain the gap if it wants.
    expect(r!.error).toMatch(/breaker/);
  });

  it('still reports a real dial failure', async () => {
    // Seconds, and an error naming the address actually tried.
    const r = await mk({
      overlay: OVERLAY, unreachable: true,
      error: 'dial tcp4 62.228.26.141:1634: i/o timeout',
      handshakeDurationMilliseconds: 5012,
    }).get(OVERLAY);
    expect(r!.unreachable).toBe(true);
  });

  it('leaves a successful reading alone however fast it was', async () => {
    // Only a claimed failure is ever reinterpreted; a quick handshake is a
    // good sign, not a suspicious one.
    const r = await mk({ overlay: OVERLAY, handshakeDurationMilliseconds: 0, userAgent: 'bee/2.8.1' }).get(OVERLAY);
    expect(r!.unreachable).toBe(false);
  });
});
