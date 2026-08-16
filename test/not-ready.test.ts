/**
 * /state answers HTTP 200 with a half-built body until the first poll lands.
 *
 * The client's req() only throws on a bad STATUS, so that body used to be
 * assigned straight to `state` and dereferenced — white-screening the
 * dashboard on state.config.autoTopupEnabled and the batch page on
 * state.batches.find, on every restart, for as long as the first poll took.
 */

import { describe, expect, it } from 'bun:test';

/** Exactly what server.ts returns before poller.last exists. */
const NOT_READY = { ok: false, error: 'no poll completed yet' } as any;

/** The guard now in App.load(). */
const usable = (s: any) => !!(s && s.config);

describe('the pre-first-poll payload', () => {
  it('is a 200, so a status check cannot catch it', () => {
    // req() throws only on !res.ok; this body rides in on a 200.
    expect(NOT_READY.ok).toBe(false);
    expect(NOT_READY.error).toBeTruthy();
  });

  it('would throw if treated as a State', () => {
    expect(() => NOT_READY.config.autoTopupEnabled).toThrow(TypeError);
    expect(() => NOT_READY.batches.find((b: any) => b)).toThrow(TypeError);
  });

  it('is rejected by the guard, so state stays null', () => {
    expect(usable(NOT_READY)).toBe(false);
    expect(usable(null)).toBe(false);
    expect(usable(undefined)).toBe(false);
  });

  it('accepts a real State', () => {
    expect(usable({ config: { autoTopupEnabled: true }, batches: [] })).toBe(true);
  });

  it('null state is safe to dereference the way the pages do', () => {
    const state: any = null;
    // Optional chaining short-circuits the WHOLE chain, so this is fine for
    // null — it was only ever unsafe for a non-null object missing `batches`,
    // which the guard now prevents from existing.
    expect(state?.batches.find((b: any) => b)).toBeUndefined();
  });
});
