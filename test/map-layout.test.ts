/**
 * The ambient background reflows the buckets to the viewport's aspect rather
 * than stretching a square, so the layout has one hard requirement: every
 * bucket must get a cell. A layout that comes up short silently hides data on
 * a display whose entire job is to show all of it.
 */
import { describe, expect, it } from 'bun:test';
import { layoutFor } from '../web/src/mapColors';

const N = 65536;

describe('layoutFor', () => {
  const viewports: [number, number, string][] = [
    [1920, 1080, '16:9 desktop'],
    [2560, 1440, '1440p'],
    [3840, 2160, '4K'],
    [1280, 800, '16:10 laptop'],
    [768, 1024, 'portrait tablet'],
    [390, 844, 'phone'],
    [3440, 1440, 'ultrawide'],
  ];

  for (const [w, h, name] of viewports) {
    it(`covers every bucket on ${name}`, () => {
      const { cols, rows } = layoutFor(N, w, h);
      expect(cols * rows).toBeGreaterThanOrEqual(N);
    });

    it(`keeps cells near-square on ${name}`, () => {
      const { cols, rows } = layoutFor(N, w, h);
      // Cell aspect = (w/cols) / (h/rows). Anything far from 1 means the grid
      // is visibly stretched, which misrepresents relative bucket size.
      const aspect = (w / cols) / (h / rows);
      expect(aspect).toBeGreaterThan(0.8);
      expect(aspect).toBeLessThan(1.25);
    });

    it(`wastes little space on ${name}`, () => {
      const { cols, rows } = layoutFor(N, w, h);
      // Padding cells are drawn transparent; a lot of them would mean a band
      // of dead background along one edge.
      expect((cols * rows - N) / N).toBeLessThan(0.05);
    });
  }

  it('degrades to a square when the viewport is not measurable yet', () => {
    // First paint can report 0x0; a NaN layout there would blank the canvas.
    const { cols, rows } = layoutFor(N, 0, 0);
    expect(cols).toBe(256);
    expect(rows).toBe(256);
  });
});
