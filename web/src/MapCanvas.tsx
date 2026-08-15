/**
 * The bucket map filling the viewport, behind the page.
 *
 * Purely presentational — it is handed the decoded fill bytes and draws them.
 * The batch page owns the fetching, so one read feeds both this and the panel
 * rather than each pulling its own copy of 65,536 buckets.
 *
 * The square 256x256 arrangement is only a convention; a bucket's index says
 * nothing about where it "is". So the grid reflows to the viewport's aspect
 * instead of being stretched (which would make cells non-square and
 * misrepresent their size) or cropped (which would hide buckets, defeating a
 * view whose job is showing all of them at once).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fillColor, layoutFor, readPalette } from './mapColors';

export interface Hover { x: number; y: number; id: number; count: number }

/**
 * Two renderings of the same buckets, for two different jobs.
 *
 *   pixels  the instrument. One cell per bucket, the full colour ramp, sharp
 *           edges, hoverable. What you want when studying the batch.
 *   stars   the wallpaper. Black sky, monochrome points, brightness by how
 *           full the bucket is, softened. What you want behind a page you are
 *           reading — legible as texture, not as data.
 *
 * The star field is drawn at one pixel per bucket and then scaled up SMOOTHLY
 * with a blur, rather than as thousands of individual glows. That is both far
 * cheaper — a dense batch would otherwise mean 65,536 radial gradients per
 * frame — and more accurate to how a bright point actually looks: the bloom
 * from blurring makes brighter stars read as larger, which is the effect
 * asked for and the reason real photographs of stars behave that way.
 */
export type MapMode = 'pixels' | 'stars';

export function MapCanvas({ fills, bucketUpperBound, mode, onHover }: {
  fills: Uint8Array | null;
  bucketUpperBound: number;
  mode: MapMode;
  /** When given, the canvas becomes hoverable and reports the bucket under the cursor. */
  onHover?: (h: Hover | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const grid = useRef({ cols: 256, rows: 256 });
  const [, force] = useState(0);

  const draw = useCallback(() => {
    const el = canvas.current;
    if (!el || !fills) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;

    const { cols, rows } = layoutFor(fills.length, window.innerWidth, window.innerHeight);
    grid.current = { cols, rows };

    if (mode === 'stars') {
      // Drawn at the viewport's own resolution, one POINT per bucket, rather
      // than one fat cell per bucket softened with a blur. At 1920x1080 a
      // bucket cell is ~5.6px across; blurring that gives a field of soft
      // blobs, not stars. A star is small and sharp, and the eye reads
      // brightness rather than area — so the core is a single pixel and only
      // the brightest get a faint halo.
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      el.width = w;
      el.height = h;

      const img = ctx.createImageData(w, h);
      const d = img.data;
      // Opaque black everywhere: a night sky has no holes in it.
      for (let i = 3; i < d.length; i += 4) d[i] = 255;

      const cellW = w / cols;
      const cellH = h / rows;

      // Stretch the brightness scale across the range actually present.
      //
      // Anchoring to a full bucket puts this whole batch in the bottom 2% of
      // the scale: at depth 24 the fullest bucket holds 5 of 256, so every
      // star renders between 141 and 167 out of 255 — a flat grey dust. The
      // ordering is preserved and brighter still means fuller; what changes is
      // that the range on screen matches the range in the data.
      //
      // This is a contrast stretch, the same thing done to every astronomical
      // photograph, and it is a display choice: the absolute figures live in
      // the instrument view and in the bucket statistics, which do not stretch
      // anything.
      let lo = 255;
      let hi = 1;
      for (let i = 0; i < fills.length; i++) {
        const f = fills[i];
        if (f === 0) continue;
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
      const lnLo = Math.log1p(lo);
      const lnSpan = Math.max(1e-6, Math.log1p(hi) - lnLo);

      const put = (x: number, y: number, v: number) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const o = (y * w + x) * 4;
        // Additive, so two stars landing on the same pixel brighten rather
        // than the later one replacing the earlier.
        d[o] = Math.min(255, d[o] + Math.round(v * 0.92));
        d[o + 1] = Math.min(255, d[o + 1] + Math.round(v * 0.96));
        d[o + 2] = Math.min(255, d[o + 2] + v);
      };

      for (let i = 0; i < fills.length; i++) {
        const f = fills[i];
        if (f === 0) continue;

        // Logarithmic, as stellar magnitude is. On the live depth-24 batch
        // 9,971 buckets hold one chunk and 886 hold two; linearly that whole
        // range renders as one indistinguishable value.
        //
        // The floor is high because that dominant population IS the sky. As a
        // single pixel rather than a blurred cell it needs real brightness to
        // register at all — a faint 1px point is just black. Which matches a
        // real sky: mostly similar faint stars, a few brilliant ones.
        const t = (Math.log1p(f) - lnLo) / lnSpan;
        const v = Math.round(110 + 145 * t);

        // Jitter within the cell, deterministically from the index. Placing
        // every star at its cell centre draws a 5.6px lattice, and a regular
        // grid of dots reads as a texture swatch rather than a sky. The hash
        // keeps it stable across redraws so stars do not swim on resize.
        const hx = ((i * 2654435761) >>> 0) / 4294967296;
        const hy = ((i * 40503 + 12345) >>> 0 % 4294967296) / 4294967296;
        const cx = Math.floor((i % cols) * cellW + hx * cellW);
        const cy = Math.floor(Math.floor(i / cols) * cellH + hy * cellH);
        put(cx, cy, v);

        // Only the brightest bleed into their neighbours. That is what makes a
        // bright star look bigger without drawing anything larger, and it is
        // why a photographed sky has a range of apparent sizes at all.
        if (v > 190) {
          const halo = Math.round((v - 190) * 0.5);
          put(cx - 1, cy, halo); put(cx + 1, cy, halo);
          put(cx, cy - 1, halo); put(cx, cy + 1, halo);
        }
        if (v > 230) {
          const corner = Math.round((v - 230) * 0.4);
          put(cx - 1, cy - 1, corner); put(cx + 1, cy - 1, corner);
          put(cx - 1, cy + 1, corner); put(cx + 1, cy + 1, corner);
        }
      }
      ctx.putImageData(img, 0, 0);
      return;
    }

    el.width = cols;
    el.height = rows;
    const img = ctx.createImageData(cols, rows);
    const total = cols * rows;

    const p = readPalette();
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      if (i >= fills.length) {
        // Padding beyond the last bucket: transparent, so it reads as page
        // background rather than as empty buckets that do not exist.
        img.data[o + 3] = 0;
        continue;
      }
      const [r, g, b] = fillColor(fills[i], p);
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [fills, mode]);

  useEffect(() => { draw(); }, [draw]);

  // The layout depends on the viewport, and the ramp anchors flip with theme.
  useEffect(() => {
    const redraw = () => { draw(); force((n) => n + 1); };
    window.addEventListener('resize', redraw);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', redraw);
    const obs = new MutationObserver(redraw);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      window.removeEventListener('resize', redraw);
      mq.removeEventListener('change', redraw);
      obs.disconnect();
    };
  }, [draw]);

  function onMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!onHover || !fills) return;
    const { cols, rows } = grid.current;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * cols);
    const y = Math.floor(((e.clientY - r.top) / r.height) * rows);
    const id = y * cols + x;
    if (x < 0 || y < 0 || x >= cols || y >= rows || id >= fills.length) return onHover(null);
    onHover({
      x: e.clientX, y: e.clientY, id,
      count: Math.round((fills[id] / 255) * bucketUpperBound),
    });
  }

  return (
    <canvas
      ref={canvas}
      className={`ambient is-${mode}${onHover ? ' is-interactive' : ''}`}
      aria-hidden="true"
      onMouseMove={onMove}
      onMouseLeave={() => onHover?.(null)}
    />
  );
}
