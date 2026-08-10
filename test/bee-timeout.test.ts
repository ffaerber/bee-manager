import { describe, it, expect } from 'bun:test';
import { BeeClient, BeeIndeterminateError } from '../src/bee';

/** A server that never answers, to force a client-side timeout. */
function blackhole() {
  return Bun.serve({ port: 0, async fetch() { await new Promise(() => {}); return new Response('never'); } });
}

describe('write timeouts are indeterminate, not failures', () => {
  it('a timed-out buy reports indeterminate — the transaction may still be mined', async () => {
    const s = blackhole();
    try {
      const bee = new BeeClient(`http://localhost:${s.port}`, 5_000, 150);
      await bee.buyBatch(1000n, 18);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BeeIndeterminateError);
      expect((e as Error).message).toContain('do not retry');
    } finally { s.stop(true); }
  });

  it('a timed-out top-up is indeterminate too', async () => {
    const s = blackhole();
    try {
      const bee = new BeeClient(`http://localhost:${s.port}`, 5_000, 150);
      await bee.topUp('aa'.repeat(32), 1000n);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BeeIndeterminateError);
    } finally { s.stop(true); }
  });

  it('a timed-out READ is an ordinary failure — nothing was spent', async () => {
    const s = blackhole();
    try {
      const bee = new BeeClient(`http://localhost:${s.port}`, 150, 5_000);
      await bee.stamps();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(BeeIndeterminateError);
    } finally { s.stop(true); }
  });

  it('writes get their own, much longer budget than reads', async () => {
    const s = blackhole();
    const started = Date.now();
    try {
      // read timeout 100ms, write timeout 600ms: the write must outlive the read budget
      const bee = new BeeClient(`http://localhost:${s.port}`, 100, 600);
      await bee.dilute('aa'.repeat(32), 19);
    } catch (e) {
      expect(e).toBeInstanceOf(BeeIndeterminateError);
      expect(Date.now() - started).toBeGreaterThan(400);
    } finally { s.stop(true); }
  });
});

describe('buyBatch immutability default', () => {
  /** Capture the headers Bee would receive. */
  function captureServer(seen: { headers?: Headers }) {
    return Bun.serve({
      port: 0,
      fetch(req) { seen.headers = req.headers; return Response.json({ batchID: 'ab'.repeat(32) }); },
    });
  }

  it('defaults to MUTABLE — an immutable batch dies on the first full bucket', async () => {
    const seen: { headers?: Headers } = {};
    const s = captureServer(seen);
    try {
      await new BeeClient(`http://localhost:${s.port}`).buyBatch(1000n, 18);
      expect(seen.headers?.get('immutable')).toBe('false');
    } finally { s.stop(true); }
  });

  it('never leaves the flag to Bee, whose default is immutable', async () => {
    const seen: { headers?: Headers } = {};
    const s = captureServer(seen);
    try {
      await new BeeClient(`http://localhost:${s.port}`).buyBatch(1000n, 18, { label: 'x' });
      expect(seen.headers?.has('immutable')).toBe(true);
    } finally { s.stop(true); }
  });

  it('still honours an explicit immutable request', async () => {
    const seen: { headers?: Headers } = {};
    const s = captureServer(seen);
    try {
      await new BeeClient(`http://localhost:${s.port}`).buyBatch(1000n, 18, { immutable: true });
      expect(seen.headers?.get('immutable')).toBe('true');
    } finally { s.stop(true); }
  });
});
