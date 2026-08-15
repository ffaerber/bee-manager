/**
 * The hero runway ticks at 1 Hz, so its formatter runs 86,400 times a day in
 * every open tab. These pin the two things that would be visible immediately
 * if they were wrong: the digits never jitter in width, and the count never
 * rounds a day UP.
 */

import { describe, expect, it } from 'bun:test';
import { countdown, runwayRemainingMs } from '../web/src/format';

const D = 86_400_000, H = 3_600_000, M = 60_000, S = 1_000;

describe('countdown', () => {
  it('splits into whole days and a zero-padded clock', () => {
    expect(countdown(62 * D + 14 * H + 23 * M + 7 * S)).toEqual({ days: 62, clock: '14:23:07', done: false });
    expect(countdown(D)).toEqual({ days: 1, clock: '00:00:00', done: false });
    expect(countdown(9 * H + 5 * M + 3 * S)).toEqual({ days: 0, clock: '09:05:03', done: false });
  });

  it('always renders eight clock characters, so the line cannot jitter', () => {
    for (const ms of [0, S, 59 * S, M, 59 * M + 59 * S, H, 23 * H, D - S, 400 * D + 1234]) {
      expect(countdown(ms).clock).toMatch(/^\d\d:\d\d:\d\d$/);
    }
  });

  it('truncates rather than rounds, so it never claims a day that has not elapsed', () => {
    // 2 d 23 h 59 m 59 s must read as 2 days, not 3.
    expect(countdown(3 * D - S).days).toBe(2);
    expect(countdown(3 * D - S).clock).toBe('23:59:59');
  });

  it('clamps at zero rather than counting negative', () => {
    expect(countdown(0)).toEqual({ days: 0, clock: '00:00:00', done: true });
    expect(countdown(-5 * D)).toEqual({ days: 0, clock: '00:00:00', done: true });
  });

  it('reports an infinite runway as having no clock to run', () => {
    const r = countdown(Infinity);
    expect(r.days).toBe(Infinity);
    expect(r.clock).toBe('');
  });

  it('counts down monotonically across a day boundary', () => {
    const at = 3 * D + 500;
    const a = countdown(at), b = countdown(at - S), c = countdown(at - 600);
    expect(a.days).toBe(3); expect(a.clock).toBe('00:00:00');
    expect(b.days).toBe(2); expect(b.clock).toBe('23:59:59');
    expect(c.days).toBe(2); expect(c.clock).toBe('23:59:59');
  });
});

describe('runwayRemainingMs', () => {
  const D = 86_400_000;

  it('subtracts both the snapshot age and the time since it arrived', () => {
    // Server said 10 days, the poll was 2 minutes ago, this tab has held the
    // response for 30 s: 10 d minus 2.5 minutes.
    expect(runwayRemainingMs(10, 120_000, 30_000)).toBe(10 * D - 150_000);
  });

  it('does not jump when a fresh poll replaces a stale one', () => {
    // A poll interval of 5 min. Just before the new poll the tab is showing a
    // figure that is 5 min old and has been held 5 min... no: held 5 min since
    // fetch, and was 0 ms old at fetch.
    const before = runwayRemainingMs(10, 0, 300_000);
    // The new poll reports a runway 5 min shorter, freshly computed.
    const after = runwayRemainingMs(10 - 300_000 / D, 0, 0);
    expect(Math.abs(before - after)).toBeLessThan(2);
  });

  it('is continuous when the response itself arrives stale', () => {
    // Fetching 4 min into a 5 min poll cycle must not show 4 min more than the
    // truth — which is exactly what dropping ageMs would do.
    const honest = runwayRemainingMs(10, 240_000, 0);
    const naive = 10 * D;
    expect(naive - honest).toBe(240_000);
  });

  it('stays infinite when nothing is burning', () => {
    expect(runwayRemainingMs(Infinity, 5_000, 1_000)).toBe(Infinity);
  });
});
