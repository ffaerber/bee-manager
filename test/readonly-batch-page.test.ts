/**
 * The batch page must render for a visitor who is told no policy.
 *
 * statePublic() strips `effective` from every batch — it describes what the
 * node will do unattended, which is not public. BatchDetail read
 * `b.effective.topupWhenTtlBelowSec` regardless, so the first synchronous
 * render threw and React never mounted: a deep link to /batch/<id> produced a
 * blank page for anonymous visitors while working perfectly when signed in.
 *
 * The type is now optional, so the compiler enforces every reader. These pin
 * the behaviour the types cannot express.
 */
import { describe, it, expect } from 'bun:test';
import { ttlSeverity } from '../web/src/format';

describe('severity without a threshold', () => {
  it('reports expiry as critical even with no policy to compare against', () => {
    // True about the batch, not about anyone's settings.
    expect(ttlSeverity(0, null)).toBe('critical');
    expect(ttlSeverity(-1, null)).toBe('critical');
  });

  it('does not invent a warning when the threshold is unknown', () => {
    // A read-only viewer has not been told what "low" means here, and guessing
    // would show them an alarm belonging to someone else's configuration.
    expect(ttlSeverity(3, null)).toBe('good');
    expect(ttlSeverity(90, null)).toBe('good');
  });

  it('still warns below a threshold when one is known', () => {
    expect(ttlSeverity(3, 14)).toBe('warning');
    expect(ttlSeverity(30, 14)).toBe('good');
  });
});

describe('the public projection is what the page must survive', () => {
  /** Mirrors statePublic(): plans, config and per-batch policy removed. */
  const publicBatch = {
    batchID: 'a'.repeat(64), label: 'site', depth: 20, batchTTL: 2419200,
    ttlDays: 28, utilizationRatio: 1, usable: true, immutableFlag: false,
    storedHuman: '0.58 MB', capacityHuman: '4.29 GB', managed: true,
  } as any;

  it('has no effective block', () => {
    expect(publicBatch.effective).toBeUndefined();
  });

  it('yields a usable severity anyway', () => {
    const threshold = publicBatch.effective
      ? publicBatch.effective.topupWhenTtlBelowSec / 86_400
      : null;
    expect(threshold).toBeNull();
    expect(() => ttlSeverity(publicBatch.ttlDays, threshold)).not.toThrow();
    expect(ttlSeverity(publicBatch.ttlDays, threshold)).toBe('good');
  });
})

/**
 * A missing number must read as missing, never as a corrupt one.
 *
 * The public tier omits several byte fields (maxUploadBytes, freeChunks). An
 * unguarded fmtBytes rendered "NaN undefined" on the live batch page — the
 * same shape as the effective/topupWhenTtlBelowSec crash: a tier drops a
 * field and a reader assumes it is there.
 */
import { fmtBytes } from '../web/src/format';

describe('formatting an absent byte count', () => {
  it('renders an em dash rather than NaN', () => {
    expect(fmtBytes(undefined)).toBe('—');
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes(NaN)).toBe('—');
  });

  it('still formats real figures', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(577536)).toBe('578 KB');
    expect(fmtBytes(4294967296)).toBe('4.29 GB');
  });
})
