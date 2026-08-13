/**
 * A rename has to be visible immediately.
 *
 * /state serves labels from the last poll, not from the database, so renaming
 * a batch updated the node and the db while the dashboard kept showing the old
 * name until the next cycle — POLL_INTERVAL_MS, five minutes by default. Every
 * layer reported success and the screen disagreed, which reads as "renaming
 * does not work".
 */
import { describe, expect, it } from 'bun:test';
import { Poller } from '../src/poller';
import type { Batch } from '../src/bee';

function batch(id: string, label: string): Batch {
  return {
    batchID: id, label, depth: 24, amount: 1n, bucketDepth: 16, blockNumber: 1,
    immutableFlag: false, exists: true, usable: true, batchTTL: 100_000,
    utilization: 0, utilizationRatio: 0,
  };
}

/** A poller with a cached result, without running a real poll. */
function withCache(batches: Batch[]): Poller {
  const p = Object.create(Poller.prototype) as Poller;
  (p as any).last = {
    ok: true, batches, plans: [], msPerBlock: 5000,
    burnPer30DaysBzz: 0, runwayDays: 0,
  };
  return p;
}

describe('patchCachedLabel', () => {
  it('corrects the cache the dashboard reads', () => {
    const p = withCache([batch('aa', 'old'), batch('bb', 'other')]);
    p.patchCachedLabel('aa', 'new');
    expect(p.last!.batches.find((b) => b.batchID === 'aa')!.label).toBe('new');
  });

  it('leaves other batches alone', () => {
    const p = withCache([batch('aa', 'old'), batch('bb', 'other')]);
    p.patchCachedLabel('aa', 'new');
    expect(p.last!.batches.find((b) => b.batchID === 'bb')!.label).toBe('other');
  });

  it('ignores an unknown batch rather than throwing', () => {
    const p = withCache([batch('aa', 'old')]);
    expect(() => p.patchCachedLabel('zz', 'x')).not.toThrow();
  });

  it('is safe before the first poll', () => {
    const p = Object.create(Poller.prototype) as Poller;
    (p as any).last = null;
    expect(() => p.patchCachedLabel('aa', 'x')).not.toThrow();
  });

  it('does not disturb anything else in the cached result', () => {
    // The narrowness is the point: a rename must not be able to trigger the
    // evaluate/top-up pass, which a full re-poll would.
    const p = withCache([batch('aa', 'old')]);
    const before = { ...p.last! };
    p.patchCachedLabel('aa', 'new');
    expect(p.last!.plans).toBe(before.plans);
    expect(p.last!.runwayDays).toBe(before.runwayDays);
    expect(p.last!.ok).toBe(before.ok);
  });
});
