import { describe, expect, it } from 'bun:test';
import { SelfLocationFeed, publicIpv4 } from '../src/selfloc';

/** Exactly what the live node advertises, order included. */
const LIVE_UNDERLAY = [
  '/ip4/10.0.1.149/tcp/1634/p2p/QmZTZ',
  '/ip4/10.0.2.140/tcp/1634/p2p/QmZTZ',
  '/ip4/62.228.14.108/tcp/1634/p2p/QmZTZ',
  '/ip4/127.0.0.1/tcp/1634/p2p/QmZTZ',
  '/ip4/172.18.0.8/tcp/1634/p2p/QmZTZ',
  '/ip6/::1/tcp/1634/p2p/QmZTZ',
  '/dns4/bee.ffaerber.duckdns.org/tcp/1634/p2p/QmZTZ',
];

describe('picking the address that is actually reachable', () => {
  it('skips the private ones and finds the WAN address', () => {
    // The public address is FOURTH in the list. Taking the first would plot
    // the node inside a docker bridge.
    expect(publicIpv4(LIVE_UNDERLAY)).toBe('62.228.14.108');
  });

  it('rejects every private range, not just the obvious ones', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.1',
                      '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0']) {
      expect(publicIpv4([`/ip4/${ip}/tcp/1634/p2p/x`])).toBeNull();
    }
  });

  it('keeps 172.32 and 11.x, which are public despite looking private', () => {
    expect(publicIpv4(['/ip4/172.32.0.1/tcp/1634/p2p/x'])).toBe('172.32.0.1');
    expect(publicIpv4(['/ip4/11.0.0.1/tcp/1634/p2p/x'])).toBe('11.0.0.1');
  });

  it('returns null rather than guessing when there is nothing public', () => {
    expect(publicIpv4(['/ip4/10.0.0.1/tcp/1634/p2p/x', '/ip6/::1/tcp/1634/p2p/x'])).toBeNull();
    expect(publicIpv4([])).toBeNull();
    expect(publicIpv4(undefined)).toBeNull();
  });
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('resolving this node, without inventing it', () => {
  it('prefers the index, which is the same source as every other dot', async () => {
    const calls: string[] = [];
    const f = new SelfLocationFeed({
      fetchImpl: (async (u: any) => {
        calls.push(String(u));
        return ok({ location: { country: 'Germany', city: 'Berlin', latitude: 52.52, longitude: 13.4 } });
      }) as any,
    });
    const loc = await f.get('abc123', LIVE_UNDERLAY);
    expect(loc).toMatchObject({ city: 'Berlin', lat: 52.52, lon: 13.4 });
    // The IP geolocator must not be consulted at all when the index answered.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('swarmscan');
  });

  it('falls back to the advertised address when the index has no location', async () => {
    const calls: string[] = [];
    const f = new SelfLocationFeed({
      fetchImpl: (async (u: any) => {
        calls.push(String(u));
        return String(u).includes('swarmscan')
          ? ok({ location: null })
          : ok({ status: 'success', country: 'Cyprus', city: 'Limassol', lat: 34.6874, lon: 33.0366 });
      }) as any,
    });
    const loc = await f.get('abc123', LIVE_UNDERLAY);
    expect(loc).toMatchObject({ city: 'Limassol', lat: 34.6874, lon: 33.0366 });
    // Must have asked about the node's OWN advertised address, not this host's.
    expect(calls[1]).toContain('62.228.14.108');
  });

  it('asks the geolocator for coordinates only, never the ISP or region', async () => {
    let geoUrl = '';
    const f = new SelfLocationFeed({
      fetchImpl: (async (u: any) => {
        if (String(u).includes('swarmscan')) return ok({ location: null });
        geoUrl = String(u);
        return ok({ status: 'success', country: 'Cyprus', city: 'Limassol', lat: 34.6, lon: 33.0 });
      }) as any,
    });
    await f.get('abc123', LIVE_UNDERLAY);
    // This lands in an unauthenticated response; it carries no more than the
    // map draws.
    expect(geoUrl).not.toContain('isp');
    expect(geoUrl).not.toContain('regionName');
    expect(geoUrl).toContain('lat');
  });

  it('returns null when nothing can place it, rather than a plausible point', async () => {
    const f = new SelfLocationFeed({
      fetchImpl: (async (u: any) => String(u).includes('swarmscan')
        ? ok({ location: null })
        : ok({ status: 'fail', message: 'reserved range' })) as any,
    });
    expect(await f.get('abc123', LIVE_UNDERLAY)).toBeNull();
  });

  it('never throws when both sources are down', async () => {
    const f = new SelfLocationFeed({
      fetchImpl: (async () => { throw new Error('offline'); }) as any,
    });
    expect(await f.get('abc123', LIVE_UNDERLAY)).toBeNull();
  });

  it('keeps the last good position instead of blinking out on one failure', async () => {
    let fail = false;
    const f = new SelfLocationFeed({
      ttlMs: 0,   // force a re-read every call
      fetchImpl: (async (u: any) => {
        if (fail) throw new Error('offline');
        return String(u).includes('swarmscan')
          ? ok({ location: { country: 'Cyprus', city: 'Limassol', latitude: 34.6, longitude: 33.0 } })
          : ok({ status: 'fail' });
      }) as any,
    });
    expect(await f.get('abc123', LIVE_UNDERLAY)).toMatchObject({ city: 'Limassol' });
    fail = true;
    expect(await f.get('abc123', LIVE_UNDERLAY)).toMatchObject({ city: 'Limassol' });
  });

  it('makes no request at all when disabled', async () => {
    let called = 0;
    const f = new SelfLocationFeed({
      enabled: false,
      fetchImpl: (async () => { called++; return ok({}); }) as any,
    });
    expect(await f.get('abc123', LIVE_UNDERLAY)).toBeNull();
    // PEER_MAP_SELF=false must mean nothing is published AND nothing is asked.
    expect(called).toBe(0);
  });
});
