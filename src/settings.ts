/**
 * Runtime settings: the environment, with dashboard overrides layered on top.
 *
 * ── The rule that makes this safe ──
 *
 * The dashboard may LOWER a spend cap freely, and may raise one only as far as
 * the environment allows. The env value is the ceiling, not merely the default.
 *
 * Without that, the caps would be advisory: anything holding the admin token
 * could raise the per-action cap and then spend to it, and the guardrail that
 * bounds an automated refiller pointed at a live wallet would exist only until
 * something decided otherwise. Keeping the ceiling in the environment means it
 * lives in the deployment repo, where a change is a reviewed commit rather than
 * a click.
 *
 * The protective floors invert the same rule: MIN_WALLET_* may be raised from
 * the dashboard but never lowered, because a higher floor is the cautious
 * direction.
 *
 * Settings with no bearing on spending — thresholds, the dilute percentage, the
 * webhook — are freely editable, since the worst case is a badly tuned monitor
 * rather than a drained wallet.
 */

import type { Config } from './config';
import { bzzToPlur, plurToBzz } from './math';

/** How a setting may be moved relative to its environment value. */
type Bound = 'free' | 'atMost' | 'atLeast';

interface Spec {
  /** Key in the settings table. */
  key: string;
  kind: 'bool' | 'int' | 'float' | 'bzz' | 'string';
  bound: Bound;
  /** Human label for the dashboard. */
  label: string;
  hint?: string;
  min?: number;
  max?: number;
}

/**
 * Every setting the dashboard may change.
 *
 * Anything absent here is structural — BEE_URL, DB_PATH, PORT, the admin token
 * — and needs a restart, so it is deliberately not editable at runtime.
 */
export const EDITABLE: Spec[] = [
  { key: 'autoTopupEnabled', kind: 'bool', bound: 'free', label: 'Auto top-up' },
  { key: 'dryRun', kind: 'bool', bound: 'free', label: 'Dry run', hint: 'plan but never spend' },
  { key: 'topupWhenTtlBelowDays', kind: 'int', bound: 'free', min: 1, max: 3650,
    label: 'Top up when life falls below', hint: 'days' },
  { key: 'topupTargetTtlDays', kind: 'int', bound: 'free', min: 2, max: 3650,
    label: 'Top up to', hint: 'days' },
  { key: 'diluteEnabled', kind: 'bool', bound: 'free', label: 'Auto dilute' },
  { key: 'diluteWhenUtilizationAbove', kind: 'float', bound: 'free', min: 0.1, max: 1,
    label: 'Dilute when fullest bucket exceeds', hint: '0–1' },
  { key: 'maxAutoDiluteDepth', kind: 'int', bound: 'atMost', min: 17, max: 41,
    label: 'Never auto-dilute past depth', hint: 'capped by the environment' },
  { key: 'maxTopupBzzPerBatch', kind: 'bzz', bound: 'atMost',
    label: 'Max per action', hint: 'xBZZ — cannot exceed the environment ceiling' },
  { key: 'maxTopupBzzPerDay', kind: 'bzz', bound: 'atMost',
    label: 'Max per 24h', hint: 'xBZZ — cannot exceed the environment ceiling' },
  { key: 'minWalletBzz', kind: 'bzz', bound: 'atLeast',
    label: 'Wallet floor', hint: 'xBZZ — may only be raised' },
  { key: 'minWalletXdai', kind: 'float', bound: 'atLeast', min: 0, max: 100,
    label: 'Gas floor', hint: 'xDAI — may only be raised' },
  { key: 'walletLowRunwayDays', kind: 'int', bound: 'free', min: 1, max: 3650,
    label: 'Warn when runway below', hint: 'days' },
  { key: 'webhookUrl', kind: 'string', bound: 'free', label: 'Webhook URL',
    hint: 'where alerts are POSTed' },
];

const BY_KEY = new Map(EDITABLE.map((s) => [s.key, s]));

/** The environment value for a setting, in the units the dashboard uses. */
export function envValue(cfg: Config, key: string): string | number | boolean | null {
  switch (key) {
    case 'autoTopupEnabled': return cfg.autoTopupEnabled;
    case 'dryRun': return cfg.dryRun;
    case 'topupWhenTtlBelowDays': return cfg.topupWhenTtlBelowSec / 86_400;
    case 'topupTargetTtlDays': return cfg.topupTargetTtlSec / 86_400;
    case 'diluteEnabled': return cfg.diluteEnabled;
    case 'diluteWhenUtilizationAbove': return cfg.diluteWhenUtilizationAbove;
    case 'maxAutoDiluteDepth': return cfg.maxAutoDiluteDepth;
    case 'maxTopupBzzPerBatch': return plurToBzz(cfg.maxTopupPlurPerBatch);
    case 'maxTopupBzzPerDay': return plurToBzz(cfg.maxTopupPlurPerDay);
    case 'minWalletBzz': return plurToBzz(cfg.minWalletPlur);
    case 'minWalletXdai': return Number(cfg.minWalletXdaiWei) / 1e18;
    case 'walletLowRunwayDays': return cfg.walletLowRunwayDays;
    case 'webhookUrl': return cfg.webhookUrl;
    default: return null;
  }
}

/**
 * Clamp a requested value against its environment bound.
 *
 * Returns the value actually applied plus whether it was clamped, so the
 * dashboard can say "your 50 became 5" rather than silently disagreeing with
 * the field the user just typed.
 */
export function clampToEnv(cfg: Config, key: string, requested: number): { value: number; clamped: boolean } {
  const spec = BY_KEY.get(key);
  if (!spec) return { value: requested, clamped: false };
  const env = envValue(cfg, key);
  if (typeof env !== 'number') return { value: requested, clamped: false };
  if (spec.bound === 'atMost' && requested > env) return { value: env, clamped: true };
  if (spec.bound === 'atLeast' && requested < env) return { value: env, clamped: true };
  return { value: requested, clamped: false };
}

/**
 * Apply stored overrides to a config, honouring the bounds.
 *
 * Pure, and called fresh wherever the config is read, so a change takes effect
 * on the next poll or request rather than at the next restart.
 */
export function applySettings(cfg: Config, stored: Record<string, string>): Config {
  const out: Config = { ...cfg };

  for (const spec of EDITABLE) {
    const raw = stored[spec.key];
    if (raw === undefined) continue;

    if (spec.kind === 'bool') {
      const v = /^(1|true|on|yes)$/i.test(raw);
      if (spec.key === 'autoTopupEnabled') out.autoTopupEnabled = v;
      if (spec.key === 'dryRun') out.dryRun = v;
      if (spec.key === 'diluteEnabled') out.diluteEnabled = v;
      continue;
    }

    if (spec.kind === 'string') {
      if (spec.key === 'webhookUrl') out.webhookUrl = raw.trim() || null;
      continue;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const { value } = clampToEnv(cfg, spec.key, n);

    switch (spec.key) {
      case 'topupWhenTtlBelowDays': out.topupWhenTtlBelowSec = value * 86_400; break;
      case 'topupTargetTtlDays': out.topupTargetTtlSec = value * 86_400; break;
      case 'diluteWhenUtilizationAbove': out.diluteWhenUtilizationAbove = value; break;
      case 'maxAutoDiluteDepth': out.maxAutoDiluteDepth = value; break;
      case 'maxTopupBzzPerBatch': out.maxTopupPlurPerBatch = bzzToPlur(String(value)); break;
      case 'maxTopupBzzPerDay': out.maxTopupPlurPerDay = bzzToPlur(String(value)); break;
      case 'minWalletBzz': out.minWalletPlur = bzzToPlur(String(value)); break;
      case 'minWalletXdai': out.minWalletXdaiWei = BigInt(Math.round(value * 1e18)); break;
      case 'walletLowRunwayDays': out.walletLowRunwayDays = value; break;
    }
  }

  // A target at or below the trigger would re-fire and spend every cycle.
  // Enforced after merging, since either half can come from either layer.
  if (out.topupTargetTtlSec <= out.topupWhenTtlBelowSec) {
    out.topupTargetTtlSec = cfg.topupTargetTtlSec;
    out.topupWhenTtlBelowSec = cfg.topupWhenTtlBelowSec;
  }

  return out;
}
