import { useMemo, useState } from 'react';
import type { State } from './api';
import { WORLD_PATH, WORLD_VIEWBOX, project } from './worldPath';

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
 * One dot per peer at its coordinates, plus this node marked distinctly. Dots
 * are drawn with transparency rather than clustered: overlapping peers in the
 * same datacentre read as a brighter spot, which is the truth about how Swarm
 * is distributed and would be hidden by a count-in-a-circle.
 */
export function PeerMap({ state }: { state: State | null }) {
  const pm = state?.peerMap;
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  const dots = useMemo(() => (pm?.located ?? []).map((p) => {
    const { x, y } = project(p.lon, p.lat);
    return {
      x, y, overlay: p.overlay,
      label: [p.city, p.country].filter(Boolean).join(', ') || p.overlay.slice(0, 10),
    };
  }), [pm?.located]);

  /** Countries, most peers first — the map shows position, this names it. */
  const byCountry = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of pm?.located ?? []) {
      const c = p.country;
      if (c) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [pm?.located]);

  if (!pm) return null;

  // This node is deliberately not plotted. Its own coordinates would have to
  // come from the same index, and we do not fetch them — marking it at a
  // guessed position would be the one dot on the map that is made up.

  return (
    <div className="card">
      <div className="card-head">
        <div className="spread">
          <h2>Peers</h2>
          <span className="status">
            {pm.connected} connected
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          The nodes this one is connected to. Bee knows who they are; where they are comes from an
          outside index, resolved a few at a time and remembered.
        </p>
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${WORLD_VIEWBOX.w} ${WORLD_VIEWBOX.h}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`World map of ${dots.length} connected peers`}
        >
          {/* Land, recessive: it is the reference frame, not the reading. */}
          <path d={WORLD_PATH} fill="var(--map-empty)" stroke="var(--grid)" strokeWidth="0.5" />
          {dots.map((d, i) => (
            <circle
              key={d.overlay + i}
              className="peer-dot"
              cx={d.x} cy={d.y} r={3.2}
              fill="var(--good)" fillOpacity={0.55}
              onMouseEnter={() => setHover({ x: d.x, y: d.y, label: d.label })}
              onMouseLeave={() => setHover(null)}
            />
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
        {dots.length} of {pm.connected} peers placed
        {pm.pending > 0 && <> · {pm.pending} still resolving</>}
        {pm.unplaceable > 0 && <> · {pm.unplaceable} not in the index</>}
        {pm.pending === 0 && pm.unplaceable === 0 && <> · complete</>}
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
