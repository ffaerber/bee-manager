/**
 * Peer locations: asked once, remembered, and honest about what is missing.
 *
 * A lookup costs ~4 KB against a free third-party index and a node holds ~140
 * peers, so the expensive mistake is asking again for an answer already on
 * disk. The other mistake is drawing a partial map as though it were the whole
 * network, which would show Swarm as smaller and more concentrated than it is.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { Db } from '../src/db';
import { PeerMapFeed } from '../src/peermap';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);

const feed = (db: Db, body: any, opts: any = {}) => {
  let calls: string[] = [];
  const f = new PeerMapFeed(db, {
    baseUrl: 'http://x', timeoutMs: 100, perTick: 10, ...opts,
    fetchImpl: (async (url: any) => {
      calls.push(String(url).split('/').pop()!);
      const b = typeof body === 'function' ? body(String(url)) : body;
      if (b === 404) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(b), { status: 200 });
    }) as any,
  });
  return { f, calls: () => calls };
};

const LOC = { location: { country: 'Germany', city: 'Falkenstein', latitude: 50.4777, longitude: 12.3649 } };

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('resolving', () => {
  it('places a peer and reports the map complete', async () => {
    const { f } = feed(db, LOC);
    const s = await f.tick([A]);
    expect(s.located.length).toBe(1);
    expect(s.located[0]!.country).toBe('Germany');
    expect(s.pending).toBe(0);
    expect(s.unplaceable).toBe(0);
  });

  it('never asks twice about the same overlay', async () => {
    const { f, calls } = feed(db, LOC);
    await f.tick([A]);
    await f.tick([A]);
    await f.tick([A]);
    // The whole point of the cache: 140 peers must not be re-resolved on every
    // restart of a service that polls every five minutes.
    expect(calls().length).toBe(1);
  });

  it('resolves only a few per tick, so it fills in rather than bursting', async () => {
    const { f, calls } = feed(db, LOC, { perTick: 2 });
    await f.tick([A, B, C]);
    expect(calls().length).toBe(2);
  });

  it('records a 404 so an unindexed peer is not asked about forever', async () => {
    const { f, calls } = feed(db, 404);
    await f.tick([A]);
    const s = await f.tick([A]);
    expect(calls().length).toBe(1);
    expect(s.unplaceable).toBe(1);
    expect(s.pending).toBe(0);
  });
});

describe('refusing to draw a lie', () => {
  it('drops null island rather than putting a peer in the Atlantic', async () => {
    // The index returns 0,0 for a node it could not place. Plotting that would
    // invent a cluster off the coast of Africa.
    const { f } = feed(db, { location: { country: '', city: '', latitude: 0, longitude: 0 } });
    const s = await f.tick([A]);
    expect(s.located.length).toBe(0);
    expect(s.unplaceable).toBe(1);
  });

  it('counts what is still unresolved instead of implying the map is whole', async () => {
    const { f } = feed(db, LOC, { perTick: 1 });
    const s = await f.tick([A, B, C]);
    expect(s.located.length).toBe(1);
    expect(s.pending).toBe(2);          // said out loud under the map
    expect(s.connected).toBe(3);
  });

  it('draws only peers connected now, not everyone ever seen', async () => {
    const { f } = feed(db, LOC);
    await f.tick([A, B]);
    // B disconnects; its row stays cached but must not appear on the map.
    const s = await f.tick([A]);
    expect(s.located.map((p) => p.overlay)).toEqual([A]);
    expect(s.connected).toBe(1);
  });

  it('leaves a peer unknown when the lookup fails, rather than marking it missing', async () => {
    const f = new PeerMapFeed(db, {
      baseUrl: 'http://x', timeoutMs: 50,
      fetchImpl: (async () => { throw new Error('offline'); }) as any,
    });
    const s = await f.tick([A]);
    // "We could not ask" is not "there is no answer" — it must be retried.
    expect(s.pending).toBe(1);
    expect(s.unplaceable).toBe(0);
  });

  it('makes no outbound call at all when disabled', async () => {
    const { f, calls } = feed(db, LOC, { enabled: false });
    const s = await f.tick([A, B]);
    expect(calls().length).toBe(0);
    expect(s.located.length).toBe(0);
  });
});
