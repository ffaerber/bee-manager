/**
 * `/settings` — the service's configuration.
 *
 * One value per setting, because that is how many there are. The previous
 * version showed environment, override and effective side by side and left you
 * to work out which was real; the environment now seeds this table once and is
 * ignored afterwards, so there is a single number and it is the one in force.
 *
 * What replaced the environment ceiling on spend caps is a confirmation.
 * Loosening a guard — raising a cap, lowering a floor — asks once and says what
 * the guard is for. Tightening applies immediately: putting friction in the
 * cautious direction only teaches people to click through warnings.
 */

import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { SettingSpec, SettingsResponse, State } from './api';
import { link } from './router';
import { fmtBytes, fmtDays, depthCapacity } from './format';
import { RangeSlider } from './RangeSlider';

const GROUPS: { id: SettingSpec['group']; title: string; blurb: string }[] = [
  { id: 'automation', title: 'Automation',
    blurb: 'What the service does on its own, without being asked.' },
  { id: 'thresholds', title: 'When to act',
    blurb: 'The points at which a managed batch is topped up or given more room.' },
  { id: 'limits', title: 'Limits',
    blurb: 'What bounds a mistake. These are the last thing between a wrong number and the wallet.' },
  { id: 'alerts', title: 'Alerts',
    blurb: 'Where problems are announced. Without a webhook, nothing reaches you unprompted.' },
  { id: 'sharing', title: 'Sharing',
    blurb: 'Used to build the download links you copy from a batch page. Anyone with a link can fetch the file.' },
];

export function Settings({ state, onPolled, onSignOut }: {
  /** Null until the first poll lands, exactly as on the batch page. */
  state: State | null;
  /** Refetch the dashboard's state after a manual poll. */
  onPolled: () => Promise<void> | void;
  onSignOut: () => void;
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [polling, setPolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<api.SettingChange[] | null>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(() => {
    api.getSettings().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(patch: Record<string, unknown>, confirm = false) {
    const key = Object.keys(patch)[0]!;
    setBusy(key); setErr(null); setNote(null);
    try {
      const r = await api.patchSettings(confirm ? { ...patch, confirm: true } : patch);
      if (r.confirmRequired && r.changes) {
        setConfirming(r.changes);
        setPending(patch);
      } else {
        setConfirming(null); setPending(null);
        setNote('Saved.');
        setTimeout(() => setNote(null), 2500);
        load();
      }
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  }

  if (err && !data) return <div className="wrap"><div className="warn err">{err}</div></div>;
  if (!data) return <div className="wrap"><p className="muted">Loading…</p></div>;

  return (
    <div className="wrap">
      <div className="spread" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <a className="backlink" {...link('/')}>← Batches</a>
          <h1>Settings</h1>
        </div>
        {note && <span className="status good">{note}</span>}
      </div>

      {err && <div className="warn err">{err}</div>}

      <Service state={state} polling={polling}
        onPoll={async () => { setPolling(true); await api.poll().catch(() => {}); await onPolled(); setPolling(false); }}
        onSignOut={onSignOut} />

      {confirming && (
        <div className="card" style={{ borderColor: 'var(--critical)' }}>
          <h2 style={{ marginBottom: 8 }}>This weakens a guard</h2>
          {confirming.map((c) => (
            <div key={c.key} className="warn err">
              <strong>{c.label}</strong>: {String(c.from)} → <strong>{String(c.to)}</strong>
              {c.risk && <><br />{c.risk}</>}
            </div>
          ))}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy !== null}
              onClick={() => pending && save(pending, true)}>
              Apply anyway
            </button>
            <button onClick={() => { setConfirming(null); setPending(null); load(); }}>Cancel</button>
          </div>
        </div>
      )}

      {GROUPS.map((g) => {
        const rows = data.settings.filter((s) => s.group === g.id);
        if (!rows.length) return null;
        return (
          <div className="card" key={g.id}>
            {/* Title and blurb ruled off together: they are one thought, and a
                rule between them reads as a section break that is not there. */}
            <div className="card-head">
              <h2>{g.title}</h2>
              <p className="muted" style={{ fontSize: 12 }}>{g.blurb}</p>
            </div>
            <div className="settings-grid">
              {rows.map((s) => (
                <Field key={s.key} s={s} busy={busy === s.key}
                  onSave={(v) => save({ [s.key]: v })} />
              ))}
            </div>
          </div>
        );
      })}

      <div className="card">
        {/* Not a policy choice: these are read before the settings table can be
            opened, or before the request that would edit them is authenticated. */}
        <div className="card-head">
          <h2>Fixed at startup</h2>
          <p className="muted" style={{ fontSize: 12 }}>
            Read before this page exists — the node URL and database path are needed to start, and the
            admin token authenticates this page. Changing them means editing the deployment.
          </p>
        </div>
        <div className="tiles">
          <Fixed label="Bee node" value={data.fixed.beeUrl} />
          <Fixed label="Poll interval" value={`${data.fixed.pollIntervalMs / 1000}s`} />
          <Fixed label="Database" value={data.fixed.dbPath} />
          <Fixed label="Max upload" value={fmtBytes(data.fixed.maxUploadBytes)} />
        </div>
      </div>
    </div>
  );
}

/**
 * What the service is doing right now, as opposed to how it is configured.
 *
 * These four moved off the dashboard header. Three of them belong here on the
 * merits: reachability and armed-ness describe the SERVICE rather than the
 * batches, and both sit next to the settings that determine them — auto top-up
 * being on is a reading of AUTO_TOPUP_ENABLED and DRY_RUN, which are editable
 * a few centimetres below. Poll now and Sign out act on the service too.
 *
 * The dashboard keeps no chip for the healthy case, and interrupts with a
 * banner for the unhealthy one. A status you have to navigate to is fine while
 * everything is fine; it is not fine as the only signal that a node is down.
 */
function Service({ state, polling, onPoll, onSignOut }: {
  state: State | null;
  polling: boolean;
  onPoll: () => void;
  onSignOut: () => void;
}) {
  const armed = state?.config ? state.config.autoTopupEnabled && !state.config.dryRun : null;
  return (
    <div className="card">
      <div className="spread">
        <h2>Service</h2>
        <div className="row">
          {/* `is-live` pulses the dot. Only this chip gets it: reachability is
              the one state here that is a live reading rather than a stored
              fact, and animating the rest would spend attention on things that
              are not changing. */}
          {state && (
            <span className={`status is-live ${state.ok ? 'good' : 'critical'}`}>
              {state.ok ? 'node reachable' : 'node unreachable'}
            </span>
          )}
          {armed !== null && (
            <span className={`status ${armed ? 'good' : 'warning'}`}
              title="Batches below the TTL threshold are topped up automatically, within the configured spend caps.">
              auto top-up {armed ? 'on' : 'off'}
            </span>
          )}
        </div>
      </div>
      <div className="row">
        <button onClick={onPoll} disabled={polling}>{polling ? 'Polling…' : 'Poll now'}</button>
        {/* Not a refresh. tick() evaluates every batch and then acts on the
            result, so with auto top-up armed this button can spend — the same
            code path the 5-minute cycle uses. Saying so is the difference
            between an informed click and a surprise. */}
        <span className="muted" style={{ fontSize: 12 }}>
          {/* Three cases. `armed` is null before the first poll lands, and
              "it will spend nothing" is a safety claim — asserting one we have
              not actually checked is how money gets spent by surprise. */}
          {armed == null
            ? 'Runs a full cycle now rather than waiting. Whether auto top-up is armed is not known yet, so this may buy — within the caps below.'
            : armed
              ? 'Runs a full cycle now rather than waiting. Auto top-up is armed, so this can buy — within the caps below.'
              : 'Runs a full cycle now rather than waiting. Auto top-up is off, so it will report what it would have done and spend nothing.'}
        </span>
      </div>
      <div className="row" style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--grid)' }}>
        <button onClick={onSignOut} title="Forget the token stored in this browser">Sign out</button>
        <span className="muted" style={{ fontSize: 12 }}>
          Forgets the admin token held in this browser. The service keeps running.
        </span>
      </div>
    </div>
  );
}

function Field({ s, busy, onSave }: {
  s: SettingSpec; busy: boolean; onSave: (v: string | number | boolean) => void;
}) {
  if (s.kind === 'bool') {
    const on = Boolean(s.value);
    return (
      <div>
        <div className="tile-label">{s.label}</div>
        <button disabled={busy} onClick={() => onSave(!on)}
          className={on ? 'primary' : ''}
          style={{ padding: '5px 14px', fontSize: 13, marginTop: 2 }}>
          {on ? 'on' : 'off'}
        </button>
        {s.hint && <div className="tile-sub">{s.hint}</div>}
      </div>
    );
  }

  if (s.kind === 'percent' || s.kind === 'depth' || s.kind === 'days') {
    // Bounded values get a slider — the range is the context a number field
    // cannot give. Depth is labelled with the capacity it buys, because "22"
    // means nothing and "17.2 GB" means something.
    return (
      <div>
        <div className="tile-label">{s.label}</div>
        <RangeSlider
          value={Number(s.value ?? 0)}
          min={s.min ?? 0} max={s.max ?? 100}
          step={s.kind === 'percent' ? 5 : 1}
          stops={s.stops}
          disabled={busy}
          format={(v) =>
            s.kind === 'percent' ? `${v}%`
            : s.kind === 'days' ? fmtDays(v)
            : `d${v} · ${depthCapacity(v)}`}
          onCommit={onSave}
        />
        {s.hint && <div className="tile-sub">{s.hint}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="tile-label">{s.label}</div>
      {/* xBZZ caps are routinely fractional, so they step like a float. A
          whole-token step made the spinner useless and marked 0.25 invalid,
          even though onBlur reads the raw value and saved it regardless. */}
      <input
        type={s.kind === 'string' ? 'text' : 'number'}
        defaultValue={s.value === null ? '' : String(s.value)}
        disabled={busy}
        min={s.min} max={s.max}
        step={s.kind === 'float' || s.kind === 'bzz' ? '0.05' : undefined}
        style={{ width: '100%', padding: '5px 8px', fontSize: 14, marginTop: 2 }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const next = s.kind === 'string' ? raw : Number(raw);
          if (s.kind !== 'string' && !Number.isFinite(next as number)) return;
          if (String(next) !== String(s.value ?? '')) onSave(next);
        }}
      />
      {s.hint && <div className="tile-sub">{s.hint}</div>}
    </div>
  );
}

function Fixed({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tile-label">{label}</div>
      <div className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}
