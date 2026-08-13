/**
 * `/settings` — runtime configuration.
 *
 * Everything here is layered over the environment, and the environment stays
 * authoritative in one specific way: for the spend caps it is a CEILING, not
 * merely a default. The page can lower a cap freely and raise it only as far as
 * the deployment allows, so the guardrail that bounds an automated refiller
 * lives in a reviewed commit rather than behind a button.
 *
 * The protective floors invert the same rule — they may be raised, never
 * lowered — and each field says which way it is bounded rather than leaving it
 * to be discovered by being clamped.
 */

import { useCallback, useEffect, useState } from 'react';
import * as api from './api';
import type { SettingSpec, SettingsResponse } from './api';
import { link } from './router';
import { fmtBytes } from './format';

export function Settings() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getSettings().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(spec: SettingSpec, value: string | number | boolean | null) {
    setBusy(spec.key); setErr(null); setNote(null);
    try {
      const r = await api.patchSettings({ [spec.key]: value });
      if (r.clamped.includes(spec.key)) {
        setNote(`${spec.label} was clamped to ${r.applied[spec.key]} — the environment bounds it.`);
      } else {
        setNote(value === null ? `${spec.label} reset to the environment value.` : `${spec.label} saved.`);
      }
      load();
      setTimeout(() => setNote(null), 4000);
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  }

  if (err && !data) return <div className="wrap"><div className="warn err">{err}</div></div>;
  if (!data) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const bound = (b: SettingSpec['bound']) =>
    b === 'atMost' ? 'may only be lowered' : b === 'atLeast' ? 'may only be raised' : null;

  return (
    <div className="wrap">
      <div className="spread" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <a className="backlink" {...link('/')}>← Batches</a>
          <h1>Settings</h1>
        </div>
      </div>

      <div className="card">
        <p className="secondary" style={{ fontSize: 13, marginBottom: 4 }}>
          Changes apply on the next poll — no restart. Clearing a field returns it to the value
          from the environment.
        </p>
        <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
          The spend caps can be lowered here but not raised past what the deployment allows, and the
          wallet floors can be raised but not lowered. Those bounds live in the homelab compose so
          that widening them is a reviewed change rather than a click.
        </p>

        {note && <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent' }}>{note}</div>}
        {err && <div className="warn err">{err}</div>}

        <table>
          <thead>
            <tr>
              <th>Setting</th><th>Environment</th><th>Value in force</th><th></th>
            </tr>
          </thead>
          <tbody>
            {data.settings.map((s) => (
              <Row key={s.key} s={s} busy={busy === s.key} onSave={(v) => save(s, v)} boundText={bound(s.bound)} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 10 }}>Fixed at startup</h2>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Structural, so changing them needs a redeploy. Listed so their absence above is not a
          mystery.
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

function Row({ s, busy, onSave, boundText }: {
  s: SettingSpec; busy: boolean;
  onSave: (v: string | number | boolean | null) => void;
  boundText: string | null;
}) {
  const overridden = s.override !== null;
  return (
    <tr>
      <td>
        <div>{s.label}</div>
        <div className="tile-sub">
          {s.hint}{boundText ? `${s.hint ? ' · ' : ''}${boundText}` : ''}
        </div>
      </td>
      <td className="mono secondary" style={{ fontSize: 12 }}>{fmtVal(s.envValue)}</td>
      <td>
        {s.kind === 'bool' ? (
          <button disabled={busy} onClick={() => onSave(!s.effective)}
            style={{ padding: '4px 10px', fontSize: 12 }}>
            {s.effective ? 'on' : 'off'}
          </button>
        ) : (
          <input
            type={s.kind === 'string' ? 'text' : 'number'}
            defaultValue={s.override ?? ''}
            placeholder={String(s.envValue ?? '')}
            disabled={busy}
            min={s.min} max={s.max} step={s.kind === 'float' ? '0.05' : undefined}
            style={{ width: s.kind === 'string' ? 260 : 110, padding: '4px 6px', fontSize: 13 }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const next = raw === '' ? null : (s.kind === 'string' ? raw : Number(raw));
              if (String(next ?? '') !== String(s.override ?? '')) onSave(next);
            }}
          />
        )}
        <div className="tile-sub">
          {overridden ? `overridden · in force ${fmtVal(s.effective)}` : 'from environment'}
        </div>
      </td>
      <td>
        {overridden && (
          <button disabled={busy} onClick={() => onSave(null)} style={{ padding: '4px 10px', fontSize: 12 }}>
            reset
          </button>
        )}
      </td>
    </tr>
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

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}
