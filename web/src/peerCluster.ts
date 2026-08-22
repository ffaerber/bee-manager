import { project } from './worldPath';

export interface PeerPoint {
  overlay: string;
  country: string | null;
  city: string | null;
  lat: number;
  lon: number;
}

export interface PeerCluster {
  x: number;
  y: number;
  count: number;
  label: string;
  key: string;
}

/**
 * Collapse peers that land on the same spot into one mark.
 *
 * Still needed with uniform dots: peers in the same datacentre project to the
 * same pixel, so without grouping they would be 35 identical circles stacked
 * on one another — visually one dot, but 35 hover targets fighting each other
 * and 35 nodes in the DOM. Grouping makes that one mark whose label carries
 * the real number.
 *
 * Swarm nodes cluster in datacentres — a live reading was Finland 13, Germany
 * 6, Canada 2, which is 21 peers at three addresses. Drawn as 21 separate
 * translucent dots they stack into three opaque ones, so the map said "21
 * placed" and showed three marks of identical size. Overlapping fills do NOT
 * read as a brighter spot at these opacities; they saturate.
 *
 * So the overlap is counted instead of drawn. Grouping is by rounded projected
 * position rather than by city name: two peers 40km apart are one pixel apart
 * at this scale, and city strings from the index are inconsistent anyway.
 */
export function clusterPeers(peers: PeerPoint[], quantum = 6): PeerCluster[] {
  const groups = new Map<string, { x: number; y: number; n: number; places: Map<string, number> }>();
  for (const p of peers) {
    const { x, y } = project(p.lon, p.lat);
    const key = `${Math.round(x / quantum)}:${Math.round(y / quantum)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { x: 0, y: 0, n: 0, places: new Map() }));
    // Mean position, so a cluster sits among its members rather than on the
    // grid cell it was bucketed into.
    g.x += x; g.y += y; g.n += 1;
    const place = [p.city, p.country].filter(Boolean).join(', ') || p.overlay.slice(0, 10);
    g.places.set(place, (g.places.get(place) ?? 0) + 1);
  }
  return [...groups.entries()].map(([key, g]) => {
    const top = [...g.places.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return {
      key, x: g.x / g.n, y: g.y / g.n, count: g.n,
      label: g.n === 1 ? top : `${top} — ${g.n} peers`,
    };
  // Biggest first so it paints under the smaller ones and never hides them.
  }).sort((a, b) => b.count - a.count);
}

