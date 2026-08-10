import { describe, it, expect, beforeEach } from 'bun:test';
import { Db } from '../src/db';
import { bzzToPlur } from '../src/math';

let db: Db;
beforeEach(() => { db = new Db(':memory:'); });

describe('batch tracking', () => {
  it('remembers a batch so a later disappearance is detectable', () => {
    db.seenBatch('a', 't4t', 24, false);
    expect(db.liveKnownBatchIds()).toEqual(['a']);
  });

  it('marks a vanished batch exactly once, so the alert does not repeat', () => {
    db.seenBatch('a', 't4t', 24, false);
    expect(db.markGone('a')).toBe(true);
    expect(db.markGone('a')).toBe(false);
    expect(db.liveKnownBatchIds()).toEqual([]);
  });

  it('un-marks a batch that reappears', () => {
    db.seenBatch('a', 't4t', 24, false);
    db.markGone('a');
    db.seenBatch('a', 't4t', 24, false);
    expect(db.liveKnownBatchIds()).toEqual(['a']);
  });
});

describe('snapshots', () => {
  it('round-trips bigint amounts without precision loss', () => {
    const amount = 70_820_179_200n;
    const price = 70_638n;
    db.recordSnapshot('a', 2_972_090, amount, 24, 0.0039, price);
    const [s] = db.snapshots('a');
    expect(s.amount).toBe(amount);
    expect(s.price).toBe(price);
  });

  it('survives values beyond Number.MAX_SAFE_INTEGER', () => {
    // The live wallet balance: 204.48 BZZ. As a JS Number this becomes
    // 2044839309272645632 — off by 35 PLUR — which is exactly why amounts are
    // stored as TEXT and never round-tripped through Number.
    const huge = 2_044_839_309_272_645_597n;
    db.recordSnapshot('a', 1, huge, 24, 0, huge);
    expect(db.snapshots('a')[0].amount).toBe(huge);
    expect(BigInt(Number(huge))).not.toBe(huge);
  });

  it('prunes old snapshots but keeps recent ones', () => {
    const now = Date.now();
    db.recordSnapshot('a', 1, 1n, 24, 0, 1n, now - 100 * 86_400_000);
    db.recordSnapshot('a', 1, 2n, 24, 0, 1n, now);
    db.pruneSnapshots(90, now);
    expect(db.snapshots('a')).toHaveLength(1);
  });
});

describe('spend ledger', () => {
  const action = (over: any = {}) => db.recordAction({
    batchId: 'a', appName: null, kind: 'topup', amount: 1n,
    cost: bzzToPlur('10'), status: 'confirmed', reason: '', error: null, ...over,
  });

  it('counts confirmed and submitted spends toward the daily total', () => {
    action({ status: 'confirmed' });
    action({ status: 'submitted' });
    expect(db.spentLast24h()).toBe(bzzToPlur('20'));
  });

  it('excludes blocked and dry-run actions — they never moved money', () => {
    action({ status: 'blocked' });
    action({ status: 'dry-run' });
    action({ status: 'failed' });
    expect(db.spentLast24h()).toBe(0n);
  });

  it('ignores spends older than 24h', () => {
    const now = Date.now();
    action({ ts: now - 25 * 3_600_000 });
    expect(db.spentLast24h(now)).toBe(0n);
  });

  it('sums beyond 64-bit-lossy territory correctly', () => {
    for (let i = 0; i < 20; i++) action({ cost: 1_036_215_198_676_942_848n });
    expect(db.spentLast24h()).toBe(20n * 1_036_215_198_676_942_848n);
  });

  it('scopes spend to an app when asked', () => {
    action({ appName: 'pinkchainsaw' });
    action({ appName: 'other' });
    expect(db.spentLast24h(Date.now(), 'pinkchainsaw')).toBe(bzzToPlur('10'));
  });

  it('tracks in-flight batches and clears them on confirmation', () => {
    const id = action({ status: 'submitted' });
    expect(db.inFlightBatchIds().has('a')).toBe(true);
    db.updateActionStatus(id, 'confirmed');
    expect(db.inFlightBatchIds().has('a')).toBe(false);
  });
});

describe('apps registry', () => {
  const app = {
    name: 'pinkchainsaw', policy: 'ephemeral' as const, depth: 17, durationDays: 10,
    batchId: null, budgetPlurPerDay: bzzToPlur('2'), ensName: 'pinkchainsaw.eth', apiKeyHash: 'h',
  };

  it('stores and reads back an app with exact bigint budget', () => {
    db.upsertApp(app);
    expect(db.app('pinkchainsaw')!.budgetPlurPerDay).toBe(bzzToPlur('2'));
    expect(db.app('pinkchainsaw')!.policy).toBe('ephemeral');
  });

  it('does not wipe an assigned batch on a config-only update', () => {
    db.upsertApp(app);
    db.setAppBatch('pinkchainsaw', 'batch-1');
    db.upsertApp({ ...app, depth: 18 });
    expect(db.app('pinkchainsaw')!.batchId).toBe('batch-1');
    expect(db.app('pinkchainsaw')!.depth).toBe(18);
  });

  it('records the last deployed reference', () => {
    db.upsertApp(app);
    db.setAppReference('pinkchainsaw', 'ref123');
    expect(db.app('pinkchainsaw')!.lastReference).toBe('ref123');
  });

  it('returns null for an unknown app rather than throwing', () => {
    expect(db.app('nope')).toBeNull();
  });
});

describe('alert dedup', () => {
  it('suppresses a repeat inside the cooldown', () => {
    expect(db.shouldAlert('k', 3_600_000)).toBe(true);
    expect(db.shouldAlert('k', 3_600_000)).toBe(false);
  });

  it('allows it again once the cooldown lapses', () => {
    const now = Date.now();
    db.shouldAlert('k', 3_600_000, now);
    expect(db.shouldAlert('k', 3_600_000, now + 3_600_001)).toBe(true);
  });

  it('clearing lets the next occurrence through immediately', () => {
    db.shouldAlert('k', 3_600_000);
    db.clearAlert('k');
    expect(db.shouldAlert('k', 3_600_000)).toBe(true);
  });

  it('keys are independent', () => {
    db.shouldAlert('a', 3_600_000);
    expect(db.shouldAlert('b', 3_600_000)).toBe(true);
  });
});

describe('unmanaged batches', () => {
  it('treats every batch as managed by default', () => {
    db.seenBatch('a', 'site', 17, false);
    expect(db.isManaged('a')).toBe(true);
    expect(db.unmanagedBatchIds().size).toBe(0);
  });

  it('excludes a batch from management and back again', () => {
    db.seenBatch('a', 'tmp-share', 17, false);
    expect(db.setManaged('a', false)).toBe(true);
    expect(db.isManaged('a')).toBe(false);
    expect(db.unmanagedBatchIds().has('a')).toBe(true);
    db.setManaged('a', true);
    expect(db.isManaged('a')).toBe(true);
  });

  it('reports a batch it has never seen rather than silently succeeding', () => {
    expect(db.setManaged('nope', false)).toBe(false);
  });

  it('defaults an unknown batch to managed — never silently stop maintaining one', () => {
    expect(db.isManaged('never-seen')).toBe(true);
  });

  it('keeps the flag across a re-sighting, so a poll does not undo the opt-out', () => {
    db.seenBatch('a', 'tmp-share', 17, false);
    db.setManaged('a', false);
    db.seenBatch('a', 'tmp-share', 17, false); // next poll
    expect(db.isManaged('a')).toBe(false);
  });

  it('lists batches with their managed state', () => {
    db.seenBatch('a', 'site', 17, false);
    db.seenBatch('b', 'tmp-share', 17, false);
    db.setManaged('b', false);
    const rows = db.batches();
    expect(rows.find((r) => r.batchId === 'a')!.managed).toBe(true);
    expect(rows.find((r) => r.batchId === 'b')!.managed).toBe(false);
  });
});
