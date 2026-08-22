import { useEffect, useMemo, useRef, useState } from 'react';
import type { State } from './api';
import { WORLD_PATH, WORLD_VIEWBOX, project } from './worldPath';

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

/**
 * Radius for a cluster of n peers, in viewBox units.
 *
 * Area scales with the count, not radius — a 13-peer mark must look like 13,
 * and radius-proportional sizing would draw it four times too big. `base` is
 * the radius of a single peer.
 */
export function clusterRadius(n: number, base: number): number {
  return base * Math.sqrt(n);
}

/**
 * Where this node's peers are.
 *
 * Bee knows who it is connected to and nothing about where — an overlay is a
 * hash and carries no geography. Positions come from the same outside observer
 * that answers whether we are dialable, resolved a few per poll and remembered
 * permanently, so the map fills in over an hour and then costs nothing.
 *
 * It therefore starts INCOMPLETE, and says so under the map. A partial map
 * that looked finished would misrepresent the network as smaller and more
 * concentrated than it is.
 */
export function PeerMap({ state }: { state: State | null }) {
  const pm = state?.peerMap;
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  /**
   * Dot size is specified in screen pixels and converted to viewBox units,
   * because a radius fixed in user units shrinks with the map: at phone width
   * the map is ~360px across and r=3.2 renders near one physical pixel —
   * present in the DOM, invisible to the eye. Measured rather than guessed
   * from a media query, since the card width is what actually governs it.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width || 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const base = Math.max(3.2, (3.4 * WORLD_VIEWBOX.w) / Math.max(width, 1));

  const clusters = useMemo(
    () => clusterPeers((pm?.located ?? []) as PeerPoint[]),
    [pm?.located],
  );

  /** Countries, most peers first — the map shows position, this names it. */
  const byCountry = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pm?.located ?? []) {
      if (p.country) m.set(p.country, (m.get(p.country) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [pm?.located]);

  if (!pm) return null;

  const clustered = clusters.some((c) => c.count > 1);

  // This node is deliberately not plotted. Its own coordinates would have to
  // come from the same index, and we do not fetch them — marking it at a
  // guessed position would be the one dot on the map that is made up.

  return (
    <div className="card">
      <div className="card-head">
        <div className="spread">
          <h2>Peers</h2>
          <span className="status">{pm.connected} connected</span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          The nodes this one is connected to. Bee knows who they are; where they are comes from an
          outside index, resolved a few at a time and remembered.
        </p>
      </div>

      <div style={{ position: 'relative' }} ref={wrapRef}>
        <svg
          viewBox={`0 0 ${WORLD_VIEWBOX.w} ${WORLD_VIEWBOX.h}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`World map of ${pm.located.length} located peers in ${byCountry.length} countries`}
        >
          {/* Land, recessive: it is the reference frame, not the reading. */}
          <path d={WORLD_PATH} fill="var(--map-empty)" stroke="var(--grid)" strokeWidth="0.5" />
          {clusters.map((c) => (
            <circle
              key={c.key}
              className="peer-dot"
              cx={c.x} cy={c.y} r={clusterRadius(c.count, base)}
              onMouseEnter={() => setHover({ x: c.x, y: c.y, label: c.label })}
              onMouseLeave={() => setHover(null)}
            >
              {/* Reaches touch and screen readers, which never get the hover. */}
              <title>{c.label}</title>
            </circle>
          ))}
        </svg>
        {hover && (
          <div
            className="tooltip is-fixed"
            style={{
              left: `${(hover.x / WORLD_VIEWBOX.w) * 100}%`,
              top: `${(hover.y / WORLD_VIEWBOX.h) * 100}%`,
              transform: 'translate(-50%, -140%)', position: 'absolute', pointerEvents: 'none',
            }}
          >
            {hover.label}
          </div>
        )}
      </div>

      {/* What the map is NOT showing. Said plainly, because a map that looks
          complete and is not would understate how spread out the network is. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        {pm.located.length} of {pm.connected} peers placed
        {pm.pending > 0 && <> · {pm.pending} still resolving</>}
        {pm.unplaceable > 0 && <> · {pm.unplaceable} not in the index</>}
        {pm.pending === 0 && pm.unplaceable === 0 && <> · complete</>}
        {/* Without this the mark count contradicts the peer count above, and
            the map looks like it lost most of them. */}
        {clustered && <> · dots sized by how many share a location</>}
      </p>

      {byCountry.length > 0 && (
        <div className="row" style={{ gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {byCountry.slice(0, 8).map(([c, n]) => (
            <span key={c} className="muted" style={{ fontSize: 12 }}>
              {c} <strong style={{ color: 'var(--text-secondary)' }}>{n}</strong>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
