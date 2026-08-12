import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import type { Batch, Ladder, Quote, State, Action } from './api';

const DAY = 86_400;

/** Severity for a batch's remaining life, against the configured threshold. */
function ttlSeverity(days: number, thresholdDays: number): 'good' | 'warning' | 'critical' {
  if (days <= 0) return 'critical';
  if (days < thresholdDays) return 'warning';
  return 'good';
}

function fmtDays(d: number) {
  if (!isFinite(d)) return '∞';
  if (d >= 365) return `${(d / 365).toFixed(1)} yr`;
  return `${d.toFixed(d < 10 ? 1 : 0)} d`;
}

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [token, setTok] = useState(api.getToken());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.getState(), api.getActions()]);
      setState(s); setActions(a); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  // The API is protected by the admin token, not by the proxy, so the page
  // itself is served to anyone — it is inert without a token. Treat "no token"
  // and "rejected token" as the same thing: show the login.
  const needsToken = err !== null && /401|403|admin token|disabled/i.test(err);
  if (needsToken || (err && !state)) {
    const disabled = /disabled/i.test(err ?? '');
    return (
      <div className="wrap">
        <h1>Swarm stamp monitor</h1>
        <div className="card" style={{ maxWidth: 520 }}>
          <h2 style={{ marginBottom: 12 }}>{disabled ? 'Admin API disabled' : 'Admin token required'}</h2>
          {disabled ? (
            <p className="secondary">
              The service is running without an admin token, so the admin API is switched off
              rather than left open. Set <code>ADMIN_TOKEN_FILE</code> (a swarm secret) or
              <code> ADMIN_TOKEN</code> and restart.
            </p>
          ) : (
            <p className="secondary">
              This dashboard can buy postage batches, so every call is authenticated by the
              service itself. The token is kept in this browser only.
            </p>
          )}
          {!disabled && (
            <form className="row" style={{ marginTop: 12 }}
              onSubmit={(e) => { e.preventDefault(); api.setToken(token.trim()); setErr(null); load(); }}>
              <input type="password" value={token} placeholder="admin token" autoFocus
                style={{ flex: 1, minWidth: 240 }}
                onChange={(e) => setTok(e.target.value)} />
              <button className="primary" type="submit" disabled={!token.trim()}>Unlock</button>
            </form>
          )}
          {err && !disabled && <div className="warn err" style={{ marginTop: 12 }}>{err}</div>}
        </div>
      </div>
    );
  }

  if (!state) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const armed = state.config.autoTopupEnabled && !state.config.dryRun;

  return (
    <div className="wrap">
      <div className="spread" style={{ marginBottom: 16 }}>
        <h1>Swarm stamp monitor</h1>
        <div className="row">
          <span className={`status ${state.ok ? 'good' : 'critical'}`}>
            {state.ok ? 'node reachable' : 'node unreachable'}
          </span>
          {armed && (
            <span className="status good" title="Batches below the TTL threshold are topped up automatically, within the configured spend caps.">
              auto top-up on
            </span>
          )}
          <button onClick={async () => { setBusy(true); await api.poll().catch(() => {}); await load(); setBusy(false); }}
            disabled={busy}>{busy ? 'Polling…' : 'Poll now'}</button>
          <button onClick={() => { api.setToken(''); setTok(''); setState(null); setErr('admin token required'); }}
            title="Forget the token stored in this browser">Sign out</button>
        </div>
      </div>

      {/* Armed is the intended steady state, so it gets no banner — only the
          quiet chip in the header. A permanent warning on normal operation
          just teaches you to ignore banners, and then the one that matters
          gets ignored too. Disarmed is the exceptional state and the one
          worth interrupting for: it is precisely the condition in which a
          batch expires unnoticed, which is what this service exists to
          prevent. */}
      {!armed && (
        <div className="banner warn">
          Auto top-up is OFF ({!state.config.autoTopupEnabled ? 'AUTO_TOPUP_ENABLED=false' : 'DRY_RUN=true'})
          {' '}— batches are still monitored, but nothing is topped up. Stamps can expire.
        </div>
      )}

      <Overview state={state} />
      <Batches state={state} onChange={load} />
      <Wizard state={state} onDone={load} />
      <Actions actions={actions} />
    </div>
  );
}

/** Hero + stat tiles. Runway is the hero because it is the number that
 *  actually explains why stamps lapse. Exactly one hero per view. */
function Overview({ state }: { state: State }) {
  const runway = state.runwayDays;
  const sev = runway < 30 ? 'critical' : runway < 90 ? 'warning' : 'good';
  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <div className="hero-label">Runway at the current burn rate</div>
          <div className="hero-value">
            {isFinite(runway) ? Math.round(runway).toLocaleString() : '∞'}
            <span className="hero-unit">days</span>
          </div>
          <div className={`status ${sev}`} style={{ marginTop: 6 }}>
            {sev === 'good' ? 'comfortable' : sev === 'warning' ? 'under three months' : 'under a month'}
          </div>
        </div>
      </div>
      <div className="tiles">
        <Tile label="Wallet" value={`${state.wallet?.bzz.toFixed(2) ?? '—'}`} sub="BZZ" />
        <Tile label="Gas" value={`${state.wallet?.xdai.toFixed(2) ?? '—'}`} sub="xDAI" />
        <Tile label="Burn rate" value={state.burnPer30DaysBzz.toFixed(2)} sub="BZZ per 30 days" />
        <Tile label="Batches" value={String(state.batches.length)} sub={`block time ${(state.msPerBlock / 1000).toFixed(2)}s`} />
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

function Batches({ state, onChange }: { state: State; onChange: () => void }) {
  const threshold = state.config.topupWhenTtlBelowDays;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 12 }}>Batches</h2>
      {state.batches.length === 0 && <p className="muted">No batches on the node.</p>}
      {state.batches.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Label</th><th className="num">Depth</th><th>Remaining life</th>
                <th>Used of capacity</th><th className="num">Stored</th><th>Managed</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {state.batches.map((b) => <BatchRow key={b.batchID} b={b} threshold={threshold} onChange={onChange} />)}
            </tbody>
          </table>
        </div>
      )}
      {state.plans.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {state.plans.map((p, i) => (
            <div key={i} className={p.kind === 'blocked' ? 'warn err' : p.kind === 'none' ? '' : 'warn'}>
              <span className="muted">{p.kind}</span> — {p.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchRow({ b, threshold, onChange }: { b: Batch; threshold: number; onChange: () => void }) {
  const sev = ttlSeverity(b.ttlDays, threshold);
  const [label, setLabel] = useState(b.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setLabel(b.label); }, [b.label]);

  // The label lives on the Bee node, so a rename is a write to it — not just a
  // local edit. Only send when it actually changed.
  async function saveLabel() {
    if (label === b.label || !label.trim()) { setLabel(b.label); return; }
    setBusy(true); setErr(null);
    try { await api.patchBatch(b.batchID, { label: label.trim() }); onChange(); }
    catch (e: any) { setErr(e.message); setLabel(b.label); }
    setBusy(false);
  }

  async function toggleManaged() {
    setBusy(true); setErr(null);
    try { await api.patchBatch(b.batchID, { managed: !b.managed }); onChange(); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  }
  // TTL bar is relative to a 90-day full scale, clamped.
  const ttlPct = Math.max(2, Math.min(100, (b.ttlDays / 90) * 100));
  const usePct = Math.max(0.5, Math.min(100, b.utilizationRatio * 100));
  return (
    <tr>
      <td>
        <input
          type="text" value={label} disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setLabel(b.label); }}
          style={{ width: 150, padding: '4px 6px', fontSize: 13 }}
          title="Renames the batch on the Bee node"
        />
        {err && <div className="warn err" style={{ marginTop: 4, fontSize: 12 }}>{err}</div>}
      </td>
      <td className="num mono">{b.depth}</td>
      <td>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span className={`meter ${sev}`} style={{ width: 90 }}><i style={{ width: `${ttlPct}%` }} /></span>
          <span className="mono" style={{ minWidth: 52 }}>{fmtDays(b.ttlDays)}</span>
        </div>
      </td>
      <td>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span className="meter" style={{ width: 90 }}><i style={{ width: `${usePct}%` }} /></span>
          <span className="mono secondary" style={{ minWidth: 46 }}>{(b.utilizationRatio * 100).toFixed(2)}%</span>
        </div>
      </td>
      <td className="num mono">{b.storedHuman} <span className="muted">/ {b.capacityHuman}</span></td>
      <td>
        <button onClick={toggleManaged} disabled={busy} style={{ padding: '4px 10px', fontSize: 12 }}
          title={b.managed
            ? 'Topped up automatically. Click to leave it alone — it will expire on its own.'
            : 'Never topped up; its expiry raises no alert. Click to manage it again.'}>
          {b.managed ? 'managed' : 'unmanaged'}
        </button>
      </td>
      <td className="secondary" style={{ fontSize: 12 }}>
        {b.usable ? '' : 'unusable '}{b.immutableFlag ? 'immutable' : 'mutable'}
      </td>
    </tr>
  );
}

/** The sizing wizard. Two sliders drive a live quote; the bar chart shows how
 *  steeply cost climbs with depth, which is the decision this tool exists for. */
function Wizard({ state, onDone }: { state: State; onDone: () => void }) {
  const [days, setDays] = useState(30);
  const [depth, setDepth] = useState(18);
  const [label, setLabel] = useState('');
  const [ladder, setLadder] = useState<Ladder | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Size the recommendation against what is actually stored today.
  const storedBytes = useMemo(() => {
    const b = state.batches[0];
    if (!b) return undefined;
    return String(Math.round(b.utilizationRatio * Math.pow(2, b.depth) * 4096));
  }, [state.batches]);

  useEffect(() => {
    api.getLadder(days, storedBytes).then(setLadder).catch(() => setLadder(null));
  }, [days, storedBytes]);

  useEffect(() => {
    if (ladder?.recommended) setDepth(ladder.recommended.depth);
  }, [ladder?.recommended?.depth]);

  const selected: Quote | undefined = ladder?.ladder.find((q) => q.depth === depth);
  // Show a window around the choice: the full ladder spans 32000x and would
  // render every small bar as a sliver.
  const window = useMemo(
    () => (ladder?.ladder ?? []).filter((q) => q.depth >= depth - 1 && q.depth <= depth + 3),
    [ladder, depth],
  );
  const max = Math.max(...window.map((q) => q.costBzz), 0.0001);

  async function doBuy(confirm: boolean) {
    setBusy(true); setResult(null);
    try {
      const r = await api.buy({ depth, days, label: label || undefined, confirm });
      if (r.confirmRequired) setResult(`Priced at ${r.preview.costBzz.toFixed(3)} BZZ — press Buy again to commit.`);
      else if (r.dryRun) setResult(`DRY_RUN is on — would have bought depth ${depth} for ${r.wouldBuy.costBzz.toFixed(3)} BZZ.`);
      else { setResult(`Bought batch ${r.batchId.slice(0, 16)}… for ${r.cost.costBzz.toFixed(3)} BZZ.`); onDone(); }
    } catch (e: any) { setResult(`Failed: ${e.message}`); }
    setBusy(false);
  }

  return (
    <div className="card">
      <h2 style={{ marginBottom: 12 }}>Stamp wizard</h2>

      <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 220px' }}>
          <label className="field" htmlFor="depth">
            Size — depth {depth} · {selected?.capacityHuman ?? '—'}
          </label>
          <input id="depth" type="range" min={17} max={28} step={1} value={depth}
            onChange={(e) => setDepth(Number(e.target.value))} />
          <div className="row spread muted" style={{ fontSize: 11 }}>
            <span>17 · 537 MB</span><span>28 · 1.1 TB</span>
          </div>
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <label className="field" htmlFor="days">Duration — {days} days</label>
          <input id="days" type="range" min={7} max={365} step={1} value={days}
            onChange={(e) => setDays(Number(e.target.value))} />
          <div className="row spread muted" style={{ fontSize: 11 }}>
            <span>7 d</span><span>365 d</span>
          </div>
        </div>
      </div>

      {selected && (
        <div className="tiles" style={{ marginTop: 20 }}>
          <Tile label="Cost now" value={selected.costBzz.toFixed(3)} sub="BZZ" />
          <Tile label="To keep alive" value={selected.costPer30DaysBzz.toFixed(3)} sub="BZZ per 30 days" />
          <Tile label="Capacity" value={selected.capacityHuman} sub={`depth ${selected.depth}`} />
          <Tile label="Runway after" value={fmtDays(selected.runwayDaysAfter)} sub="at the resulting burn" />
        </div>
      )}

      {ladder?.recommended && (
        <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent', paddingLeft: 12 }}>
          <strong>Recommended: depth {ladder.recommended.depth}.</strong> {ladder.recommended.reason}
        </div>
      )}
      {selected?.warnings.map((w, i) => <div className="warn" key={i}>{w}</div>)}
      {selected && !selected.affordable && <div className="warn err">Wallet cannot cover this purchase.</div>}

      {window.length > 0 && (
        <figure style={{ margin: '20px 0 0' }}>
          <figcaption className="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            Cost for {days} days, by depth — each step doubles
          </figcaption>
          <div className="bars">
            {window.map((q) => (
              <div key={q.depth}
                className={`bar-row ${q.depth === depth ? 'is-selected' : 'is-dim'}`}
                title={`depth ${q.depth} · ${q.capacityHuman} · ${q.costBzz.toFixed(3)} BZZ`}>
                <span className="mono secondary" style={{ fontSize: 12 }}>d{q.depth}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${Math.max(1, (q.costBzz / max) * 100)}%` }} />
                </span>
                <span className="mono" style={{ fontSize: 12, minWidth: 92, textAlign: 'right' }}>
                  {q.costBzz.toFixed(3)} BZZ
                </span>
              </div>
            ))}
          </div>
        </figure>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <input type="text" placeholder="label (e.g. pinkchainsaw)" value={label}
          onChange={(e) => setLabel(e.target.value)} />
        <button className="primary" disabled={busy || !selected?.affordable} onClick={() => doBuy(false)}>
          Price it
        </button>
        <button disabled={busy || !selected?.affordable} onClick={() => doBuy(true)}>
          Buy batch
        </button>
      </div>
      {result && <div className={`warn ${result.startsWith('Failed') ? 'err' : ''}`}>{result}</div>}
    </div>
  );
}

function Actions({ actions }: { actions: Action[] }) {
  return (
    <div className="card">
      <h2 style={{ marginBottom: 12 }}>Recent actions</h2>
      {actions.length === 0 && <p className="muted">Nothing yet.</p>}
      {actions.length > 0 && (
        <div className="scroll-x">
          <table>
            <thead>
              <tr><th>When</th><th>Kind</th><th>Status</th><th className="num">Cost</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td className="mono secondary" style={{ fontSize: 12 }}>
                    {new Date(a.ts).toLocaleString()}
                  </td>
                  <td>{a.kind}</td>
                  <td>
                    <span className={`status ${a.status === 'confirmed' ? 'good'
                      : a.status === 'blocked' ? 'warning'
                      : a.status === 'failed' ? 'critical' : ''}`}>{a.status}</span>
                  </td>
                  <td className="num mono">{(Number(a.cost) / 1e16).toFixed(3)}</td>
                  <td className="secondary" style={{ fontSize: 12 }}>{a.error ?? a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
