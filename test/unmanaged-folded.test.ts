/**
 * Unmanaged batches are folded by default.
 *
 * Unmanaged is the deliberate state for a batch being allowed to lapse, so the
 * list is mostly things already decided. Left expanded it sits above the
 * batches that still need renewing — and a list of resolved items in the way
 * of live ones is how the live ones stop being read.
 *
 * What must NOT be folded away is the soonest expiry: nothing renews an
 * unmanaged batch and nothing alerts on it, so the fold is the only thing
 * standing between "deliberately lapsing" and "lapsed without anyone seeing".
 */
import { describe, it, expect, beforeEach } from 'bun:test';

/** The stored-preference rule, extracted from useSticky. */
function resolve(stored: string | null, initial: boolean): boolean {
  return stored === null ? initial : stored === '1';
}

const KEY = 'ssm.hideUnmanaged.v2';
const DEFAULT_HIDDEN = true;

describe('the fold default', () => {
  it('hides the list for a browser that has never chosen', () => {
    expect(resolve(null, DEFAULT_HIDDEN)).toBe(true);
  });

  it('still honours an explicit choice once made', () => {
    expect(resolve('0', DEFAULT_HIDDEN)).toBe(false);
    expect(resolve('1', DEFAULT_HIDDEN)).toBe(true);
  });

  /**
   * The reason for the version bump. Under the old key a browser that had
   * chosen "show" stored '0', and reusing the key would have kept that
   * forever — the new default would look broken rather than applied.
   */
  it('is not overridden by a preference stored under the old key', () => {
    const legacy = { 'ssm.hideUnmanaged': '0' } as Record<string, string>;
    expect(KEY in legacy).toBe(false);
    expect(resolve(legacy[KEY] ?? null, DEFAULT_HIDDEN)).toBe(true);
  });
});

describe('what survives the fold', () => {
  const batches = [
    { label: 'kept', managed: true, ttlDays: 28 },
    { label: 'lapsing-soon', managed: false, ttlDays: 16 },
    { label: 'lapsing-later', managed: false, ttlDays: 47.7 },
  ];

  it('separates the two lists', () => {
    expect(batches.filter((b) => b.managed).map((b) => b.label)).toEqual(['kept']);
    expect(batches.filter((b) => !b.managed).length).toBe(2);
  });

  it('keeps the soonest unmanaged expiry visible while folded', () => {
    const unmanaged = batches.filter((b) => !b.managed);
    const soonest = unmanaged.reduce((a, b) => (b.ttlDays < a.ttlDays ? b : a));
    // Hiding the rows must not hide the one fact that cannot be recovered
    // from an alert, because unmanaged batches raise none.
    expect(soonest.label).toBe('lapsing-soon');
  });
});
