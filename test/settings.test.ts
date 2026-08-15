/**
 * Runtime settings, with the database as the source of truth.
 *
 * The environment seeds these once and is ignored afterwards. An earlier
 * version layered dashboard overrides over the environment and treated the env
 * value as a hard ceiling for spend caps — safer on paper, confusing in
 * practice, because every setting showed three numbers and you had to work out
 * which was real.
 *
 * The ceiling is replaced by a confirmation: loosening a guard needs a second,
 * explicit step. These tests pin that a loosening change is caught and a
 * tightening one is not, because friction in the cautious direction is how
 * people learn to click through warnings.
 */
import { describe, expect, it } from 'bun:test';
import { Db } from '../src/db';
import { loadConfig } from '../src/config';
import { applySettings, envValue, isLoosening, riskOf, seedSettings, EDITABLE } from '../src/settings';
import { plurToBzz } from '../src/math';

const env = {
  BEE_URL: 'http://bee:1633',
  MAX_TOPUP_BZZ_PER_BATCH: '5',
  MAX_TOPUP_BZZ_PER_DAY: '15',
  MIN_WALLET_BZZ: '20',
  TOPUP_WHEN_TTL_BELOW_DAYS: '2',
  TOPUP_TARGET_TTL_DAYS: '60',
} as any;
const cfg = loadConfig(env);

describe('seeding', () => {
  it('copies the environment in on first run', () => {
    const db = new Db(':memory:');
    const seeded = seedSettings(db, cfg);
    expect(seeded).toContain('maxTopupBzzPerBatch');
    expect(db.settings().maxTopupBzzPerBatch).toBe('5');
    db.close();
  });

  it('is a no-op afterwards, so compose changes stop mattering', () => {
    const db = new Db(':memory:');
    seedSettings(db, cfg);
    db.setSetting('maxTopupBzzPerBatch', '2');

    // A later deploy raises the env values; the stored one must win. Both caps
    // move together because loadConfig refuses a per-action cap above the daily.
    const raised = loadConfig({ ...env, MAX_TOPUP_BZZ_PER_BATCH: '999', MAX_TOPUP_BZZ_PER_DAY: '999' } as any);
    expect(seedSettings(db, raised)).toEqual([]);
    expect(plurToBzz(applySettings(raised, db.settings()).maxTopupPlurPerBatch)).toBe(2);
    db.close();
  });

  it('seeds every editable key that has an environment value', () => {
    const db = new Db(':memory:');
    seedSettings(db, cfg);
    const stored = db.settings();
    for (const spec of EDITABLE) {
      if (envValue(cfg, spec.key) === null) continue;
      expect(stored).toHaveProperty(spec.key);
    }
    db.close();
  });
});

describe('the database is authoritative', () => {
  it('applies a value the environment would once have refused', () => {
    // The old model clamped this to the env ceiling of 5. Both caps move
    // together, since a per-action cap above the daily one is incoherent.
    const out = applySettings(cfg, { maxTopupBzzPerBatch: '500', maxTopupBzzPerDay: '500' });
    expect(plurToBzz(out.maxTopupPlurPerBatch)).toBe(500);
  });

  it('still ignores an unparseable value rather than zeroing a cap', () => {
    expect(plurToBzz(applySettings(cfg, { maxTopupBzzPerBatch: 'nonsense' }).maxTopupPlurPerBatch)).toBe(5);
  });

  it('never stores a per-action cap above the daily cap', () => {
    // The first action would exhaust the day, so the pairing is meaningless.
    // loadConfig refuses it in the environment; the same has to hold here now
    // that the dashboard can set either independently.
    const out = applySettings(cfg, { maxTopupBzzPerBatch: '900', maxTopupBzzPerDay: '100' });
    expect(plurToBzz(out.maxTopupPlurPerBatch)).toBe(100);
    expect(plurToBzz(out.maxTopupPlurPerDay)).toBe(100);
  });

  it('rejects a target at or below the trigger, which would spend every cycle', () => {
    const out = applySettings(cfg, { topupWhenTtlBelowDays: '90', topupTargetTtlDays: '30' });
    expect(out.topupWhenTtlBelowSec / 86_400).toBe(2);
    expect(out.topupTargetTtlSec / 86_400).toBe(60);
  });
});

describe('loosening needs confirmation, tightening does not', () => {
  it('flags raising a spend cap', () => {
    expect(isLoosening('maxTopupBzzPerBatch', 5, 50)).toBe(true);
    expect(isLoosening('maxTopupBzzPerDay', 15, 100)).toBe(true);
  });

  it('does not flag lowering one', () => {
    expect(isLoosening('maxTopupBzzPerBatch', 5, 2)).toBe(false);
  });

  it('inverts for protective floors', () => {
    // Lower floor = weaker guard.
    expect(isLoosening('minWalletBzz', 20, 1)).toBe(true);
    expect(isLoosening('minWalletBzz', 20, 50)).toBe(false);
    expect(isLoosening('minWalletXdai', 0.5, 0.1)).toBe(true);
  });

  it('flags raising the automatic dilution ceiling', () => {
    // Irreversible and doubles every future top-up per step.
    expect(isLoosening('maxAutoDiluteDepth', 22, 26)).toBe(true);
    expect(isLoosening('maxAutoDiluteDepth', 22, 19)).toBe(false);
  });

  it('leaves settings that guard nothing alone in both directions', () => {
    for (const k of ['topupTargetTtlDays', 'walletLowRunwayDays', 'diluteWhenUtilizationAbove']) {
      expect(isLoosening(k, 10, 1000)).toBe(false);
      expect(isLoosening(k, 1000, 10)).toBe(false);
    }
  });

  it('has a stated risk for every guarded setting', () => {
    // A confirmation with nothing to read is just an extra click.
    for (const spec of EDITABLE) {
      if (spec.looserWhen) expect(riskOf(spec.key)).toBeTruthy();
    }
  });
});

/**
 * Percent settings are stored as a fraction and shown as 0-100.
 *
 * utilizationRatio is a fraction, and evaluate() compares against it directly,
 * so the stored form has to stay a fraction. "0.9 of 1.0" is simply not how
 * anyone reads a threshold, so the conversion lives at the API boundary and
 * the dashboard never sees a fraction.
 */
describe('percent settings', () => {
  const spec = EDITABLE.find((s) => s.key === 'diluteWhenUtilizationAbove')!;

  it('is declared in display units', () => {
    expect(spec.kind).toBe('percent');
    expect(spec.min).toBe(10);
    expect(spec.max).toBe(100);
  });

  it('round-trips a fraction through the display form', () => {
    for (const pct of [10, 55, 75, 90, 100]) {
      const stored = pct / 100;
      expect(applySettings(cfg, { diluteWhenUtilizationAbove: String(stored) })
        .diluteWhenUtilizationAbove).toBeCloseTo(stored, 6);
      expect(Math.round(stored * 100)).toBe(pct);
    }
  });

  it('keeps the stored value comparable with utilizationRatio', () => {
    // The whole reason storage stays fractional: this is compared directly
    // against a bucket's fill ratio, which is 0-1.
    const out = applySettings(cfg, { diluteWhenUtilizationAbove: '0.75' });
    expect(out.diluteWhenUtilizationAbove).toBeLessThanOrEqual(1);
    expect(out.diluteWhenUtilizationAbove).toBe(0.75);
  });
});
