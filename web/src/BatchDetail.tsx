/**
 * One batch, at /batch/<id>.
 *
 * The map is the page rather than something inside it: it fills the viewport
 * and the readings sit on top. Everything that used to be buried behind a map
 * button and then a second toggle — the bucket figures, the pressure warning,
 * the upload — is on this page directly.
 *
 * It owns the bucket read, and hands the decoded fills to the canvas and the
 * numbers to the panel, so opening a batch is one fetch rather than two.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import type { Batch, BucketGrid, DilutePreview, State, TopupPreview, Upload } from './api';
import { decodeGrid } from './mapColors';
import { MapCanvas, type Hover } from './MapCanvas';
import { link } from './router';
import { expiryDate, fmtBytes, fmtDays, ttlSeverity } from './format';

/** Buckets are re-read on this cadence so a screen left open stays current. */
const REFRESH_MS = 60_000;

export function BatchDetail({ batchId, state, onChange }: {
  batchId: string; state: State | null;
  /** Refresh the shared state. Awaited, so edits re-sync only once it has landed. */
  onChange: () => void | Promise<void>;
}) {
  const [data, setData] = useState<BucketGrid | null>(null);
  const [fills, setFills] = useState<Uint8Array | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [panelHidden, setPanelHidden] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<
    { name: string; bytes: number; reference: string; newChunks: number } | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const filePick = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const d = await api.getBuckets(batchId);
    setData(d);
    setFills(decodeGrid(d.grid));
    return d;
  }, [batchId]);

  const loadUploads = useCallback(() => {
    api.getUploads(batchId).then(setUploads).catch(() => { /* the map still works without the list */ });
  }, [batchId]);

  useEffect(() => { loadUploads(); }, [loadUploads]);

  useEffect(() => {
    setData(null); setFills(null); setErr(null); setUploaded(null);
    load().catch((e) => setErr(e.message));
    const iv = setInterval(() => { load().catch(() => { /* keep the last frame */ }); }, REFRESH_MS);
    return () => clearInterval(iv);
  }, [load]);

  // Escape brings the panel back — on a device with no hover, hiding it would
  // otherwise be one-way.
  useEffect(() => {
    if (!panelHidden) { setHover(null); return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanelHidden(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelHidden]);

  /**
   * Upload, then re-read so the new cells appear at once.
   *
   * The chunk delta is measured rather than derived from the file size: Swarm
   * adds intermediate Merkle-tree and manifest chunks above the data chunks, so
   * bytes/4096 understates what a file actually costs in slots — measured at
   * 100 chunks for a 326 KB image where the naive figure is 80.
   */
  async function onFile(file: File) {
    // Refuse locally first. Without this a large file is transferred in full
    // before the server can answer 413 — minutes of upload to be told no.
    const reason = data ? rejectReason(file, data) : null;
    if (reason) { setErr(reason); if (filePick.current) filePick.current.value = ''; return; }

    setUploading(true); setErr(null); setUploaded(null);
    const before = data?.totalChunks ?? 0;
    try {
      const r = await api.uploadToBatch(batchId, file);
      const after = await load();
      loadUploads();
      setUploaded({
        name: file.name, bytes: r.bytes, reference: r.reference,
        newChunks: Math.max(0, after.totalChunks - before),
      });
    } catch (e: any) {
      setErr(e.message);
    }
    setUploading(false);
    if (filePick.current) filePick.current.value = '';
  }

  const batch = state?.batches.find((b) => b.batchID === batchId);
  const title = data?.label || batch?.label || `${batchId.slice(0, 12)}…`;

  return (
    <>
      {/* Two renderings, chosen by whether the panel is up.
          With the panel visible the map is wallpaper behind something you are
          reading: a star field, black and monochrome, softened, and inert —
          hovering a background you cannot really see reports numbers nobody
          asked for. Press Show map and it becomes the instrument: one crisp
          cell per bucket, the full colour ramp, and per-bucket readout. */}
      <MapCanvas
        fills={fills}
        bucketUpperBound={data?.bucketUpperBound ?? 1}
        mode={panelHidden ? 'pixels' : 'stars'}
        onHover={panelHidden ? setHover : undefined}
      />
      {panelHidden && hover && (
        <div className="tooltip is-fixed" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          bucket {hover.id.toLocaleString()}<br />
          {hover.count} / {data?.bucketUpperBound ?? '?'} stamps
        </div>
      )}

      <div className={`wrap${panelHidden ? ' ui-hidden' : ''}`}>
        <div className="spread" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10 }}>
            <a className="backlink" {...link('/')}>← Batches</a>
            <h1>{title}</h1>
          </div>
          <button onClick={() => setPanelHidden(true)}>Show map</button>
        </div>

        {err && <div className="warn err">{err}</div>}

        {batch && (
          <Vitals b={batch} data={data} state={state!}
            onDone={async () => { await onChange(); await load(); }} />
        )}

        {batch && <BatchFacts b={batch} state={state!} onChange={onChange} />}
        {batch?.managed && <Policy b={batch} state={state!} onChange={onChange} />}

        {!data && !err && <div className="card"><p className="muted">Reading 65,536 buckets…</p></div>}

        {data && (
          <div className="card">
            <p className="secondary" style={{ fontSize: 13, marginBottom: 14 }}>
              The background is this batch's {(1 << data.bucketDepth).toLocaleString()} buckets, one cell each,
              shaded by how full it is. A chunk's address decides which bucket it must use, so buckets fill
              unevenly — the batch starts refusing writes when the <em>first</em> bucket fills, not when the
              average does. Hover the background for any bucket's count.
            </p>

            <div className="tiles">
              <Stat label="Stored" value={fmtBytes(data.storedBytes)}
                sub={`${data.totalChunks.toLocaleString()} chunks`} />
              <Stat label="Capacity paid for" value={fmtBytes(data.capacityBytes)}
                sub={`depth ${data.depth} · rented whether used or not`} />
              <Stat label={batch?.immutableFlag ? 'Capacity usable' : 'Before data loss'}
                value={fmtBytes(data.firstFullChunks * 4096)}
                sub={`~${data.firstFullChunks.toLocaleString()} chunks · ${Math.round(data.capacityBytes / (data.firstFullChunks * 4096))}x less than paid for`} />
              <Stat label="Buckets used" value={data.usedBuckets.toLocaleString()}
                sub={`of ${(1 << data.bucketDepth).toLocaleString()}`} />
              <Stat label="Fullest bucket" value={`${data.maxCollisions} / ${data.bucketUpperBound}`}
                sub={data.fullBuckets > 0 ? `${data.fullBuckets.toLocaleString()} at capacity` : 'none at capacity'} />
            </div>

            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Chunk addresses are effectively random, so buckets fill unevenly and the first one
              reaches capacity long before the batch does — a birthday problem, not a rounding
              error. {batch?.immutableFlag
                ? 'On an immutable batch that first full bucket is the end: the whole batch reports 100% utilised and refuses every further upload until it is diluted.'
                : 'On a mutable batch nothing stops there — that bucket begins recycling its oldest chunk on each new collision, so the batch keeps accepting and quietly loses data instead. It cannot fill up; it can only become lossier.'}
            </p>

            <div className={`warn ${data.pressure.level === 'critical' ? 'err' : ''}`}
              style={data.pressure.level === 'good'
                ? { borderLeftColor: 'var(--good)', background: 'transparent' } : undefined}>
              {data.pressure.message}
            </div>

            {data.totalChunks > 0 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                Occupying {((data.usedBuckets / (1 << data.bucketDepth)) * 100).toFixed(2)}% of buckets
                and {((data.storedBytes / data.capacityBytes) * 100).toFixed(4)}% of paid capacity.
                {data.storedBytes / data.capacityBytes < 0.01 &&
                  ' Rent is charged on the whole batch regardless, so most of what this costs is buying empty space.'}
              </p>
            )}
          </div>
        )}

        {/* Last on the page, and one card rather than two sections inside the
            bucket panel: putting a file somewhere and seeing what is already
            there are the same task, and neither is why you open this page. */}
        {data && (
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>Files</h2>

            <div className="row">
              <input ref={filePick} type="file" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
              <button className="primary" disabled={uploading} onClick={() => filePick.current?.click()}>
                {uploading ? 'Uploading…' : 'Upload a file'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Stamps it with this batch — watch the background fill. Up to{' '}
                {fmtBytes(data.maxUploadBytes)}, and {fmtBytes(data.freeChunks * 4096)} of batch
                space is unused.
              </span>
            </div>

            {/* Both are irreversible and neither is obvious from a file
                picker, so they are stated where the choice is made. */}
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Uploaded data is public — anyone with the reference can fetch it — and the stamps it
              consumes cannot be reclaimed
              {data.immutable
                ? ', and this batch is immutable, so those bucket slots are gone for its lifetime.'
                : '.'}
            </p>

            {uploaded && (
              <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent' }}>
                Uploaded <strong>{uploaded.name}</strong> ({fmtBytes(uploaded.bytes)}) —{' '}
                <strong>{uploaded.newChunks.toLocaleString()}</strong> new chunk
                {uploaded.newChunks === 1 ? '' : 's'}.
                <br />
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{uploaded.reference}</code>
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <CopyLink url={shareUrl(data.publicGatewayUrl, uploaded.reference)}
                    label="Copy download link" />
                  {shareUrl(data.publicGatewayUrl, uploaded.reference) && (
                    <a className="backlink" target="_blank" rel="noopener noreferrer"
                      href={shareUrl(data.publicGatewayUrl, uploaded.reference)!}>open ↗</a>
                  )}
                  <span className="muted" style={{ fontSize: 12 }}>
                    Anyone with this link can fetch the file — it needs no key.
                  </span>
                </div>
              </div>
            )}

            {uploads.length > 0 ? (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr><th>File</th><th className="num">Size</th><th>When</th><th>Reference</th><th></th></tr>
                    </thead>
                    <tbody>
                      {uploads.map((u) => <UploadRow key={u.id} u={u} gateway={data.publicGatewayUrl} />)}
                    </tbody>
                  </table>
                </div>
                {/* Says plainly what the list is and is not: a local index of
                    what this dashboard uploaded, not a listing of the batch.
                    Swarm has no way to enumerate a batch's contents — only the
                    references you kept can be fetched back. */}
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Recorded by this monitor when the upload happened. Swarm cannot list a batch's
                  contents, so anything uploaded by other means is not here — and a reference that
                  is lost is lost, even though the data is still stored and still paid for.
                </p>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 12, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                Nothing uploaded through this dashboard yet. Swarm cannot list a batch's contents, so
                only what is recorded here can be fetched back — anything uploaded by other means
                will not appear.
              </p>
            )}
          </div>
        )}
      </div>

      {panelHidden && (
        <div className="map-bar">
          <span className="label">{title}</span>
          {/* The legend reads the thing on screen. It sat in the buckets card,
              where the map is behind opaque panels and the colours it names are
              not visible — a key to a picture you cannot see. Identity is never
              colour alone, so every swatch stays labelled. */}
          <div className="map-legend">
            <Key color="var(--grid)" label="empty" />
            <Key color="var(--map-low)" label="lightly used" />
            <Key color="var(--map-mid)" label="half full" />
            <Key color="var(--map-high)" label="mostly full" />
            <Key color="var(--warning)" label="nearly full" />
            <Key color="var(--critical)" label="at capacity" />
          </div>
          <button onClick={() => setPanelHidden(false)}>Show panel</button>
        </div>
      )}
    </>
  );
}

/**
 * What this batch IS, and the two things about it you can change.
 *
 * Deliberately holds no measurements. Remaining life and utilisation both used
 * to appear here as well as in the vitals card above — the same numbers twice,
 * once as a meter and once as text, which invites the reader to check whether
 * they agree. The meters won: they carry severity colour and the expiry date.
 *
 * Editable here for the same reason it is editable in the overview row: this is
 * the page you are on when you decide a batch needs renaming or retiring.
 */
function BatchFacts({ b, state, onChange }: {
  b: Batch; state: State; onChange: () => void | Promise<void>;
}) {
  const [label, setLabel] = useState(b.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Follow the periodic refresh, but never while a save is in flight: clearing
  // `busy` before the new state has landed would re-sync from the stale value
  // and make an accepted rename look rejected.
  useEffect(() => { if (!busy) setLabel(b.label); }, [b.label, busy]);

  const threshold = state.config.topupWhenTtlBelowDays;
  const sev = ttlSeverity(b.ttlDays, threshold);

  async function save(patch: { label?: string; managed?: boolean }) {
    setBusy(true); setErr(null);
    try {
      await api.patchBatch(b.batchID, patch);
      // Awaited: `busy` must stay true until the refreshed state is in, or the
      // re-sync effect fires against the old label and reverts the field.
      await onChange();
    } catch (e: any) {
      setErr(e.message);
      setLabel(b.label);
    }
    setBusy(false);
  }

  return (
    <div className="card">
      <div className="tiles">
        <div>
          <div className="tile-label">Label</div>
          <input
            type="text" value={label} disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => { if (label !== b.label && label.trim()) save({ label: label.trim() }); else setLabel(b.label); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setLabel(b.label);
            }}
            style={{ width: '100%', padding: '4px 6px', fontSize: 14 }}
            title="Renames the batch on the Bee node, so the name survives this database"
          />
        </div>

        <div>
          <div className="tile-label">Depth</div>
          <div className="tile-value" style={{ fontSize: 18 }}>{b.depth}</div>
          {/* Not the nominal capacity — the buckets card below already gives
              that, and each card citing the other says nothing twice. The
              fact worth stating here is that this number is one-way. */}
          <div className="tile-sub">only ever increases</div>
        </div>

        <div>
          <div className="tile-label">Managed</div>
          <button onClick={() => save({ managed: !b.managed })} disabled={busy}
            style={{ padding: '4px 10px', fontSize: 12, marginTop: 2 }}
            title={b.managed
              ? 'Topped up automatically within the caps. Click to leave it alone — it will expire on its own.'
              : 'Never topped up, and its expiry raises no alert. Click to manage it again.'}>
            {b.managed ? 'managed' : 'unmanaged'}
          </button>
          <div className="tile-sub">
            {b.managed ? 'auto top-up applies' : 'will lapse silently'}
          </div>
        </div>

        <div>
          <div className="tile-label">Flags</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>
            {b.immutableFlag ? 'immutable' : 'mutable'}{b.usable ? '' : ' · unusable'}
          </div>
          <div className="tile-sub">
            {b.immutableFlag
              ? 'a full bucket rejects writes for good'
              : 'a full bucket recycles its oldest chunk'}
          </div>
        </div>

      </div>

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <span className="tile-label">Batch ID</span>
        <button className="reflink" title={b.batchID}
          onClick={() => {
            navigator.clipboard?.writeText(b.batchID).then(() => {
              setCopied(true); setTimeout(() => setCopied(false), 1500);
            }).catch(() => { /* clipboard blocked; the title still shows it */ });
          }}>
          {copied ? 'copied' : b.batchID}
        </button>
      </div>

      {err && <div className="warn err" style={{ fontSize: 12 }}>{err}</div>}
    </div>
  );
}

/**
 * Per-batch policy.
 *
 * Only shown for managed batches, because none of it applies otherwise — an
 * unmanaged batch is never topped up or diluted at all.
 *
 * Empty means "follow the global", and the placeholder shows what that
 * currently resolves to. Storing a copy of the global instead would silently
 * freeze the batch at whatever the default was the day it was first seen, so
 * changing the service default would stop reaching it.
 */
function Policy({ b, state, onChange }: {
  b: Batch; state: State; onChange: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const eff = b.effective;
  const below = Math.round(eff.topupWhenTtlBelowSec / 86_400);
  const target = Math.round(eff.topupTargetTtlSec / 86_400);
  /** What one full top-up costs at the current chain price, or null if unknown. */
  const topupCostBzz = state.chain
    ? (Number(state.chain.price)
        * Math.ceil(Math.max(0, target - below) * 86_400 * 1000 / state.msPerBlock)
        * Math.pow(2, b.depth)) / 1e16
    : null;
  const fields: {
    key: keyof typeof b.policy; label: string; unit: string; hint?: string;
    /** Stored as a fraction, entered and displayed as 0-100. */
    percent?: boolean;
    globalValue: number; step?: string; min?: string; max?: string;
  }[] = [
    { key: 'topupBelowDays', label: 'Top up when life falls below', unit: 'days',
      globalValue: eff.topupWhenTtlBelowSec / 86_400, min: '1' },
    // "to", not "by". The distinction is the whole model and was invisible.
    { key: 'topupTargetDays', label: 'Top up to', unit: 'days total',
      hint: 'a ceiling, not an amount added',
      globalValue: eff.topupTargetTtlSec / 86_400, min: '2' },
    // Stored as a fraction, shown as a percentage. "0.9 of 1.0" is the same
    // number nobody reads as ninety percent without converting it first.
    { key: 'diluteAbove', label: 'Dilute when fullest bucket exceeds', unit: '%',
      percent: true,
      globalValue: Math.round(eff.diluteWhenUtilizationAbove * 100), step: '1', min: '10', max: '100' },
    { key: 'maxDiluteDepth', label: 'Never auto-dilute past', unit: 'depth',
      globalValue: eff.maxAutoDiluteDepth, min: '17', max: '41' },
  ];

  async function save(key: keyof typeof b.policy, raw: string, percent = false) {
    let value = raw.trim() === '' ? null : Number(raw);
    if (value !== null && !Number.isFinite(value)) return;
    // Percent fields are entered as 0-100 and stored as a fraction.
    if (value !== null && percent) value = value / 100;
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api.patchBatch(b.batchID, { [key]: value } as any);
      await onChange();
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <h2>Policy for this batch</h2>
        {saved && <span className="status good">saved</span>}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Leave a field empty to follow the service default, shown under each field. A value here
        overrides it for this batch only.
      </p>

      {/* The target model is not obvious from a number in a box: "60" could be
          days added or days aimed for. Stating it with this batch's own figures
          answers that without a paragraph of theory. */}
      <p className="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
        As set: when this batch drops below <strong>{below} days</strong> of life it is topped up to{' '}
        <strong>{target} days total</strong> — buying about <strong>{Math.max(0, target - below)} days</strong>
        {topupCostBzz !== null && <> for roughly <strong>{topupCostBzz.toFixed(3)} xBZZ</strong> at today's price</>}.
        It is a ceiling, not an amount added, so life is kept between {below} and {target} days
        rather than growing each time.
      </p>

      <div className="tiles">
        {fields.map((f) => (
          <div key={f.key}>
            <div className="tile-label">{f.label}</div>
            {f.percent ? (
              /* A slider, because the value is bounded and the range is the
                 useful context — the same reason the wizard uses one for depth
                 and duration. A slider cannot express "empty means inherit",
                 so it shows what is in force and Reset clears the override. */
              <PercentSlider
                value={f.percent && b.policy[f.key] !== null && b.policy[f.key] !== undefined
                  ? Math.round((b.policy[f.key] as number) * 100)
                  : f.globalValue}
                min={Number(f.min ?? 10)} max={Number(f.max ?? 100)}
                disabled={busy}
                onCommit={(v) => save(f.key, String(v), true)}
              />
            ) : (
              <input
                type="number" disabled={busy}
                defaultValue={b.policy[f.key] ?? ''}
                placeholder={String(f.globalValue)}
                step={f.step} min={f.min} max={f.max}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  const next = raw === '' ? null : Number(raw);
                  if (next !== b.policy[f.key]) save(f.key, raw);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: '100%', padding: '4px 6px', fontSize: 14 }}
              />
            )}
            {/* The unit used to appear only when the field was overridden, so
                the normal case read "default 2" with no indication of what 2
                counted. Unit first, always. */}
            <div className="tile-sub">
              {f.unit}
              {b.policy[f.key] === null ? ` · default ${f.globalValue}` : ' · overridden'}
              {f.hint ? ` · ${f.hint}` : ''}
              {b.policy[f.key] !== null && (
                <> · <button className="linkish" disabled={busy}
                  onClick={() => save(f.key, '')}>reset</button></>
              )}
            </div>
          </div>
        ))}
      </div>

      {err && <div className="warn err" style={{ fontSize: 12 }}>{err}</div>}
    </div>
  );
}

/**
 * The two numbers that decide whether a batch is healthy, and the two actions
 * that move them.
 *
 * Life and room are the whole story: a batch dies when either runs out, and
 * every other figure on the page is detail underneath. They were below the
 * bucket statistics, which put the diagnosis under the evidence.
 *
 * Each action expands in place rather than linking elsewhere, so the meter it
 * changes stays on screen while you decide.
 *
 * Both are disabled on an unmanaged batch. Unmanaged means "I am letting this
 * lapse", so spending on it is nearly always a mistake — the API refuses too,
 * since a greyed-out button is a hint, not a guard.
 */
function Vitals({ b, data, state, onDone }: {
  b: Batch; data: BucketGrid | null; state: State; onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState<'life' | 'room' | null>(null);

  const threshold = b.effective.topupWhenTtlBelowSec / 86_400;
  const sev = ttlSeverity(b.ttlDays, threshold);
  const ttlPct = Math.max(2, Math.min(100, (b.ttlDays / 90) * 100));

  // The meter tracks the FULLEST bucket, not the average, because that is what
  // actually stops a write. Bytes stored are shown underneath as context.
  const fullPct = Math.max(1, Math.min(100, b.utilizationRatio * 100));
  const roomSev = b.utilizationRatio >= 1 ? 'critical'
    : b.utilizationRatio >= b.effective.diluteWhenUtilizationAbove ? 'warning' : 'good';

  return (
    <div className="card">
      <div className="vitals">
        <div>
          <div className="tile-label">Remaining life</div>
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap', margin: '4px 0 4px' }}>
            <span className={`meter ${sev}`} style={{ flex: 1, height: 12 }}>
              <i style={{ width: `${ttlPct}%` }} />
            </span>
            <span style={{ fontSize: 22, fontWeight: 600, minWidth: 74, textAlign: 'right' }}>
              {fmtDays(b.ttlDays)}
            </span>
          </div>
          <div className="tile-sub">
            {b.ttlDays > 0 ? `until ${expiryDate(b.ttlDays)}` : 'expired'}
            {sev === 'warning' && ` · below the ${threshold}d threshold`}
          </div>
        </div>

        <div>
          {/* The same percentage means opposite things. On an immutable batch
              it is a countdown to refusing every upload; on a mutable one it is
              how close the first bucket is to recycling, after which the batch
              keeps working and quietly loses data. Naming both "Capacity used"
              hid the difference that matters most. */}
          <div className="tile-label">
            {b.immutableFlag ? 'Capacity used' : 'Nearest bucket to recycling'}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap', margin: '4px 0 4px' }}>
            <span className={`meter ${roomSev}`} style={{ flex: 1, height: 12 }}>
              <i style={{ width: `${fullPct}%` }} />
            </span>
            <span style={{ fontSize: 22, fontWeight: 600, minWidth: 74, textAlign: 'right' }}>
              {(b.utilizationRatio * 100).toFixed(1)}%
            </span>
          </div>
          <div className="tile-sub">
            {data
              ? `fullest bucket ${data.maxCollisions} of ${data.bucketUpperBound} · ${fmtBytes(data.storedBytes)} stored`
              : 'fullest bucket — reading…'}
          </div>
          {data && (
            <div className="tile-sub" style={{ marginTop: 4 }}>
              {b.immutableFlag
                ? <>Refuses all uploads at ~{data.firstFullChunks.toLocaleString()} chunks
                    ({fmtBytes(data.firstFullChunks * 4096)})</>
                : <>Starts discarding oldest at ~{data.firstFullChunks.toLocaleString()} chunks
                    ({fmtBytes(data.firstFullChunks * 4096)}) — then keeps accepting</>}
            </div>
          )}
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className={open === 'life' ? '' : 'primary'}
          onClick={() => setOpen(open === 'life' ? null : 'life')}
          title="Buy more time at the current size">
          Extend life
        </button>
        <button onClick={() => setOpen(open === 'room' ? null : 'room')}
          title="More room, at the cost of half the remaining life">
          Add capacity
        </button>
        {!b.managed && (
          <span className="muted" style={{ fontSize: 12 }}>
            Unmanaged — nothing renews this automatically. Both actions still work by hand.
          </span>
        )}
      </div>

      {open === 'life' && <Topup b={b} onDone={async () => { await onDone(); setOpen(null); }} />}
      {open === 'room' && <Dilute b={b} onDone={async () => { await onDone(); setOpen(null); }} />}
    </div>
  );
}

/**
 * Manual top-up: more time, at the current size.
 *
 * The counterpart to dilution — this one buys life and leaves capacity alone.
 * Defaults to the batch's own target so the button does the same thing the
 * automatic path would, just now instead of at the threshold.
 *
 * Subject to the same caps as the automatic path. Being deliberate does not
 * make a spend safe to leave unbounded, so the preview reports a block before
 * the confirm rather than after it.
 */
function Topup({ b, onDone }: { b: Batch; onDone: () => Promise<void> }) {
  const targetDefault = Math.round(b.effective.topupTargetTtlSec / 86_400);
  /**
   * Two ways to say the same thing, because both are natural depending on why
   * you are here. "Extend to" matches the automatic path and the policy field;
   * "add" is what you actually mean when buying a few more days by hand, and
   * without it you had to work out target = current + n yourself.
   *
   * The request is always an absolute target, so a preview stays valid even
   * though the batch keeps draining between preview and confirm.
   */
  const [mode, setMode] = useState<'to' | 'add'>('add');
  const [amount, setAmount] = useState(30);
  const days = mode === 'add' ? Math.round(b.ttlDays + amount) : amount;
  const [preview, setPreview] = useState<TopupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A different duration invalidates a pending confirmation.
  useEffect(() => { setPreview(null); setDone(null); }, [days]);

  // Switching mode carries the number across as the equivalent value, so the
  // figure on screen never silently changes meaning.
  function switchMode(next: 'to' | 'add') {
    if (next === mode) return;
    setAmount(next === 'add'
      ? Math.max(1, Math.round(amount - b.ttlDays))
      : Math.round(b.ttlDays + amount));
    setMode(next);
  }

  async function go(confirm: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api.topup(b.batchID, { days, confirm });
      if (r.confirmRequired && r.preview) setPreview(r.preview);
      else if (r.dryRun && r.wouldTopup) {
        setDone(`DRY_RUN is on — would have extended to ${r.wouldTopup.toDays}d.`);
        setPreview(null);
      } else if (r.toppedUp) {
        setDone(`Extended to about ${r.toppedUp.toDays}d for ${r.toppedUp.costBzz.toFixed(3)} xBZZ.`);
        setPreview(null);
        await onDone();
      }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <h2 style={{ marginBottom: 8 }}>Top up</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Buys more remaining life at the current depth. Capacity is unchanged — cost scales with
        2<sup>depth</sup>, so a deeper batch costs proportionally more per day. Any amount works;
        there is no minimum beyond extending past what the batch already has.
      </p>
      <div className="row">
        <label className="field" style={{ marginBottom: 0 }}>
          <select value={mode} onChange={(e) => switchMode(e.target.value as 'to' | 'add')} disabled={busy}>
            <option value="add">Add</option>
            <option value="to">Extend to</option>
          </select>{' '}
          <input type="number" min={1} max={3650} value={amount} disabled={busy}
            onChange={(e) => setAmount(Number(e.target.value))}
            style={{ width: 90, padding: '4px 6px' }} /> days
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          {mode === 'add'
            ? `${fmtDays(b.ttlDays)} now → ${days} d total`
            : `${fmtDays(b.ttlDays)} now → adds ${Math.max(0, days - b.ttlDays).toFixed(1)} d`}
        </span>
        <button className={preview?.allowed ? 'danger' : 'primary'} disabled={busy || days <= b.ttlDays}
          onClick={() => go(Boolean(preview && preview.allowed))}>
          {busy ? 'Working…'
            : preview ? (preview.allowed ? `Yes — spend ${preview.costBzz.toFixed(3)} xBZZ` : 'Blocked')
            : `Top up to ${days} days…`}
        </button>
        {preview && <button onClick={() => setPreview(null)} disabled={busy}>Cancel</button>}
      </div>

      {preview && (
        <div className={`warn ${preview.allowed ? '' : 'err'}`}>
          {fmtDays(preview.fromDays)} → <strong>{preview.toDays} d</strong> for{' '}
          <strong>{preview.costBzz.toFixed(3)} xBZZ</strong>.
          {preview.allowed
            ? ' Within caps. Depth and capacity are unchanged.'
            : ` Blocked: ${preview.reason}`}
          {preview.unmanaged && preview.allowed && (
            <> <strong>This batch is unmanaged</strong>, so nothing will renew it after this —
              it will lapse once the time you are buying runs out.</>
          )}
          {preview.allowed && (
            <div style={{ marginTop: 8, fontWeight: 600 }}>
              Nothing has been spent yet — press the button again to confirm.
            </div>
          )}
        </div>
      )}
      {done && <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent' }}>{done}</div>}
      {err && <div className="warn err">{err}</div>}
    </div>
  );
}

/**
 * A bounded percentage, as a slider.
 *
 * Commits on release rather than on every input event: dragging fires
 * continuously, and each one is a PATCH and a ledger entry.
 */
function PercentSlider({ value, min, max, disabled, onCommit }: {
  value: number; min: number; max: number; disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [shown, setShown] = useState(value);
  // Follow the server once a save lands, but never while dragging.
  const [dragging, setDragging] = useState(false);
  useEffect(() => { if (!dragging) setShown(value); }, [value, dragging]);

  return (
    <div>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'center' }}>
        <input
          type="range" min={min} max={max} step={5} value={shown} disabled={disabled}
          onChange={(e) => { setDragging(true); setShown(Number(e.target.value)); }}
          onMouseUp={() => { setDragging(false); if (shown !== value) onCommit(shown); }}
          onTouchEnd={() => { setDragging(false); if (shown !== value) onCommit(shown); }}
          onKeyUp={() => { setDragging(false); if (shown !== value) onCommit(shown); }}
          style={{ flex: 1 }}
        />
        <span className="mono" style={{ minWidth: 44, textAlign: 'right', fontWeight: 600 }}>
          {shown}%
        </span>
      </div>
      <div className="row spread muted" style={{ fontSize: 11 }}>
        <span>{min}%</span><span>{max}%</span>
      </div>
    </div>
  );
}

/**
 * Dilution: more room, less time.
 *
 * The reason this needs explaining rather than just a button — dilution adds
 * nothing. It re-spreads the amount already paid over twice as many chunk
 * slots per depth step, so capacity doubles and REMAINING LIFE HALVES. People
 * reach for it when a batch is filling up and are surprised to find they have
 * bought space by spending time.
 *
 * The preview therefore leads with the TTL loss and what restoring it costs,
 * and the confirm button spells out both. Two clicks, like buying, because it
 * cannot be undone: depth only ever increases.
 */
function Dilute({ b, onDone }: { b: Batch; onDone: () => Promise<void> }) {
  const [preview, setPreview] = useState<DilutePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // A new depth invalidates a pending confirmation.
  const [steps, setSteps] = useState(1);
  useEffect(() => { setPreview(null); setDone(null); }, [steps, b.depth]);

  async function go(confirm: boolean) {
    setBusy(true); setErr(null);
    try {
      const r = await api.dilute(b.batchID, { newDepth: b.depth + steps, confirm });
      if (r.confirmRequired && r.preview) setPreview(r.preview);
      else if (r.dryRun && r.wouldDilute) {
        setDone(`DRY_RUN is on — would have diluted to depth ${r.wouldDilute.toDepth}.`);
        setPreview(null);
      } else if (r.diluted) {
        setDone(`Diluted to depth ${r.diluted.toDepth}. Remaining life is now about ${fmtDays(r.diluted.ttlDaysAfter)}.`);
        setPreview(null);
        await onDone();
      }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <h2 style={{ marginBottom: 8 }}>Dilute</h2>
      <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Doubles capacity per depth step and <strong>halves remaining life</strong> — the amount already
        paid has to cover twice as many chunks. Top up afterwards, not before, or half the top-up is
        spread thin along with everything else.
        {b.immutableFlag && ' This batch is immutable, so a single full bucket makes it refuse every'
          + ' upload — diluting is what makes it usable again.'}
      </p>

      <div className="row">
        <label className="field" style={{ marginBottom: 0 }}>
          To depth{' '}
          <select value={steps} onChange={(e) => setSteps(Number(e.target.value))} disabled={busy}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>{b.depth + n} (×{Math.pow(2, n)} capacity, ÷{Math.pow(2, n)} life)</option>
            ))}
          </select>
        </label>
        {/* The commit step is the LOUD one. It used to drop to the plain
            style exactly when it became the button that acts, so the first
            click looked like it had done nothing and left nothing to press. */}
        <button className={preview ? 'danger' : 'primary'} disabled={busy}
          onClick={() => go(Boolean(preview))}>
          {busy ? 'Working…'
            : preview ? `Yes — dilute to depth ${preview.toDepth}`
            : `Dilute to depth ${b.depth + steps}…`}
        </button>
        {preview && <button onClick={() => setPreview(null)} disabled={busy}>Cancel</button>}
      </div>

      {preview && (
        <div className="warn">
          Depth <strong>{preview.fromDepth} → {preview.toDepth}</strong>.
          Capacity {preview.capacityBeforeHuman} → <strong>{preview.capacityAfterHuman}</strong>.
          Remaining life {fmtDays(preview.ttlDaysBefore)} → <strong>{fmtDays(preview.ttlDaysAfter)}</strong>.
          <br />
          Restoring it to {preview.restoreToDays} days afterwards would cost{' '}
          <strong>{preview.restoreCostBzz.toFixed(3)} xBZZ</strong>
          {!preview.restoreAffordable && ' — more than the wallet holds'}.
          {b.managed
            ? ' This batch is managed, so auto top-up will restore it on the next cycle, within the caps.'
            : ' This batch is unmanaged, so nothing will restore that life automatically — top up by hand afterwards.'}
          {' '}Depth cannot be reduced again.
          <div style={{ marginTop: 8, fontWeight: 600 }}>
            Nothing has changed yet — press the button again to dilute.
          </div>
        </div>
      )}
      {done && <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent' }}>{done}</div>}
      {err && <div className="warn err">{err}</div>}
    </div>
  );
}

/**
 * The public download URL for a reference.
 *
 * The trailing slash is not cosmetic: without it the gateway answers 308 to add
 * one, which some tools follow and some do not. Including it means the link
 * works wherever it is pasted.
 *
 * Note the host. gateway.ethswarm.org/bzz/<ref> serves the gateway's own web
 * app and answers 200 with an HTML page, so a link built from it looks correct
 * and downloads nothing; download.gateway.ethswarm.org serves the bytes.
 */
function shareUrl(gateway: string | undefined, reference: string): string | null {
  // Returns null rather than building from `undefined`. TypeScript types this
  // as a string and cannot see whether the server actually sent it — the field
  // was briefly served from the wrong endpoint, which would have produced
  // "undefined/bzz/<ref>/" and copied cleanly to the clipboard.
  if (!gateway) return null;
  return `${gateway.replace(/\/+$/, '')}/bzz/${reference}/`;
}

/** Copy a shareable link, and say so — a silent clipboard write looks broken. */
function CopyLink({ url, label = 'Copy link' }: { url: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <button
      style={{ padding: '4px 10px', fontSize: 12 }}
      title={url}
      onClick={() => {
        navigator.clipboard?.writeText(url).then(() => {
          setCopied(true); setTimeout(() => setCopied(false), 1800);
        }).catch(() => {
          // Clipboard is blocked without a secure context or permission. The
          // title attribute still carries the URL, so it stays retrievable.
          window.prompt('Copy this link', url);
        });
      }}>
      {copied ? 'copied ✓' : label}
    </button>
  );
}

/**
 * One stored upload.
 *
 * View and Download both pull through the authenticated content proxy — the
 * Bee node is not publicly reachable, and a link cannot carry the admin token.
 * Object URLs are revoked once handed over so a long session does not retain
 * every file it has looked at.
 */
function UploadRow({ u, gateway }: { u: Upload; gateway: string }) {
  const [busy, setBusy] = useState<'view' | 'download' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function open(mode: 'view' | 'download') {
    setBusy(mode); setErr(null);
    try {
      const url = await api.fetchContent(u.reference);
      if (mode === 'view') {
        window.open(url, '_blank', 'noopener');
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = u.name || `${u.reference.slice(0, 12)}.bin`;
        a.click();
      }
      // The tab or the download has taken its own copy by now.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  }

  return (
    <tr>
      <td>{u.name || <span className="muted">unnamed</span>}
        {err && <div className="warn err" style={{ fontSize: 12, marginTop: 4 }}>{err}</div>}
      </td>
      <td className="num mono">{fmtBytes(u.bytes)}</td>
      <td className="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        {new Date(u.ts).toLocaleString()}
      </td>
      <td>
        <button className="reflink" title={u.reference}
          onClick={() => {
            navigator.clipboard?.writeText(u.reference).then(() => {
              setCopied(true); setTimeout(() => setCopied(false), 1500);
            }).catch(() => { /* clipboard blocked; the title attribute still shows it */ });
          }}>
          {copied ? 'copied' : `${u.reference.slice(0, 10)}…`}
        </button>
      </td>
      <td>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <button style={{ padding: '4px 10px', fontSize: 12 }}
            disabled={busy !== null} onClick={() => open('view')}>
            {busy === 'view' ? '…' : 'view'}
          </button>
          <button style={{ padding: '4px 10px', fontSize: 12 }}
            disabled={busy !== null} onClick={() => open('download')}>
            {busy === 'download' ? '…' : 'download'}
          </button>
          <CopyLink url={shareUrl(gateway, u.reference)} />
        </div>
      </td>
    </tr>
  );
}

/**
 * Why a file cannot be uploaded, or null if it can.
 *
 * Checked in the browser so the answer arrives before the transfer rather
 * than after it. The server re-checks regardless — this is a courtesy, not
 * the enforcement.
 */
function rejectReason(file: File, data: BucketGrid): string | null {
  if (file.size === 0) return 'That file is empty.';
  if (file.size > data.maxUploadBytes) {
    return `${file.name} is ${fmtBytes(file.size)}, over the ${fmtBytes(data.maxUploadBytes)} limit. ` +
      'The whole file is held in memory while it is stamped, so the ceiling is the service\'s memory, not a policy.';
  }
  // Chunk cost exceeds bytes/4096 — Swarm adds Merkle-tree and manifest chunks
  // above the data — so compare generously rather than exactly.
  const needChunks = Math.ceil(file.size / 4096);
  if (needChunks > data.freeChunks) {
    return `${file.name} needs about ${needChunks.toLocaleString()} chunks but only ` +
      `${data.freeChunks.toLocaleString()} slots remain in this batch. Buy a deeper batch, or dilute this one.`;
  }
  return null;
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <span style={{ width: 12, height: 12, background: color, borderRadius: 3, display: 'inline-block' }} />
      <span className="secondary">{label}</span>
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="tile-label">{label}</div>
      <div className="tile-value" style={{ fontSize: 18 }}>{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}


