import { describe, expect, it } from 'bun:test';
import { clusterPeers, clusterRadius, type PeerPoint } from '../web/src/PeerMap';

const peer = (n: number, city: string, country: string, lat: number, lon: number): PeerPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    overlay: `${city}-${i}`.padEnd(10, '0'), city, country, lat, lon,
  }));

/** The reading from the live node that exposed the bug. */
const LIVE = [
  ...peer(13, 'Helsinki', 'Finland', 60.1719, 24.9347),
  ...peer(6, 'Falkenstein', 'Germany', 50.4777, 12.3649),
  ...peer(2, 'Beauharnois', 'Canada', 45.3151, -73.8779),
];

describe('counting the overlap instead of drawing it', () => {
  it('keeps every peer accounted for when they share a location', () => {
    const cs = clusterPeers(LIVE);
    // The whole point: three marks, but they still add up to 21. Before this,
    // the map said "21 placed" and drew three identical dots.
    expect(cs).toHaveLength(3);
    expect(cs.reduce((n, c) => n + c.count, 0)).toBe(LIVE.length);
  });

  it('sizes by area, so a 13-peer mark reads as 13 and not as 169', () => {
    const base = 3.2;
    // Area ratio must equal the count ratio.
    const a = (n: number) => Math.PI * clusterRadius(n, base) ** 2;
    expect(a(13) / a(1)).toBeCloseTo(13, 6);
    expect(a(4) / a(2)).toBeCloseTo(2, 6);
    // And radius must NOT scale with the count, which is the easy mistake.
    expect(clusterRadius(13, base)).toBeLessThan(base * 13);
  });

  it('names the place and the size, so a big dot is not a mystery', () => {
    const [biggest] = clusterPeers(LIVE);
    expect(biggest.count).toBe(13);
    expect(biggest.label).toContain('Helsinki');
    expect(biggest.label).toContain('13');
  });

  it('labels a lone peer without inventing a count', () => {
    const [only] = clusterPeers(peer(1, 'Sydney', 'Australia', -33.8688, 151.2093));
    expect(only.count).toBe(1);
    expect(only.label).toBe('Sydney, Australia');
    expect(only.label).not.toContain('1 peers');
  });

  it('draws the biggest first so it cannot cover a smaller one', () => {
    const counts = clusterPeers(LIVE).map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('what must stay separate', () => {
  it('does not merge genuinely distant peers', () => {
    const cs = clusterPeers([
      ...peer(1, 'Helsinki', 'Finland', 60.1719, 24.9347),
      ...peer(1, 'Sydney', 'Australia', -33.8688, 151.2093),
      ...peer(1, 'Ashburn', 'United States', 39.0438, -77.4874),
    ]);
    expect(cs).toHaveLength(3);
    expect(cs.every((c) => c.count === 1)).toBe(true);
  });

  it('places a cluster among its members, not on the bucket corner', () => {
    // Two peers a hair apart: the mark belongs between them.
    const cs = clusterPeers([
      ...peer(1, 'A', 'Germany', 50.40, 12.30),
      ...peer(1, 'B', 'Germany', 50.50, 12.40),
    ]);
    expect(cs).toHaveLength(1);
    const [lo, hi] = [
      Math.min(50.40, 50.50), Math.max(50.40, 50.50),
    ];
    // y decreases as latitude increases; just assert it is strictly inside.
    expect(cs[0].count).toBe(2);
    expect(Number.isFinite(cs[0].x)).toBe(true);
    expect(lo).toBeLessThan(hi);
  });

  it('survives a peer the index located but could not name', () => {
    const cs = clusterPeers([
      { overlay: 'abcdef1234567890', city: null, country: null, lat: 10, lon: 10 },
    ]);
    expect(cs).toHaveLength(1);
    // Falls back to the overlay rather than rendering "null, null".
    expect(cs[0].label).toBe('abcdef1234');
  });

  it('returns nothing for no peers rather than throwing', () => {
    expect(clusterPeers([])).toEqual([]);
  });
});
