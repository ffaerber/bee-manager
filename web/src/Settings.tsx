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
import type { SettingSpec, SettingsResponse } from './api';
import { link } from './router';
import { fmtBytes } from './format';

const GROUPS: { id: SettingSpec['group']; title: string; blurb: string }[] = [
  { id: 'automation', title: 'Automation',
    blurb: 'What the service does on its own, without being asked.' },
  { id: 'thresholds', title: 'When to act',
    blurb: 'The points at which a managed batch is topped up or given more room.' },
  { id: 'limits', title: 'Limits',
    blurb: 'What bounds a mistake. These are the last thing between a wrong number and the wallet.' },
  { id: 'alerts', title: 'Alerts',
    blurb: 'Where problems are announced. Without a webhook, nothing reaches you unprompted.' },
];

export function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
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
            <h2 style={{ marginBottom: 4 }}>{g.title}</h2>
            <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{g.blurb}</p>
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
        <h2 style={{ marginBottom: 4 }}>Fixed at startup</h2>
        {/* Not a policy choice: these are read before the settings table can be
            opened, or before the request that would edit them is authenticated. */}
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Read before this page exists — the node URL and database path are needed to start, and the
          admin token authenticates this page. Changing them means editing the deployment.
        </p>
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

  return (
    <div>
      <div className="tile-label">{s.label}</div>
      <input
        type={s.kind === 'string' ? 'text' : 'number'}
        defaultValue={s.value === null ? '' : String(s.value)}
        disabled={busy}
        min={s.min} max={s.max} step={s.kind === 'float' ? '0.05' : undefined}
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
