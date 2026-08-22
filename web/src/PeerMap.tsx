import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { State } from './api';
import { WORLD_PATH, WORLD_VIEWBOX, project } from './worldPath';
import { clusterPeers, clusterRadius, type PeerPoint } from './peerCluster';

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
 *
 * This node is drawn too, as the hub the links converge on — but ONLY when the
 * server resolved a real position for it. Everything here refuses to invent a
 * coordinate: an unplaceable node is stated in words, never approximated,
 * because one made-up dot among real ones is indistinguishable from the rest.
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
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Measured synchronously BEFORE the first paint. Waiting for the observer
    // meant one frame drawn at the 1000px default, which on a phone is every
    // dot at a third of its size — a visible flash, and the reason a headless
    // snapshot caught marks far smaller than they render.
    const measure = () => setWidth(el.getBoundingClientRect().width || 1000);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width || 1000));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const base = Math.max(2.0, (2.2 * WORLD_VIEWBOX.w) / Math.max(width, 1));

  const clusters = useMemo(
    () => clusterPeers((pm?.located ?? []) as PeerPoint[]),
    [pm?.located],
  );

  /**
   * This node, projected — or nothing.
   *
   * The server sends a position only when it resolved one for real. There is
   * deliberately no fallback here: a centred-on-the-map default would be
   * indistinguishable from a true reading.
   */
  const me = useMemo(() => {
    const sp = pm?.self;
    if (!sp) return null;
    const { x, y } = project(sp.lon, sp.lat);
    const place = [sp.city, sp.country].filter(Boolean).join(', ');
    return { x, y, label: place ? `This node — ${place}` : 'This node' };
  }, [pm?.self]);

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

          {/* Links first, so every dot sits on top of them. Drawn only when
              this node has a real position — lines radiating from a guessed
              origin would make the guess look like the most certain thing on
              the map. Width scales with the cluster, so a link carrying 19
              peers is not the same stroke as one carrying 1. */}
          {me && clusters.map((c) => (
            <line
              key={`l-${c.key}`}
              className="peer-link"
              x1={me.x} y1={me.y} x2={c.x} y2={c.y}
              strokeWidth={Math.min(1.6, 0.35 + 0.14 * Math.sqrt(c.count))}
            />
          ))}

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

          {/* This node last, so it is never covered by a peer sitting on it.
              Colour alone does not carry it: it is also the only ringed mark
              and the only one every line converges on. */}
          {me && (
            <g
              onMouseEnter={() => setHover({ x: me.x, y: me.y, label: me.label })}
              onMouseLeave={() => setHover(null)}
            >
              {/* A halo, not a bigger dot. Peer marks are sized by how many
                  peers they carry, so enlarging this one would read as "this
                  location has many nodes". The ring says "you are here"
                  without entering that scale at all — which matters because
                  a 19-peer cluster is otherwise three times this mark. */}
              <circle className="self-halo" cx={me.x} cy={me.y} r={base * 3.4} />
              <circle className="self-dot" cx={me.x} cy={me.y} r={base * 1.6} />
              <title>{me.label}</title>
            </g>
          )}
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

      {/* A legend, because two colours alone must not be what tells the marks
          apart — and because "which dot is mine" is the first question the
          map now invites. */}
      <div className="row" style={{ gap: 16, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {me && (
          <span className="muted" style={{ fontSize: 12 }}>
            <span className="map-key is-self" /> this node
          </span>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          <span className="map-key is-peer" /> peers
        </span>
      </div>

      {/* Said plainly rather than left blank. The node is not missing from the
          network, it is missing from the index — and inventing a position to
          fill the gap is the one thing this map must not do. */}
      {!me && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          This node is not drawn: neither the index nor its advertised address gave a position.
        </p>
      )}

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
