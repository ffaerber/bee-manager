/**
 * The price feed is decorative, so these tests are almost entirely about it
 * failing quietly. A quote that is merely absent costs nothing; a quote that
 * throws, hangs, or puts NaN on the dashboard costs a page that will not load.
 */
import { describe, expect, it } from 'bun:test';
import { PriceFeed } from '../src/price';

const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const GOOD = { 'swarm-bzz': { usd: 0.0416, eur: 0.036, usd_24h_change: -2.19 } };

describe('PriceFeed', () => {
  it('parses a quote', async () => {
    const p = await new PriceFeed({ fetchImpl: ok(GOOD) }).get();
    expect(p?.usd).toBe(0.0416);
    expect(p?.eur).toBe(0.036);
    expect(p?.usd24hChange).toBe(-2.19);
  });

  it('returns null when disabled, without calling out', async () => {
    let called = 0;
    const feed = new PriceFeed({
      enabled: false,
      fetchImpl: (async () => { called++; return new Response('{}'); }) as any,
    });
    expect(await feed.get()).toBeNull();
    expect(called).toBe(0);
  });

  it('serves from cache inside the TTL', async () => {
    let calls = 0;
    const feed = new PriceFeed({
      ttlMs: 60_000,
      fetchImpl: (async () => { calls++; return new Response(JSON.stringify(GOOD)); }) as any,
    });
    await feed.get(1_000);
    await feed.get(2_000);
    await feed.get(30_000);
    expect(calls).toBe(1);
  });

  it('refetches once the TTL expires', async () => {
    let calls = 0;
    const feed = new PriceFeed({
      ttlMs: 10_000,
      fetchImpl: (async () => { calls++; return new Response(JSON.stringify(GOOD)); }) as any,
    });
    await feed.get(1_000);
    await feed.get(20_000);
    expect(calls).toBe(2);
  });

  // ── the part that actually matters ──────────────────────────────────────

  it('resolves null rather than throwing when the network is down', async () => {
    const feed = new PriceFeed({ fetchImpl: (async () => { throw new Error('ENOTFOUND'); }) as any });
    expect(await feed.get()).toBeNull();
  });

  it('keeps the last good quote when a later fetch fails', async () => {
    let first = true;
    const feed = new PriceFeed({
      ttlMs: 0, // always considered stale, so every get() refetches
      fetchImpl: (async () => {
        if (first) { first = false; return new Response(JSON.stringify(GOOD)); }
        throw new Error('rate limited');
      }) as any,
    });
    expect((await feed.get(0))?.usd).toBe(0.0416);
    // A blip must not blank a figure that was fine a moment ago.
    expect((await feed.get(1))?.usd).toBe(0.0416);
  });

  it('rejects a malformed body instead of surfacing NaN', async () => {
    for (const body of [{}, { 'swarm-bzz': {} }, { 'swarm-bzz': { usd: 'abc' } }, { 'swarm-bzz': { usd: 0 } }]) {
      const feed = new PriceFeed({ fetchImpl: ok(body) });
      expect(await feed.get()).toBeNull();
    }
  });

  it('treats a non-200 as no new data', async () => {
    const feed = new PriceFeed({
      fetchImpl: (async () => new Response('rate limited', { status: 429 })) as any,
    });
    expect(await feed.get()).toBeNull();
  });

  it('shares one in-flight request between concurrent callers', async () => {
    let calls = 0;
    const feed = new PriceFeed({
      fetchImpl: (async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify(GOOD));
      }) as any,
    });
    const [a, b, c] = await Promise.all([feed.get(), feed.get(), feed.get()]);
    expect(calls).toBe(1);
    expect(a?.usd).toBe(b?.usd);
    expect(b?.usd).toBe(c?.usd);
  });
});
