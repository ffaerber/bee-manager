/**
 * The in-flight lock must expire.
 *
 * `submitted` is written before the Bee call and cleared after it, so it is
 * both the crash-safety record and the lock that stops a duplicate spend. A
 * composite dilute-then-top-up that half-succeeded used to strand one forever,
 * and because inFlightBatchIds() reads exactly this status, the batch was
 * locked out of the planner permanently — observed on a live batch, which sat
 * unrenewable for six hours with 24 days of life left.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { Db } from '../src/db';

const HOUR = 3_600_000;
let db: Db;
const now = Date.now();

const submitted = (batchId: string, ageMs: number) =>
  db.recordAction({
    batchId, appName: null, kind: 'dilute', amount: 1n, cost: 1n,
    status: 'submitted', reason: 'test', error: null, ts: now - ageMs,
  });

beforeEach(() => { db = new Db(':memory:'); });

describe('staleSubmitted', () => {
  it('finds only rows past the bound', () => {
    submitted('aaa', 2 * HOUR);
    submitted('bbb', 5 * 60_000);            // 5 min — genuinely in flight
    const stale = db.staleSubmitted(30 * 60_000, now);
    expect(stale.length).toBe(1);
    expect(stale[0].batch_id).toBe('aaa');
  });

  it('ignores rows that already resolved', () => {
    const id = submitted('ccc', 2 * HOUR);
    db.updateActionStatus(id, 'confirmed');
    expect(db.staleSubmitted(30 * 60_000, now).length).toBe(0);
  });

  it('a fresh submission still locks its batch', () => {
    submitted('ddd', 60_000);
    expect(db.inFlightBatchIds().has('ddd')).toBe(true);
    expect(db.staleSubmitted(30 * 60_000, now).length).toBe(0);
  });
});

describe('releasing a stale row unlocks the batch', () => {
  it('is what lets the planner act again', () => {
    const id = submitted('eee', 6 * HOUR);
    expect(db.inFlightBatchIds().has('eee')).toBe(true);   // the bug: locked

    for (const a of db.staleSubmitted(30 * 60_000, now)) {
      db.updateActionStatus(a.id, 'failed', 'never confirmed');
    }

    expect(db.inFlightBatchIds().has('eee')).toBe(false);  // released
    // Kept in the ledger, not deleted — it is the audit trail for money.
    const row = db.recentActions(10).find((r) => r.id === id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('never confirmed');
  });
});
