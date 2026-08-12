/**
 * The bucket map — a batch's 65,536 buckets drawn as a 256x256 grid.
 *
 * Reading it: each cell is one bucket, and a chunk's address decides which
 * bucket its stamp lands in. Shading is how full that bucket is. So this shows
 * the thing the headline "x% used" cannot — that capacity is not one pool but
 * 65,536 separate bins, filling unevenly, and the batch starts failing when the
 * *first* bin fills, not when the average does.
 *
 * Colour follows the two jobs on screen: fill level is a magnitude, so it takes
 * one hue light-to-dark from the sequential ramp; "at capacity" is a state with
 * reserved meaning, so it takes the critical status colour and is named in the
 * legend rather than left to colour alone.
 *
 * Drawn to a canvas at one device pixel per bucket and scaled up with
 * pixelated interpolation. 65,536 DOM nodes would be unusable; ImageData is a
 * single blit, and keeping one pixel per bucket means no bucket is averaged
 * away — a lone full bin stays visible, which is exactly the case that matters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import type { BucketGrid } from './api';
import { decodeGrid, fillColor, readPalette } from './mapColors';

export function BucketMap({ batchId, isAmbient, onAmbient }: {
  batchId: string;
  isAmbient?: boolean;
  onAmbient?: () => void;
}) {
  const [data, setData] = useState<BucketGrid | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; id: number; count: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const filePick = useRef<HTMLInputElement>(null);
  // Bumped by the theme observer to force a redraw with the new ramp.
  const [theme, setTheme] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<
    { name: string; bytes: number; reference: string; newChunks: number } | null>(null);

  const load = useCallback(async () => {
    const d = await api.getBuckets(batchId);
    setData(d);
    return d;
  }, [batchId]);

  useEffect(() => {
    setData(null); setErr(null); setUploaded(null);
    load().catch((e) => setErr(e.message));
  }, [batchId, load]);

  /**
   * Upload, then re-read the buckets so the new cells appear immediately.
   *
   * The chunk delta is measured rather than derived from the file size: Swarm
   * adds intermediate chunks for the Merkle tree above the data chunks, so
   * bytes/4096 always understates what a file actually costs in slots.
   */
  async function onFile(file: File) {
    setUploading(true); setErr(null); setUploaded(null);
    const before = data?.totalChunks ?? 0;
    try {
      const r = await api.uploadToBatch(batchId, file);
      const after = await load();
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

  /** Decoded fill bytes, one per bucket. */
  const fills = useMemo(() => {
    if (!data) return null;
    return decodeGrid(data.grid);
  }, [data]);

  // The theme toggle stamps data-theme on <html>; the OS setting changes the
  // media query. Both must repaint, since the ramp anchors flip between modes.
  useEffect(() => {
    const bump = () => setTheme((t) => t + 1);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    const obs = new MutationObserver(bump);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', bump); obs.disconnect(); };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !data || !fills) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const side = data.side;
    el.width = side; el.height = side;

    const root = document.documentElement;
    // Sequential ramp: light -> dark in light mode, and the anchors are already
    // flipped for dark mode in styles.css, so this reads correctly in both.
    const p = readPalette(root);

    const img = ctx.createImageData(side, side);
    for (let i = 0; i < fills.length; i++) {
      const [r, g, b] = fillColor(fills[i], p);
      const o = i * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [data, fills, theme]);

  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!data || !fills) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * data.side);
    const y = Math.floor(((e.clientY - r.top) / r.height) * data.side);
    if (x < 0 || y < 0 || x >= data.side || y >= data.side) return setHover(null);
    const id = y * data.side + x;
    // Recover an approximate count from the drawn fill. The exact totals in the
    // stats line come from raw counts server-side; this is per-bucket detail.
    const count = Math.round((fills[id] / 255) * data.bucketUpperBound);
    // Keep the readout inside the canvas: near the right edge it flips to the
    // left of the cursor rather than overflowing the modal's scroll box.
    const px = e.clientX - r.left;
    const flip = px > r.width - 150;
    setHover({ x: flip ? px - 138 : px + 12, y: e.clientY - r.top, id, count });
  }

  return (
    <div>
      {err && <div className="warn err">{err}</div>}
      {!data && !err && <p className="muted">Reading 65,536 buckets…</p>}

      {data && (
        <>
          <p className="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
            Each cell is one of the {(1 << data.bucketDepth).toLocaleString()} buckets in this batch,
            shaded by how full it is. A chunk's address decides which bucket it must use, so buckets
            fill unevenly — and the batch starts refusing writes when the <em>first</em> bucket fills,
            not when the average does.
          </p>

          <div ref={wrap} style={{ position: 'relative', maxWidth: 560, margin: '0 auto' }}>
            <canvas
              ref={canvas}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
              style={{
                width: '100%', aspectRatio: '1 / 1', display: 'block',
                imageRendering: 'pixelated',
                border: '1px solid var(--border)', borderRadius: 6,
              }}
            />
            {hover && (
              <div className="tooltip" style={{ left: hover.x, top: hover.y + 12 }}>
                bucket {hover.id.toLocaleString()}<br />
                {hover.count} / {data.bucketUpperBound} stamps
              </div>
            )}
          </div>

          {/* Identity is never colour alone: every swatch is labelled. */}
          <div className="row" style={{ gap: 16, marginTop: 10, fontSize: 12, flexWrap: 'wrap' }}>
            <Key color="var(--grid)" label="empty" />
            <Key color="var(--map-low)" label="lightly used" />
            <Key color="var(--map-mid)" label="half full" />
            <Key color="var(--map-high)" label="mostly full" />
            <Key color="var(--warning)" label="nearly full — 80%+" />
            <Key color="var(--critical)" label="at capacity — rejects or recycles" />
          </div>

          <div className="tiles" style={{ marginTop: 16 }}>
            <Stat label="Stored" value={fmtBytes(data.storedBytes)}
              sub={`${data.totalChunks.toLocaleString()} chunks`} />
            <Stat label="Capacity" value={fmtBytes(data.capacityBytes)}
              sub={`depth ${data.depth}`} />
            <Stat label="Buckets used" value={data.usedBuckets.toLocaleString()}
              sub={`of ${(1 << data.bucketDepth).toLocaleString()}`} />
            <Stat label="Fullest bucket" value={`${data.maxCollisions} / ${data.bucketUpperBound}`}
              sub={data.fullBuckets > 0 ? `${data.fullBuckets.toLocaleString()} at capacity` : 'none at capacity'} />
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
              <button className="primary" disabled={uploading}
                onClick={() => filePick.current?.click()}>
                {uploading ? 'Uploading…' : 'Upload a file'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                Stamps it with this batch and fills buckets — watch the grid change.
              </span>
            </div>
            {/* Both of these are irreversible, and neither is obvious from a
                file picker, so they are stated where the choice is made. */}
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Uploaded data is public — anyone with the reference can fetch it — and the
              stamps it consumes cannot be reclaimed
              {data.immutable ? ', and this batch is immutable, so those bucket slots are gone for its lifetime.' : '.'}
            </p>
            {uploaded && (
              <div className="warn" style={{ borderLeftColor: 'var(--good)', background: 'transparent' }}>
                Uploaded <strong>{uploaded.name}</strong> ({fmtBytes(uploaded.bytes)}) —{' '}
                <strong>{uploaded.newChunks.toLocaleString()}</strong> new chunk{uploaded.newChunks === 1 ? '' : 's'}.
                <br />
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{uploaded.reference}</code>
              </div>
            )}
          </div>

          {onAmbient && (
            <div className="row" style={{ marginTop: 14 }}>
              <button onClick={onAmbient}>
                {isAmbient ? 'Remove from background' : 'Show as background'}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {isAmbient
                  ? 'This batch is painted behind the dashboard.'
                  : 'Paint this batch behind the dashboard, refreshed every minute.'}
              </span>
            </div>
          )}

          {data.totalChunks > 0 && data.usedBuckets > 0 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              Occupying {((data.usedBuckets / (1 << data.bucketDepth)) * 100).toFixed(2)}% of buckets
              and {((data.storedBytes / data.capacityBytes) * 100).toFixed(4)}% of paid capacity.
              {data.storedBytes / data.capacityBytes < 0.01 &&
                ' Rent is charged on the whole batch regardless, so most of what this costs is buying empty space.'}
            </p>
          )}
        </>
      )}
    </div>
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
