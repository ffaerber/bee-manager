/**
 * Depth labels on the slider.
 *
 * A bare "22" says nothing; "d22 · 17 GB" says what the ceiling actually
 * permits. The range runs to depth 41, and labelling the top as 9.0 PB is the
 * point — it makes the far end visibly absurd rather than merely large.
 */
import { describe, expect, it } from 'bun:test';
import { depthCapacity } from '../web/src/format';
import { capacityBytes } from '../src/math';

describe('depthCapacity', () => {
  it('matches the server-side capacity for the depths in use', () => {
    // The label must not disagree with what the batch page reports.
    for (const d of [17, 18, 19, 20, 24]) {
      const server = Number(capacityBytes(d));
      const shown = depthCapacity(d);
      const n = parseFloat(shown);
      const unit = shown.split(' ')[1]!;
      const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };
      const m = mult[unit]!;
      expect(Math.abs(n * m - server) / server).toBeLessThan(0.05);
    }
  });

  it('doubles with each depth step', () => {
    // The trade the slider exists to show: one notch is twice the capacity and
    // twice the cost of keeping it alive.
    const at = (d: number) => Math.pow(2, d) * 4096;
    expect(at(19) / at(18)).toBe(2);
    expect(at(24) / at(18)).toBe(64);
  });

  it('labels the extremes readably', () => {
    // Formatted by the same fmtBytes the rest of the dashboard uses, so a
    // depth label and a stored-size figure never disagree about how to write
    // a number.
    expect(depthCapacity(17)).toBe('537 MB');
    expect(depthCapacity(41)).toBe('9.01 PB');
  });

  it('stays a short label at every allowed depth', () => {
    // It sits inside a slider row; a long string would wrap and shift layout.
    for (let d = 17; d <= 41; d++) {
      expect(depthCapacity(d).length).toBeLessThanOrEqual(8);
    }
  });
});
