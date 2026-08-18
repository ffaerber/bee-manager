import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from './api';
import { TOKEN } from './api';
import { BatchDetail } from './BatchDetail';
import { batchIdFrom, isSettings, link, navigate, usePath } from './router';
import { Settings } from './Settings';
import { Wallet } from './Wallet';
import { Chequebook } from './Chequebook';
import { countdown, fmtDays, runwayRemainingMs, ttlSeverity } from './format';
import { Modal } from './Modal';
import type { Batch, Ladder, Quote, State, Action } from './api';

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [notReady, setNotReady] = useState<string | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [token, setTok] = useState(api.getToken());
  const path = usePath();
  const batchId = batchIdFrom(path);
  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([api.getState(), api.getActions()]);
      // A successful fetch is NOT proof of a usable State. Until the first poll
      // completes, /state answers HTTP 200 with {ok:false, error} — req() only
      // throws on a bad status, so that half-built object used to be assigned
      // here and then dereferenced, white-screening both the dashboard
      // (state.config.autoTopupEnabled) and the batch page
      // (state.batches.find) on every restart until the poll landed.
      //
      // Every consumer already handles null; none of them handle half a State.
      if (!s || !(s as Partial<State>).config) {
        setState(null);
        setNotReady((s as { error?: string } | undefined)?.error ?? 'waiting for the first poll');
        setErr(null);
        return;
      }
      setNotReady(null);
      setState(s); setActions(a); setErr(null);
    } catch (e: any) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  // Shared, because the control that does this now lives on /settings while
  // the state it has to clear lives here.
  const signOut = useCallback(() => {
    api.setToken(''); setTok(''); setState(null); setErr('admin token required');
  }, []);

  // The API is protected by the admin token, not by the proxy, so the page
  // itself is served to anyone — it is inert without a token. Treat "no token"
  // and "rejected token" as the same thing: show the login.
  const needsToken = err !== null && /401|403|admin token|disabled/i.test(err);
  if (needsToken || (err && !state)) {
    const disabled = /disabled/i.test(err ?? '');
    return (
      <div className="wrap">
        <h1 className="brand">Swarm stamp monitor</h1>
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

  if (isSettings(path)) return <Settings state={state} onPolled={load} onSignOut={signOut} />;
  if (batchId) return <BatchDetail batchId={batchId} state={state} onChange={load} />;

  if (!state) return <div className="wrap"><p className="muted">{notReady ?? 'Loading…'}</p></div>;

  const armed = state.config.autoTopupEnabled && !state.config.dryRun;

  return (
    <div className="wrap">
      {/* Service status and the controls that act on the service itself now
          live on /settings. What is left here is the batches — the header
          carries identity and the way out, nothing that needs reading. */}
      <div className="spread" style={{ marginBottom: 16 }}>
        <h1 className="brand">Swarm stamp monitor</h1>
        <a className="backlink" {...link('/settings')}>Settings</a>
      </div>

      {/* Armed is the intended steady state, so it gets no banner — only the
          quiet chip in the header. A permanent warning on normal operation
          just teaches you to ignore banners, and then the one that matters
          gets ignored too. Disarmed is the exceptional state and the one
          worth interrupting for: it is precisely the condition in which a
          batch expires unnoticed, which is what this service exists to
          prevent. */}
      {/* The healthy chip moved to /settings, but an unreachable node cannot
          only be visible on a page you have to go looking for: every figure
          below is then stale and nothing says so. Steady state is silent,
          the exception interrupts — the same rule the auto top-up banner
          below follows. */}
      {!state.ok && (
        <div className="banner warn err">
          Node unreachable{state.error ? ` — ${state.error}` : ''}. Everything below is the last
          good reading, not the current one, and nothing is being topped up while this lasts.
        </div>
      )}

      {!armed && (
        <div className="banner warn">
          Auto top-up is OFF ({!state.config.autoTopupEnabled ? 'AUTO_TOPUP_ENABLED=false' : 'DRY_RUN=true'})
          {' '}— batches are still monitored, but nothing is topped up. Stamps can expire.
        </div>
      )}

      <Overview state={state} />
      <Wallet state={state} />
      <Chequebook state={state} />
      <Batches state={state} onChange={load} />
      <Actions actions={actions} />
    </div>
  );
}

/** Hero + stat tiles. Runway is the hero because it is the number that
 *  actually explains why stamps lapse. Exactly one hero per view. */
function Overview({ state }: { state: State }) {
  // The HERO is the total runway: wallet plus what the batches are already
  // paid up for. It is the only one that genuinely counts down — the committed
  // half drains every block at exactly the burn rate, so it falls at one
  // second per second. Wallet-over-burn is flat between top-ups and would make
  // any ticking clock a fiction, which is why it sits in a tile instead.
  const runway = state.totalRunwayDays;
  // Null means nothing is burning, so there is no bound to be short of. It has
  // to be tested BEFORE the comparisons: `null < 30` is true, which would
  // report the most comfortable possible state as the most critical one.
  const sev = runway == null ? 'good' : runway < 30 ? 'critical' : runway < 90 ? 'warning' : 'good';
  /**
   * Fiat sub-line, e.g. "≈ $8.27". No period suffix: the tile's label already
   * says whether the figure is a balance or a rate.
   */
  const fiat = (bzz: number | undefined) => {
    const usd = usdOf(bzz, state.fiat);
    return usd == null ? undefined : `≈ $${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
  };
  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <div className="hero-label">Runway until everything lapses</div>
          <Runway days={runway} sev={sev} ageMs={state.dataAgeMs} />
          {/* Finer than the severity bands below a month. "Under a month" is
              true with seven hours left, and true is not the same as useful —
              the pill should not undersell what the clock beside it is
              saying. */}
          <div className={`status ${sev}`} style={{ marginTop: 14 }}>
            {runway == null ? 'nothing is burning'
              : runway < 1 ? 'under a day'
              : runway < 2 ? 'under two days'
              : runway < 7 ? 'under a week'
              : runway < 30 ? 'under a month'
              : runway < 90 ? 'under three months'
              : 'comfortable'}
          </div>
        </div>
      </div>
      <div className="tiles">
        {/* Balances live in the wallet card below; repeating them here made
            two places to read the same number and disagree about it. */}
        {/* "per 30 days", not "per month": the figure is literally a 30-day
            rate, and a calendar month averages 30.44 days. */}
        {/* Wallet-only runway. Kept on screen because it answers a different
            question from the hero — not "how long until things lapse" but
            "how long can I keep paying to stop them" — and because it is the
            figure the low-wallet alert is defined against. */}
        <Tile label="Wallet runway"
          value={state.runwayDays == null ? '∞' : Math.round(state.runwayDays).toLocaleString()}
          unit={state.runwayDays == null ? undefined : 'd'}
          sub={state.runwayDays == null ? 'nothing is burning' : 'funds future top-ups'} />
        <Tile label="Burn rate per 30 days" value={state.burnPer30DaysBzz.toFixed(2)} unit={TOKEN}
          fiat={fiat(state.burnPer30DaysBzz)} />
        <Tile label="Prepaid in batches" value={state.committedBzz.toFixed(2)} unit={TOKEN}
          fiat={fiat(state.committedBzz)} />
        <Tile label="Batches" value={String(state.batches.length)}
          sub={`${state.batches.filter((b) => b.managed).length} managed`} />
        <Tile label="Node" value={state.node?.peers != null ? String(state.node.peers) : '—'}
          sub={state.node?.version ? `peers · ${state.node.version.split('-')[0]}` : 'peers'} />
        <Tile label="Block time" value={(state.msPerBlock / 1000).toFixed(2)} unit="s"
          sub="measured, not assumed" />
      </div>
      {state.fiat && <PriceNote fiat={state.fiat} />}
    </div>
  );
}

/**
 * The runway, counting down live.
 *
 * The server computes it at poll time; between polls it keeps running down in
 * the real world. So the clock is anchored to the moment the figure arrived
 * and elapsed time is subtracted from it — that is what makes it a true
 * reading rather than a decorative ticker, and it re-anchors on every poll so
 * it cannot drift away from the server's own arithmetic.
 *
 * Its own component so the 1 Hz tick re-renders eleven characters rather than
 * the whole card and its four tiles.
 *
 * Worth being clear about what the seconds mean: the runway is wallet ÷ burn
 * rate, an estimate that moves whenever a batch is topped up or the chain
 * price changes. The seconds are exact about elapsed time, not about the
 * prediction — this is a rate of consumption made visible, not a deadline.
 */
/**
 * Below this, the seconds are worth watching. Above it they are just motion.
 *
 * At 144 days a ticking seconds field says nothing a reader can act on, and
 * a number that never stops moving is one the eye keeps returning to for no
 * reward. Inside two days the same field is the whole point.
 */
const CLOCK_BELOW_MS = 48 * 3_600_000;

function Runway({ days, sev, ageMs }: { days: number | null; sev: string; ageMs: number }) {
  const anchor = useMemo(() => ({ at: Date.now(), days, ageMs }), [days, ageMs]);
  const [, tick] = useState(0);

  // Two subtractions, because the figure was already stale when it arrived.
  // /state serves a cached poll, so `ageMs` is how long the SERVER says it has
  // been running (server clock, immune to a wrong browser clock), and the
  // second term is how long it has been since this tab received it. Without
  // the first, the clock runs up to a full poll interval ahead of the truth
  // and lurches backwards every time a fresh poll lands.
  //
  // Computed before the early return so the hooks below stay unconditional.
  const remainingMs = anchor.days == null || !Number.isFinite(anchor.days)
    ? Infinity
    : runwayRemainingMs(anchor.days, anchor.ageMs, Date.now() - anchor.at);
  const close = Number.isFinite(remainingMs) && remainingMs < CLOCK_BELOW_MS;

  useEffect(() => {
    // No timer at all in the ordinary case. The parent re-renders this on every
    // 30s poll, which is both enough to keep a day count current and enough to
    // notice the 48h crossing — so ticking at 1Hz for months would be pure
    // waste, not accuracy.
    if (!close) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [close]);

  // No burn means nothing is being consumed, so there is no clock to run.
  // `== null` rather than isFinite(): the global isFinite coerces null to 0 and
  // would send an unbounded runway down the counting path as zero.
  if (anchor.days == null || !Number.isFinite(anchor.days)) {
    return <div className={`hero-value ${sev}`}>∞<span className="hero-unit">days</span></div>;
  }

  const title = 'Wallet plus the value already paid into the batches, divided by the burn rate. '
    + 'The committed part drains every block, so this falls at one second per second. It jumps up '
    + 'when you deposit or buy, and moves if the chain price changes.';

  const { days: d, clock, done } = countdown(remainingMs);

  // Far out: the day count is the whole reading.
  if (!close) {
    return (
      <div className={`hero-value ${sev}`} title={title}>
        {d.toLocaleString()}
        <span className="hero-unit">{d === 1 ? 'day' : 'days'}</span>
      </div>
    );
  }

  // Inside a day the day count is a zero taking up the largest glyph on the
  // page, so the clock becomes the headline instead of sitting beside one.
  if (d === 0) {
    return (
      <div className={`hero-value is-clock ${sev}`} title={title}>
        {clock}
        {done && <span className="hero-unit">spent</span>}
      </div>
    );
  }

  return (
    <div className={`hero-value ${sev}`} title={title}>
      {d.toLocaleString()}
      <span className="hero-unit">d</span>
      <span className="hero-clock">{clock}</span>
    </div>
  );
}

/** USD for an xBZZ amount, or undefined when there is no quote to convert with. */
export function usdOf(bzz: number | undefined, fiat: State['fiat']): number | undefined {
  if (bzz == null || !fiat) return undefined;
  return bzz * fiat.usd;
}

/**
 * The quote's provenance, stated plainly.
 *
 * A fiat number with no source and no timestamp invites more trust than it has
 * earned — this one comes from a third party, can be minutes old, and plays no
 * part in any spending decision. Saying so costs one line.
 */
function PriceNote({ fiat }: { fiat: NonNullable<State['fiat']> }) {
  const mins = Math.round((Date.now() - fiat.fetchedAt) / 60_000);
  const chg = fiat.usd24hChange;
  return (
    <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
      BZZ ${fiat.usd.toFixed(4)} · €{fiat.eur.toFixed(4)}
      {chg !== 0 && (
        <span style={{ color: chg > 0 ? 'var(--good)' : 'var(--critical)' }}>
          {' '}{chg > 0 ? '▲' : '▼'}{Math.abs(chg).toFixed(1)}% 24h
        </span>
      )}
      {' '}· CoinGecko, {mins < 1 ? 'just now' : `${mins}m ago`} · display only; amounts above are xBZZ, bridged 1:1
    </p>
  );
}

/**
 * A stat tile: label, then the number with its unit, then at most one sub-line.
 *
 * The unit sits inline with the value rather than on its own line because a
 * bare number stacked above a unit reads as two facts. The period belongs in
 * the label ("Burn rate per 30 days"), never repeated in the unit and the fiat
 * line — stating it three ways was what made this tile hard to read.
 */
function Tile({ label, value, unit, sub, fiat }: {
  label: string; value: string; unit?: string; sub?: string; fiat?: string;
}) {
  return (
    <div>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {value}{unit && <span className="tile-unit">{unit}</span>}
      </div>
      {sub && <div className="tile-sub">{sub}</div>}
      {fiat && <div className="tile-sub" style={{ opacity: 0.75 }}>{fiat}</div>}
    </div>
  );
}

/** Remembered across reloads: a list you chose to fold should stay folded. */
function useSticky(key: string, initial: boolean) {
  const [v, setV] = useState<boolean>(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : raw === '1'; }
    catch { return initial; }
  });
  const set = (next: boolean) => {
    setV(next);
    try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* private mode */ }
  };
  return [v, set] as const;
}

/** The batch table, minus its heading — used once per section. */
function BatchTable({ rows, threshold }: { rows: Batch[]; threshold: number }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr><th>Batch</th><th>Remaining life</th><th>Capacity used</th></tr>
        </thead>
        <tbody>
          {rows.map((b) => <BatchRow key={b.batchID} b={b} threshold={threshold} />)}
        </tbody>
      </table>
    </div>
  );
}

function Batches({ state, onChange }: { state: State; onChange: () => void }) {
  const threshold = state.config.topupWhenTtlBelowDays;
  // Buying lives here rather than in its own panel: a new batch is a row in
  // this table, so the action belongs next to the thing it changes.
  const [creating, setCreating] = useState(false);
  const [hideUnmanaged, setHideUnmanaged] = useSticky('ssm.hideUnmanaged', false);

  const managed = state.batches.filter((b) => b.managed);
  const unmanaged = state.batches.filter((b) => !b.managed);

  /**
   * The soonest an unmanaged batch expires, kept visible even when the list is
   * folded away.
   *
   * Unmanaged means nothing renews it AND nothing alerts on it, so a hidden
   * list would be the only place its expiry was ever shown. Folding is meant
   * to remove noise, not to remove the one fact that still matters.
   */
  const soonest = unmanaged.length
    ? unmanaged.reduce((a, b) => (b.ttlDays < a.ttlDays ? b : a))
    : null;
  const soonestSev = soonest ? ttlSeverity(soonest.ttlDays, threshold) : 'good';

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2>Batches</h2>
        <div className="row" style={{ gap: 16 }}>
          {/* One key for both tables, so it is not repeated per section. */}
          <span className="row muted" style={{ gap: 12, flexWrap: 'nowrap', fontSize: 12 }}>
            <span className="row" style={{ gap: 5, flexWrap: 'nowrap' }}><BatchKind immutable={false} /> mutable</span>
            <span className="row" style={{ gap: 5, flexWrap: 'nowrap' }}><BatchKind immutable /> immutable</span>
          </span>
          <button className="primary" onClick={() => setCreating(true)}>Create batch</button>
        </div>
      </div>

      {state.batches.length === 0 && <p className="muted">No batches on the node.</p>}

      {managed.length > 0 && (
        <>
          <div className="tile-label" style={{ marginBottom: 6 }}>
            Managed · {managed.length} — topped up automatically, within the caps
          </div>
          <BatchTable rows={managed} threshold={threshold} />
        </>
      )}

      {unmanaged.length > 0 && (
        <div style={{ marginTop: managed.length ? 22 : 0 }}>
          <div className="spread" style={{ marginBottom: 6 }}>
            <span className="tile-label">
              Unmanaged · {unmanaged.length} — nothing renews these, and nothing alerts on them
            </span>
            <button onClick={() => setHideUnmanaged(!hideUnmanaged)} style={{ padding: '4px 10px', fontSize: 12 }}>
              {hideUnmanaged ? 'Show' : 'Hide'}
            </button>
          </div>
          {hideUnmanaged ? (
            <p className="tile-sub" style={{ marginTop: 0 }}>
              Hidden.{' '}
              {soonest && (
                <>
                  Soonest to expire is <strong>{soonest.label || soonest.batchID.slice(0, 10)}</strong>
                  {' '}in <strong style={{ color: soonestSev === 'good' ? undefined : `var(--${soonestSev})` }}>
                    {fmtDays(soonest.ttlDays)}
                  </strong>.
                </>
              )}
            </p>
          ) : (
            <BatchTable rows={unmanaged} threshold={threshold} />
          )}
        </div>
      )}

      {/* Deliberately not closed by onChange: after a purchase the wizard shows
          which batch it bought and what it cost, and that is the receipt. The
          table behind refreshes; the user closes when they have read it. */}
      {creating && (
        <Modal title="Create batch" onClose={() => setCreating(false)}>
          <Wizard state={state} onDone={onChange} />
        </Modal>
      )}
      <Plans plans={state.plans} batches={state.batches} />
    </div>
  );
}

/**
 * What the planner intends to do on the next cycle.
 *
 * `none` is by far the commonest verdict and means "nothing to do", so listing
 * one line per batch spends the most prominent space under the table restating
 * that everything is fine — and the raw kind (`none`) is an internal enum that
 * reads like a failure. The all-clear collapses to a single sentence; only
 * batches actually needing something get their own line.
 */
function Plans({ plans, batches }: { plans: State['plans']; batches: Batch[] }) {
  if (plans.length === 0) return null;
  const nameOf = (batchId: string) =>
    batches.find((b) => b.batchID === batchId)?.label || `${batchId.slice(0, 8)}…`;

  const actionable = plans.filter((p) => p.kind !== 'none');
  const quiet = plans.length - actionable.length;

  return (
    <div style={{ marginTop: 12 }}>
      {actionable.map((p, i) => (
        <div key={i} className={p.kind === 'blocked' ? 'warn err' : 'warn'}>
          <strong>{nameOf(p.batchId)}</strong>{' '}
          {p.kind === 'blocked' ? 'needs a top-up but is blocked' :
           p.kind === 'dilute' ? 'will be diluted, then topped up' :
           'will be topped up'} — {p.reason}
        </div>
      ))}
      {quiet > 0 && (
        <p className="muted" style={{ fontSize: 13, margin: actionable.length ? '8px 0 0' : 0 }}>
          No action needed for {quiet} managed batch{quiet === 1 ? '' : 'es'} — all above the top-up threshold.
        </p>
      )}
    </div>
  );
}

/**
 * Mutable or immutable, as a shape.
 *
 * Never shape alone: the word is always beside it — in the row's sub-line, and
 * in the title for anyone hovering or using a screen reader. The shape is what
 * makes a list of batches scannable; the word is what makes it unambiguous.
 */
export function BatchKind({ immutable }: { immutable: boolean }) {
  const label = immutable
    ? 'immutable — a full bucket ends this batch; it refuses further uploads until diluted'
    : 'mutable — a full bucket recycles this batch\'s oldest chunks instead of refusing';
  return (
    <span
      className={`kind ${immutable ? 'is-immutable' : 'is-mutable'}`}
      role="img"
      aria-label={immutable ? 'immutable batch' : 'mutable batch'}
      title={label}
    />
  );
}

function BatchRow({ b, threshold }: { b: Batch; threshold: number }) {
  const sev = ttlSeverity(b.ttlDays, threshold);
  const to = `/batch/${b.batchID}`;

  /**
   * The whole row is a click target, but the name stays a real <a>.
   *
   * A row-level handler alone would lose keyboard focus, middle-click,
   * ctrl-click and "copy link address" — everything that makes a link a link.
   * So the anchor carries those, and this only widens the mouse target.
   *
   * Ignored: clicks that land on a control, and clicks that end a text
   * selection, which is someone copying a label rather than navigating.
   */
  function onRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea')) return;
    if (window.getSelection()?.toString()) return;
    navigate(to);
  }
  // TTL bar is relative to a 90-day full scale, clamped.
  const ttlPct = Math.max(2, Math.min(100, (b.ttlDays / 90) * 100));
  const usePct = Math.max(0.5, Math.min(100, b.utilizationRatio * 100));
  const useSev = b.utilizationRatio >= 1 ? 'critical'
    : b.utilizationRatio >= 0.8 ? 'warning' : 'good';

  return (
    <tr className="is-clickable" onClick={onRowClick}>
      {/* Name, and the two facts that qualify it. Depth, flags, exact stored
          bytes and the managed toggle all moved to the batch page: this is a
          list for spotting the batch that needs attention, and everything else
          was detail you can only act on once you are there. */}
      <td>
        <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <BatchKind immutable={b.immutableFlag} />
          <a className="rowlink" {...link(to)} style={{ fontWeight: 600 }}>
            {b.label || `${b.batchID.slice(0, 10)}…`}
          </a>
        </span>
        <div className="tile-sub">
          depth {b.depth} · {b.capacityHuman} · {b.immutableFlag ? 'immutable' : 'mutable'}
          {!b.managed && ' · unmanaged'}
          {!b.usable && ' · unusable'}
        </div>
      </td>
      <td>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span className={`meter ${sev}`} style={{ width: 90 }}><i style={{ width: `${ttlPct}%` }} /></span>
          <span className="mono" style={{ minWidth: 52 }}>{fmtDays(b.ttlDays)}</span>
        </div>
      </td>
      <td>
        <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <span className={`meter ${useSev}`} style={{ width: 90 }}><i style={{ width: `${usePct}%` }} /></span>
          <span className="mono secondary" style={{ minWidth: 46 }}>
            {(b.utilizationRatio * 100).toFixed(1)}%
          </span>
        </div>
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
  /**
   * Immutable by default, and asked explicitly.
   *
   * The default was mutable for a while, on the belief that immutable batches
   * could not be topped up. They can — and they can be diluted too, verified
   * against the Bee source and the on-chain contract. With that gone, the
   * remaining difference is what happens when a bucket fills, and immutable
   * fails loudly where mutable fails silently: a mutable batch discards its
   * oldest chunks with no error, so a reference simply stops resolving one day.
   * Refusing the write is the better failure for stored data.
   *
   * Still asked rather than assumed: the choice is fixed at creation, and this
   * wizard once inherited Bee's default without showing it, which is how two
   * batches were bought immutable by accident.
   */
  const [immutable, setImmutable] = useState(true);
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

  /**
   * Buying is a two-click action, and the first click is a real guard rather
   * than a formality: it pins the exact depth/duration/cost being committed to,
   * so what you confirm is what you saw. Any slider move disarms it (see the
   * effect below), because otherwise a nudge between the two clicks would spend
   * against numbers you never read.
   *
   * There is no separate "price it" step — the Cost tiles above are already a
   * live quote from the same `quote()` the server prices with, so a button that
   * fetched it again would only restate what is on screen.
   */
  const [arm, setArm] = useState<{ depth: number; days: number; costBzz: number } | null>(null);

  // Changing the purchase invalidates any pending confirmation.
  useEffect(() => { setArm(null); }, [depth, days, immutable]);

  async function doBuy() {
    if (!selected) return;
    if (!arm) {
      setArm({ depth, days, costBzz: selected.costBzz });
      setResult(null);
      return;
    }
    setBusy(true); setResult(null);
    try {
      const r = await api.buy({ depth, days, label: label || undefined, immutable, confirm: true });
      if (r.dryRun) setResult(`DRY_RUN is on — would have bought depth ${depth} for ${r.wouldBuy.costBzz.toFixed(3)} ${TOKEN}.`);
      else { setResult(`Bought batch ${r.batchId.slice(0, 16)}… for ${r.cost.costBzz.toFixed(3)} ${TOKEN}.`); onDone(); }
    } catch (e: any) { setResult(`Failed: ${e.message}`); }
    setArm(null);
    setBusy(false);
  }

  return (
    <div>
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
          <Tile label="Cost to buy" value={selected.costBzz.toFixed(3)} unit={TOKEN}
            fiat={state.fiat ? `≈ $${(selected.costBzz * state.fiat.usd).toFixed(2)}` : undefined} />
          <Tile label="Upkeep per 30 days" value={selected.costPer30DaysBzz.toFixed(3)} unit={TOKEN}
            fiat={state.fiat ? `≈ $${(selected.costPer30DaysBzz * state.fiat.usd).toFixed(2)}` : undefined} />
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
                title={`depth ${q.depth} · ${q.capacityHuman} · ${q.costBzz.toFixed(3)} ${TOKEN}`}>
                <span className="mono secondary" style={{ fontSize: 12 }}>d{q.depth}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${Math.max(1, (q.costBzz / max) * 100)}%` }} />
                </span>
                <span className="mono" style={{ fontSize: 12, minWidth: 92, textAlign: 'right' }}>
                  {q.costBzz.toFixed(3)} {TOKEN}
                </span>
              </div>
            ))}
          </div>
        </figure>
      )}

      <div style={{ marginTop: 20 }}>
        <div className="tile-label" style={{ marginBottom: 6 }}>
          What happens when a bucket fills — <strong>fixed at creation, cannot be changed later</strong>
        </div>
        <div className="choices">
          <label className={`choice${immutable ? '' : ' is-on'}`}>
            <input type="radio" name="mutability" checked={!immutable}
              onChange={() => setImmutable(false)} />
            <div>
              <div><strong>Mutable</strong> — recycles the oldest chunk</div>
              <div className="tile-sub">
                Never refuses an upload. Right for a site you redeploy, or anything rewritten often:
                superseded chunks make way for the new ones. The cost is that old data can be
                silently dropped, so a reference to a previous version may stop resolving.
              </div>
            </div>
          </label>

          <label className={`choice${immutable ? ' is-on' : ''}`}>
            <input type="radio" name="mutability" checked={immutable}
              onChange={() => setImmutable(true)} />
            <div>
              <div><strong>Immutable</strong> — never overwrites</div>
              <div className="tile-sub">
                Right for write-once data: images, documents, an archive that must keep resolving.
                Nothing you store is ever evicted by a later upload. The cost is that one full
                bucket makes the <em>whole</em> batch refuse further uploads until it is diluted.
              </div>
            </div>
          </label>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <input type="text" placeholder="label (e.g. pinkchainsaw)" value={label}
          onChange={(e) => setLabel(e.target.value)} />
        <button className={arm ? '' : 'primary'} disabled={busy || !selected?.affordable} onClick={doBuy}>
          {busy ? 'Buying…' : arm ? `Confirm — spend ${arm.costBzz.toFixed(3)} ${TOKEN}` : 'Buy batch'}
        </button>
        {arm && <button onClick={() => setArm(null)} disabled={busy}>Cancel</button>}
      </div>
      {arm && !busy && (
        <div className="warn">
          Buying <strong>depth {arm.depth}</strong> ({selected?.capacityHuman}) for <strong>{arm.days} days</strong>
          {' '}at <strong>{arm.costBzz.toFixed(3)} {TOKEN}</strong>
          {state.fiat && ` (≈ $${(arm.costBzz * state.fiat.usd).toFixed(2)})`}
          {label ? <> · label <strong>{label}</strong></> : ' · no label'}.
          {' '}Depth and immutability cannot be changed after purchase.
          <div style={{ marginTop: 8, fontWeight: 600 }}>
            Nothing has been spent yet — press the button again to buy.
          </div>
        </div>
      )}
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
