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

export function MapCanvas({ fills, bucketUpperBound, onHover }: {
  fills: Uint8Array | null;
  bucketUpperBound: number;
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

    const p = readPalette();
    const img = ctx.createImageData(cols, rows);
    const total = cols * rows;
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
  }, [fills]);

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
      className={`ambient${onHover ? ' is-interactive' : ''}`}
      aria-hidden="true"
      onMouseMove={onMove}
      onMouseLeave={() => onHover?.(null)}
    />
  );
}
