import { shortAddr } from './format';
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
          {/* Two chips, because they answer opposite questions and a node can
              fail either one alone. "healthy" is whether WE can reach its API;
              "reachable" is whether the NETWORK can dial it. The homelab node
              was healthy and undialable for six weeks — one chip could not
              have said that. */}
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`status ${state.ok && n?.healthy ? 'good' : 'critical'}`}
              title={state.ok && n?.healthy
                ? 'The API answers, so every figure here is current'
                : 'The API does not answer; figures are the last good reading'}>
              {state.ok && n?.healthy ? 'healthy' : 'unreachable'}
            </span>
            {dialable && (
              <span className="status good" title="Peers can dial this node from the internet">
                reachable
              </span>
            )}
            {undialable && (
              <span className="status critical" title={r?.error ?? 'no inbound connection'}>
                undialable
              </span>
            )}
            {/* No chip when unknown: an observer being down is not evidence,
                and a green one there would be a claim nobody made. */}
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          The node this manages. Everything below is read from it, so when it is unreachable the
          rest of the page is the last good reading rather than the current one.
        </p>
      </div>

      <div className="tiles">
        <div>
          <div className="tile-label">Version</div>
          {/* Same size as every other tile in this grid. It was shrunk on the
              assumption a version string is long, but the displayed form is
              just "2.8.1" — the commit suffix is already stripped. */}
          <div className="tile-value">{n?.version ? n.version.split('-')[0] : '—'}</div>
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
          <>Dialed from outside
            {r?.handshakeMs != null && <> in {r.handshakeMs} ms</>}
            {r?.userAgent && <>, seen as {r.userAgent.split(' ')[0]}</>}
            {r?.lastCheckedAt && <> · {new Date(r.lastCheckedAt).toLocaleString()}</>}
          </>
        )}
        {undialable && (
          <>Not dialable from the internet{r?.error ? ` — ${r.error}` : ''}.</>
        )}
        {/* Unknown says so. An observer that is down is not evidence the node
            is fine, and a blank space here would read as one. */}
        {!dialable && !undialable && <>Reachability unknown — no outside view available right now.</>}
      </p>

      {/* Abbreviated for the same reason as the wallet address: 64 hex
          characters do not fit a phone, and at full width it pushed the card
          wider than the screen. The whole value is in the title. */}
      {n?.overlay && (
        <p className="muted" style={{ fontSize: 11, marginTop: 8 }} title={n.overlay}>
          overlay <span className="mono">{shortAddr(n.overlay, 8, 6)}</span>
        </p>
      )}
    </div>
  );
}
