/**
 * Runtime settings, and the one property that makes them safe to expose.
 *
 * The dashboard may LOWER a spend cap freely and raise it only as far as the
 * environment allows. Without that the caps are advisory: anything holding the
 * admin token could raise the per-action cap and then spend to it, and the
 * guardrail bounding an automated refiller aimed at a live wallet would last
 * only until something clicked otherwise.
 *
 * The protective floors invert it — raisable, never lowerable — because higher
 * is the cautious direction.
 */
import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config';
import { applySettings, clampToEnv, envValue } from '../src/settings';
import { plurToBzz } from '../src/math';

const env = {
  BEE_URL: 'http://bee:1633',
  MAX_TOPUP_BZZ_PER_BATCH: '5',
  MAX_TOPUP_BZZ_PER_DAY: '15',
  MIN_WALLET_BZZ: '20',
  MIN_WALLET_XDAI: '0.5',
  TOPUP_WHEN_TTL_BELOW_DAYS: '2',
  TOPUP_TARGET_TTL_DAYS: '60',
  MAX_AUTO_DILUTE_DEPTH: '22',
} as any;
const cfg = loadConfig(env);

describe('spend caps cannot be raised past the environment', () => {
  it('refuses to raise the per-action cap', () => {
    const out = applySettings(cfg, { maxTopupBzzPerBatch: '500' });
    expect(plurToBzz(out.maxTopupPlurPerBatch)).toBe(5);
  });

  it('refuses to raise the daily cap', () => {
    const out = applySettings(cfg, { maxTopupBzzPerDay: '9999' });
    expect(plurToBzz(out.maxTopupPlurPerDay)).toBe(15);
  });

  it('allows lowering, which is always the safe direction', () => {
    const out = applySettings(cfg, { maxTopupBzzPerBatch: '2', maxTopupBzzPerDay: '4' });
    expect(plurToBzz(out.maxTopupPlurPerBatch)).toBe(2);
    expect(plurToBzz(out.maxTopupPlurPerDay)).toBe(4);
  });

  it('reports the clamp rather than silently applying a different number', () => {
    // The dashboard has to be able to say "your 500 became 5".
    expect(clampToEnv(cfg, 'maxTopupBzzPerBatch', 500)).toEqual({ value: 5, clamped: true });
    expect(clampToEnv(cfg, 'maxTopupBzzPerBatch', 3)).toEqual({ value: 3, clamped: false });
  });

  it('caps the automatic dilution depth the same way', () => {
    expect(applySettings(cfg, { maxAutoDiluteDepth: '30' }).maxAutoDiluteDepth).toBe(22);
    expect(applySettings(cfg, { maxAutoDiluteDepth: '19' }).maxAutoDiluteDepth).toBe(19);
  });
});

describe('protective floors can only be raised', () => {
  it('refuses to lower the wallet floor', () => {
    expect(plurToBzz(applySettings(cfg, { minWalletBzz: '1' }).minWalletPlur)).toBe(20);
  });

  it('allows raising it', () => {
    expect(plurToBzz(applySettings(cfg, { minWalletBzz: '50' }).minWalletPlur)).toBe(50);
  });

  it('refuses to lower the gas floor', () => {
    const out = applySettings(cfg, { minWalletXdai: '0.01' });
    expect(Number(out.minWalletXdaiWei) / 1e18).toBeCloseTo(0.5, 6);
  });
});

describe('non-spending settings are free', () => {
  it('moves thresholds either way', () => {
    const out = applySettings(cfg, { topupWhenTtlBelowDays: '21', topupTargetTtlDays: '120' });
    expect(out.topupWhenTtlBelowSec / 86_400).toBe(21);
    expect(out.topupTargetTtlSec / 86_400).toBe(120);
  });

  it('can disarm auto top-up and re-arm dry run', () => {
    const out = applySettings(cfg, { autoTopupEnabled: 'false', dryRun: 'true' });
    expect(out.autoTopupEnabled).toBe(false);
    expect(out.dryRun).toBe(true);
  });

  it('sets the webhook, which the environment leaves unset', () => {
    expect(applySettings(cfg, { webhookUrl: 'https://ntfy.sh/x' }).webhookUrl).toBe('https://ntfy.sh/x');
    expect(applySettings(cfg, { webhookUrl: '  ' }).webhookUrl).toBeNull();
  });
});

describe('coherence', () => {
  it('rejects a target at or below the trigger, which would spend every cycle', () => {
    const out = applySettings(cfg, { topupWhenTtlBelowDays: '90', topupTargetTtlDays: '30' });
    // Falls back to the environment pair rather than accepting a combination
    // that re-fires forever.
    expect(out.topupWhenTtlBelowSec / 86_400).toBe(2);
    expect(out.topupTargetTtlSec / 86_400).toBe(60);
  });

  it('is a no-op with nothing stored', () => {
    const out = applySettings(cfg, {});
    expect(out).toEqual(cfg);
  });

  it('ignores unparseable values instead of zeroing a cap', () => {
    const out = applySettings(cfg, { maxTopupBzzPerBatch: 'not-a-number' });
    expect(plurToBzz(out.maxTopupPlurPerBatch)).toBe(5);
  });

  it('reports the environment value for display', () => {
    expect(envValue(cfg, 'maxTopupBzzPerBatch')).toBe(5);
    expect(envValue(cfg, 'topupTargetTtlDays')).toBe(60);
  });
});
