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
import type { BucketGrid, State, Upload } from './api';
import { decodeGrid } from './mapColors';
import { MapCanvas, type Hover } from './MapCanvas';
import { link } from './router';

/** Buckets are re-read on this cadence so a screen left open stays current. */
const REFRESH_MS = 60_000;

export function BatchDetail({ batchId, state }: { batchId: string; state: State | null }) {
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
    if (!panelHidden) return;
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
      <MapCanvas fills={fills} bucketUpperBound={data?.bucketUpperBound ?? 1} onHover={setHover} />
      {hover && (
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
          <button onClick={() => setPanelHidden(true)}>Hide panel</button>
        </div>

        {err && <div className="warn err">{err}</div>}
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
              <Stat label="Capacity" value={fmtBytes(data.capacityBytes)} sub={`depth ${data.depth}`} />
              <Stat label="Buckets used" value={data.usedBuckets.toLocaleString()}
                sub={`of ${(1 << data.bucketDepth).toLocaleString()}`} />
              <Stat label="Fullest bucket" value={`${data.maxCollisions} / ${data.bucketUpperBound}`}
                sub={data.fullBuckets > 0 ? `${data.fullBuckets.toLocaleString()} at capacity` : 'none at capacity'} />
            </div>

            {/* Identity is never colour alone: every swatch is labelled. */}
            <div className="row" style={{ gap: 16, marginTop: 14, fontSize: 12, flexWrap: 'wrap' }}>
              <Key color="var(--grid)" label="empty" />
              <Key color="var(--map-low)" label="lightly used" />
              <Key color="var(--map-mid)" label="half full" />
              <Key color="var(--map-high)" label="mostly full" />
              <Key color="var(--warning)" label="nearly full — 80%+" />
              <Key color="var(--critical)" label="at capacity" />
            </div>

            <div className={`warn ${data.pressure.level === 'critical' ? 'err' : ''}`}
              style={data.pressure.level === 'good'
                ? { borderLeftColor: 'var(--good)', background: 'transparent' } : undefined}>
              {data.pressure.message}
            </div>

            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <div className="row">
                <input ref={filePick} type="file" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
                <button className="primary" disabled={uploading} onClick={() => filePick.current?.click()}>
                  {uploading ? 'Uploading…' : 'Upload a file'}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Stamps it with this batch — watch the background fill.
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
                </div>
              )}
            </div>

            {uploads.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                <h2 style={{ marginBottom: 10 }}>Uploaded with this batch</h2>
                <div className="scroll-x">
                  <table>
                    <thead>
                      <tr><th>File</th><th className="num">Size</th><th>When</th><th>Reference</th><th></th></tr>
                    </thead>
                    <tbody>
                      {uploads.map((u) => <UploadRow key={u.id} u={u} />)}
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
            )}

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
      </div>

      {panelHidden && (
        <div className="ambient-bar">
          <span className="label">{title}</span>
          <button onClick={() => setPanelHidden(false)}>Show panel</button>
        </div>
      )}
    </>
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
function UploadRow({ u }: { u: Upload }) {
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
        </div>
      </td>
    </tr>
  );
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

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log10(n) / 3), u.length - 1);
  const v = n / Math.pow(1000, i);
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
