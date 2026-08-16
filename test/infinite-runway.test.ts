/**
 * A node with nothing to burn has an UNBOUNDED runway, and that has to survive
 * the trip to the browser.
 *
 * It did not. runwaySeconds() returns Infinity when the burn is zero, and
 * JSON.stringify turns Infinity into null. On the client the guards used the
 * global isFinite(), which coerces null to 0 and returns true — so the most
 * comfortable state a node can be in rendered as a critical, zero-day runway
 * with the hero counting down from nothing.
 */

import { describe, expect, it } from 'bun:test';
import { runwaySeconds } from '../src/math';
import { totalBurnPer30Days, totalCommitted } from '../src/evaluate';

/** What server.ts does on the way out. */
const normalise = (n: number) => (isFinite(n) ? n : null);
/** What the network does to it. */
const overTheWire = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('a node with no live batches', () => {
  it('has zero burn and therefore an infinite runway', () => {
    expect(totalBurnPer30Days([], 24_000n, 5_000)).toBe(0n);
    expect(totalCommitted([])).toBe(0n);
    expect(runwaySeconds(10n ** 18n, 0n)).toBe(Infinity);
  });

  it('sends null rather than a number that reads as zero', () => {
    const days = runwaySeconds(10n ** 18n, 0n) / 86_400;
    expect(overTheWire({ runwayDays: normalise(days) })).toEqual({ runwayDays: null });
  });

  it('is why the client must not use the global isFinite', () => {
    const wire = overTheWire({ runwayDays: normalise(Infinity) }) as { runwayDays: number | null };
    // The bug, exactly: both of these are how it used to be read.
    expect(isFinite(wire.runwayDays as number)).toBe(true);
    expect(Math.round(wire.runwayDays as number)).toBe(0);
    expect((wire.runwayDays as number) < 30).toBe(true);   // -> 'critical'
    // The fix.
    expect(wire.runwayDays == null).toBe(true);
    expect(Number.isFinite(wire.runwayDays)).toBe(false);
  });

  it('still sends a real number when there IS a burn', () => {
    const days = runwaySeconds(10n ** 18n, 10n ** 16n) / 86_400;
    const wire = overTheWire({ runwayDays: normalise(days) }) as { runwayDays: number | null };
    expect(wire.runwayDays).toBeCloseTo(3000, 0);
  });
});
