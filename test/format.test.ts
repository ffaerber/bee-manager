/**
 * These formatters are shared by the batch row and the batch page, so a
 * disagreement between them would look like opening a batch changed its state.
 */
import { describe, expect, it } from 'bun:test';
import { expiryDate, fmtBytes, fmtDays, ttlSeverity } from '../web/src/format';

describe('ttlSeverity', () => {
  it('is critical once a batch is out of time', () => {
    expect(ttlSeverity(0, 14)).toBe('critical');
    expect(ttlSeverity(-3, 14)).toBe('critical');
  });

  it('warns below the configured threshold, not at some other number', () => {
    expect(ttlSeverity(13.9, 14)).toBe('warning');
    expect(ttlSeverity(14, 14)).toBe('good');
    // Following the configured value is the point: a hardcoded 14 here would
    // silently disagree with the daemon after a config change.
    expect(ttlSeverity(20, 30)).toBe('warning');
  });
});

describe('fmtDays', () => {
  it('switches to years past a year, so 400d does not read as noise', () => {
    expect(fmtDays(400)).toBe('1.1 yr');
    expect(fmtDays(364)).toBe('364 d');
  });

  it('keeps a decimal only where it matters', () => {
    expect(fmtDays(9.4)).toBe('9.4 d');
    expect(fmtDays(57.4)).toBe('57 d');
  });

  it('shows an unbounded runway as infinite rather than NaN', () => {
    expect(fmtDays(Infinity)).toBe('∞');
  });
});

describe('fmtBytes', () => {
  it('formats the sizes this dashboard actually shows', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(115 * 4096)).toBe('471 KB');       // the real t4t figure
    expect(fmtBytes(Math.pow(2, 24) * 4096)).toBe('68.7 GB');
  });
});

describe('expiryDate', () => {
  it('projects forward from the remaining life', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(expiryDate(30, now)).toContain('2026');
  });

  it('says expired rather than printing a past date', () => {
    expect(expiryDate(0)).toBe('expired');
    expect(expiryDate(-5)).toBe('expired');
  });
});
