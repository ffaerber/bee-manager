/**
 * Per-batch policy overrides.
 *
 * The design rule under test: null means "inherit the global", never "a frozen
 * copy of whatever the global was when this batch was first seen". Copying
 * would mean changing the service default silently stopped reaching existing
 * batches — the opposite of what a default is for.
 */
import { describe, expect, it } from 'bun:test';
import { Db } from '../src/db';
import { policyFor } from '../src/evaluate';
import { loadConfig } from '../src/config';

const ID = 'aa'.repeat(32);
const cfg = loadConfig({
  BEE_URL: 'http://bee:1633',
  TOPUP_WHEN_TTL_BELOW_DAYS: '2',
  TOPUP_TARGET_TTL_DAYS: '60',
  DILUTE_WHEN_UTILIZATION_ABOVE: '0.9',
  MAX_AUTO_DILUTE_DEPTH: '22',
} as any);

describe('policyFor', () => {
  it('falls back to the globals when nothing is set', () => {
    const p = policyFor(cfg, null);
    expect(p.topupWhenTtlBelowSec / 86_400).toBe(2);
    expect(p.topupTargetTtlSec / 86_400).toBe(60);
    expect(p.diluteWhenUtilizationAbove).toBe(0.9);
    expect(p.maxAutoDiluteDepth).toBe(22);
  });

  it('lets a batch override one field without disturbing the rest', () => {
    const p = policyFor(cfg, {
      topupTargetDays: 180, topupBelowDays: null, diluteAbove: null, maxDiluteDepth: null,
    });
    expect(p.topupTargetTtlSec / 86_400).toBe(180);
    expect(p.topupWhenTtlBelowSec / 86_400).toBe(2);   // still the global
    expect(p.diluteWhenUtilizationAbove).toBe(0.9);
  });

  it('can pin a batch against automatic dilution entirely', () => {
    // maxDiluteDepth at the batch's own depth stops it dead — the way to say
    // "this one is the right size, leave it alone".
    const p = policyFor(cfg, {
      maxDiluteDepth: 18, topupBelowDays: null, topupTargetDays: null, diluteAbove: null,
    });
    expect(p.maxAutoDiluteDepth).toBe(18);
  });
});

describe('storage', () => {
  it('round-trips overrides and distinguishes null from unset', () => {
    const db = new Db(':memory:');
    db.seenBatch(ID, 'x', 18, false);
    expect(db.batch(ID)!.topupTargetDays).toBeNull();

    db.setBatchPolicy(ID, { topupTargetDays: 90 });
    expect(db.batch(ID)!.topupTargetDays).toBe(90);

    // Omitting a key must not disturb it.
    db.setBatchPolicy(ID, { diluteAbove: 0.75 });
    expect(db.batch(ID)!.topupTargetDays).toBe(90);
    expect(db.batch(ID)!.diluteAbove).toBe(0.75);

    // Explicit null clears it, returning the batch to the global.
    db.setBatchPolicy(ID, { topupTargetDays: null });
    expect(db.batch(ID)!.topupTargetDays).toBeNull();
    expect(db.batch(ID)!.diluteAbove).toBe(0.75);
    db.close();
  });

  it('leaves other batches untouched', () => {
    const db = new Db(':memory:');
    const OTHER = 'bb'.repeat(32);
    db.seenBatch(ID, 'a', 18, false);
    db.seenBatch(OTHER, 'b', 18, false);
    db.setBatchPolicy(ID, { topupTargetDays: 90 });
    expect(db.batch(OTHER)!.topupTargetDays).toBeNull();
    db.close();
  });

  it('survives a re-poll, which rewrites label/depth', () => {
    // seenBatch runs every cycle; it must not wipe the policy.
    const db = new Db(':memory:');
    db.seenBatch(ID, 'x', 18, false);
    db.setBatchPolicy(ID, { topupTargetDays: 90, maxDiluteDepth: 19 });
    db.seenBatch(ID, 'x-renamed', 19, false);
    const r = db.batch(ID)!;
    expect(r.topupTargetDays).toBe(90);
    expect(r.maxDiluteDepth).toBe(19);
    expect(r.label).toBe('x-renamed');
    db.close();
  });
});
