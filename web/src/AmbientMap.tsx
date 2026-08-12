/**
 * The bucket map as the page background — a live wallpaper for one batch.
 *
 * Fills the viewport behind the dashboard and keeps refreshing, so a screen
 * left on this shows the batch's real state rather than a snapshot. Hiding the
 * interface leaves the map alone on screen.
 *
 * It is decoration in the strict sense: `pointer-events: none` and
 * `aria-hidden`, so it never intercepts a click and never reaches a screen
 * reader. Every number it depicts is available as text in the modal, which is
 * the accessible path — this view adds no information that exists nowhere else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import { decodeGrid, fillColor, layoutFor, readPalette } from './mapColors';

/**
 * How often to re-read the buckets.
 *
 * Slower than the dashboard's 30s because bucket occupancy only moves when
 * something uploads, and each read is ~88 KB. Fast enough that a wall display
 * is never meaningfully stale.
 */
const REFRESH_MS = 60_000;

export function AmbientMap({ batchId }: { batchId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fills = useRef<Uint8Array | null>(null);
  const [tick, setTick] = useState(0);

  // Re-read on an interval, and whenever the batch changes.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const d = await api.getBuckets(batchId);
        if (!alive) return;
        fills.current = decodeGrid(d.grid);
        setTick((t) => t + 1);
      } catch {
        // A failed read keeps the last painted frame. A background that blanks
        // itself on a transient error is worse than one that is briefly stale.
      }
    };
    read();
    const iv = setInterval(read, REFRESH_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [batchId]);

  const draw = useCallback(() => {
    const el = canvas.current;
    const f = fills.current;
    if (!el || !f) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const { cols, rows } = layoutFor(f.length, w, h);

    // One backing pixel per bucket, then scaled up by CSS with pixelated
    // interpolation — cheap, and it keeps every bucket individually visible
    // instead of averaging neighbours into a blur.
    el.width = cols;
    el.height = rows;

    const p = readPalette();
    const img = ctx.createImageData(cols, rows);
    const total = cols * rows;
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      if (i >= f.length) {
        // Padding cells beyond the last bucket. Fully transparent so they read
        // as page background rather than as empty buckets that do not exist.
        img.data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = fillColor(f[i], p);
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, []);

  useEffect(() => { draw(); }, [draw, tick]);

  // Redraw on resize (the layout is derived from the viewport) and on a theme
  // change (the ramp anchors flip between light and dark).
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onResize);
    const obs = new MutationObserver(onResize);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      window.removeEventListener('resize', onResize);
      mq.removeEventListener('change', onResize);
      obs.disconnect();
    };
  }, [draw]);

  return <canvas ref={canvas} className="ambient" aria-hidden="true" />;
}
