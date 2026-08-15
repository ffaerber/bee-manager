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
    el.width = cols;
    el.height = rows;

    const img = ctx.createImageData(cols, rows);
    const total = cols * rows;

    if (mode === 'stars') {
      for (let i = 0; i < total; i++) {
        const o = i * 4;
        // Opaque black everywhere, including the padding cells: a night sky
        // has no holes in it, and transparency would show the page through.
        img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255;
        if (i >= fills.length) continue;
        const f = fills[i];
        if (f === 0) continue;

        // Brightness is LOGARITHMIC in the bucket's fill, for the same reason
        // stellar magnitude is: a linear or mild-gamma curve puts all the real
        // data at one brightness. On the live depth-24 batch 9,971 buckets hold
        // one chunk, 886 hold two, 56 hold three — under gamma 0.7 that whole
        // range renders 74 to 82, indistinguishable. Logarithmically it spans
        // 71 to 116, so the crowded parts of the sky actually read as brighter.
        const t = Math.log1p(f) / Math.log1p(255);
        const v = Math.round(45 + 210 * t);
        // Very slightly cool, the way white points on black usually read.
        img.data[o] = Math.round(v * 0.94);
        img.data[o + 1] = Math.round(v * 0.97);
        img.data[o + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
      return;
    }

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
