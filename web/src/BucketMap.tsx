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

import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import type { BucketGrid } from './api';

/** #rrggbb -> [r,g,b]. */
function hex(c: string): [number, number, number] {
  const m = c.trim().replace('#', '');
  const v = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

/**
 * Encoded fill at which a bucket counts as "nearly full".
 *
 * 80% of the 1..254 range used for partial buckets. Matches the threshold in
 * bucketPressure() so the colour and the written warning agree — a bucket that
 * turns amber here is one the summary is already calling out.
 */
const NEAR_FULL_BYTE = Math.round(0.8 * 254);

/** Read a CSS custom property so the map tracks the active theme. */
function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function BucketMap({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BucketGrid | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; id: number; count: number } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Bumped by the theme observer to force a redraw with the new ramp.
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    setData(null); setErr(null);
    api.getBuckets(batchId).then(setData).catch((e) => setErr(e.message));
  }, [batchId]);

  /** Decoded fill bytes, one per bucket. */
  const fills = useMemo(() => {
    if (!data) return null;
    const bin = atob(data.grid);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
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
    const c0 = hex(cssVar(root, '--map-low', '#b7d3f6'));
    const c1 = hex(cssVar(root, '--map-mid', '#3987e5'));
    const c2 = hex(cssVar(root, '--map-high', '#184f95'));
    const near = hex(cssVar(root, '--warning', '#fab219'));
    const full = hex(cssVar(root, '--critical', '#d03b3b'));
    const empty = hex(cssVar(root, '--grid', '#e1e0d9'));

    const img = ctx.createImageData(side, side);
    for (let i = 0; i < fills.length; i++) {
      const f = fills[i];
      let r: number, g: number, b: number;
      if (f === 0) {
        [r, g, b] = empty;
      } else if (f >= 255) {
        // At capacity: a state, not a degree. Reserved critical colour.
        [r, g, b] = full;
      } else if (f >= NEAR_FULL_BYTE) {
        // >=80% full: also a state, and the same threshold the written warning
        // uses, so the map turns amber exactly when the text says it should.
        // Kept off the blue ramp deliberately — "nearly out of room" must not
        // read as merely one more shade darker.
        [r, g, b] = near;
      } else {
        // Floor the ramp so an occupied bucket is never near-invisible against
        // the empty colour. A bucket holding 1 of 256 stamps is 0.4% full and
        // would otherwise render as the lightest step, indistinguishable from
        // empty — and sparse batches are the normal case here, so the map would
        // be blank exactly when it has something to say. Applied at draw time
        // only: the encoded byte stays a true fill fraction, which is what the
        // hover readout derives its count from.
        const t = 0.35 + 0.65 * (f / NEAR_FULL_BYTE);
        if (t < 0.5) {
          const u = t / 0.5;
          r = lerp(c0[0], c1[0], u); g = lerp(c0[1], c1[1], u); b = lerp(c0[2], c1[2], u);
        } else {
          const u = (t - 0.5) / 0.5;
          r = lerp(c1[0], c2[0], u); g = lerp(c1[1], c2[1], u); b = lerp(c1[2], c2[2], u);
        }
      }
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
