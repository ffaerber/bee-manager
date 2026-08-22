import type { State } from './api';

/**
 * The node itself, above everything it holds.
 *
 * These facts were scattered: version and peers sat in a tile inside the
 * batches card, block time beside them, reachability only in the header chip.
 * They describe the machine, not the money, and putting them first means the
 * page reads top-down as "here is the node, here is what it has, here is what
 * it is doing".
 *
 * Peers deserves a caveat rather than a bare number, which is the whole reason
 * the reachability line sits next to it: a node nobody can dial still reports a
 * full peer table, because every one of those connections is outbound. The two
 * figures together say something the peer count alone cannot.
 */
export function BeeNode({ state }: { state: State | null }) {
  if (!state) return null;
  const n = state.node;
  const r = state.reachability;

  const dialable = r?.unreachable === false;
  const undialable = r?.unreachable === true;

  return (
    <div className="card">
      <div className="card-head">
        <div className="spread">
          <h2>Bee node</h2>
          <span className={`status ${state.ok && n?.healthy ? 'good' : 'critical'}`}>
            {state.ok && n?.healthy ? 'healthy' : 'unreachable'}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          The node this manages. Everything below is read from it, so when it is unreachable the
          rest of the page is the last good reading rather than the current one.
        </p>
      </div>

      <div className="tiles">
        <div>
          <div className="tile-label">Version</div>
          <div className="tile-value" style={{ fontSize: 18 }}>
            {n?.version ? n.version.split('-')[0] : '—'}
          </div>
          <div className="tile-sub">{n?.beeMode ? `${n.beeMode} node` : 'bee'}</div>
        </div>
        <div>
          <div className="tile-label">Peers</div>
          <div className="tile-value">{n?.peers != null ? n.peers : '—'}</div>
          {/* The caveat that matters: this counts connections in both
              directions, and a node behind a broken forward still fills it
              with outbound ones. */}
          <div className="tile-sub">
            {undialable ? 'all outbound — see below' : 'connected'}
          </div>
        </div>
        <div>
          <div className="tile-label">Block time</div>
          <div className="tile-value">{(state.msPerBlock / 1000).toFixed(2)}<span className="tile-unit">s</span></div>
          {/* Measured from successive chainstate reads, not assumed to be the
              nominal 5s. Every TTL and top-up figure is derived from it. */}
          <div className="tile-sub">measured, not assumed</div>
        </div>
        <div>
          <div className="tile-label">Storage radius</div>
          <div className="tile-value">{n?.storageRadius != null ? n.storageRadius : '—'}</div>
          <div className="tile-sub">depth of its neighbourhood</div>
        </div>
      </div>

      {/* Reachability as a sentence rather than a tile: "false" is not a
          number, and the useful version of it names what was tried. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
        {dialable && (
          <>Reachable from the internet
            {r?.handshakeMs != null && <> · handshake {r.handshakeMs} ms</>}
            {r?.userAgent && <> · seen as {r.userAgent.split(' ')[0]}</>}
          </>
        )}
        {undialable && (
          <>Not dialable from the internet{r?.error ? ` — ${r.error}` : ''}.</>
        )}
        {/* Unknown says so. An observer that is down is not evidence the node
            is fine, and a blank space here would read as one. */}
        {!dialable && !undialable && <>Reachability unknown — no outside view available right now.</>}
      </p>

      {n?.overlay && (
        <p className="muted" style={{ fontSize: 11, marginTop: 8, wordBreak: 'break-all' }}>
          overlay {n.overlay}
        </p>
      )}
    </div>
  );
}
