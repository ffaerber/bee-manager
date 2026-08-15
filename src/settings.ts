/**
 * Runtime settings. The database is the source of truth.
 *
 * The environment **seeds** these on first run and is ignored afterwards, so
 * there is exactly one place a value lives and one number to read. An earlier
 * version layered dashboard overrides on top of the environment and treated the
 * env value as a ceiling for spend caps; that was safer on paper and confusing
 * in practice — every setting showed three numbers (environment, override, in
 * force) and you had to work out which one was real.
 *
 * What replaces the ceiling is a confirmation. Loosening a guard — raising a
 * spend cap, lowering a wallet floor — needs an explicit second step, the same
 * arm-then-confirm the app uses everywhere it spends. That keeps the decision
 * deliberate without making it impossible, which is the same correction that
 * applied to blocking manual top-ups on unmanaged batches: inform, do not
 * forbid.
 *
 * Bootstrap settings cannot move here and stay in the environment: BEE_URL and
 * DB_PATH are needed before this table can be read at all, and ADMIN_TOKEN
 * authenticates the page that would edit them.
 */

import type { Config } from './config';
import { bzzToPlur, plurToBzz } from './math';

/**
 * Whether loosening this setting needs an explicit confirmation.
 *
 * `looserWhen` names the direction that weakens a guard — 'higher' for a spend
 * cap, 'lower' for a balance floor. Tightening is always allowed outright,
 * because the cautious direction should never need a ceremony.
 */
type Guard = 'higher' | 'lower' | null;

interface Spec {
  /** Key in the settings table. */
  key: string;
  /**
   * `percent` is stored as a fraction (0–1, which is what utilizationRatio
   * actually is) but shown and entered as 0–100. Nobody reads "0.9 of 1.0" as
   * ninety percent without translating it first.
   */
  kind: 'bool' | 'int' | 'float' | 'percent' | 'bzz' | 'string';
  /** Direction that weakens this guard, or null when it guards nothing. */
  looserWhen: Guard;
  /** Human label for the dashboard. */
  label: string;
  hint?: string;
  /** Shown when confirming a loosening change. */
  risk?: string;
  min?: number;
  max?: number;
  group: 'automation' | 'thresholds' | 'limits' | 'alerts' | 'sharing';
}

/**
 * Every setting the dashboard may change.
 *
 * Anything absent here is structural — BEE_URL, DB_PATH, PORT, the admin token
 * — and needs a restart, so it is deliberately not editable at runtime.
 */
export const EDITABLE: Spec[] = [
  { group: 'automation', key: 'autoTopupEnabled', kind: 'bool', looserWhen: null,
    label: 'Auto top-up', hint: 'renew batches without asking' },
  { group: 'automation', key: 'dryRun', kind: 'bool', looserWhen: null,
    label: 'Dry run', hint: 'plan everything, spend nothing' },
  { group: 'automation', key: 'diluteEnabled', kind: 'bool', looserWhen: null,
    label: 'Auto dilute', hint: 'add capacity when a bucket nears full' },

  { group: 'thresholds', key: 'topupWhenTtlBelowDays', kind: 'int', looserWhen: null,
    min: 1, max: 3650, label: 'Top up when life falls below', hint: 'days' },
  { group: 'thresholds', key: 'topupTargetTtlDays', kind: 'int', looserWhen: null,
    min: 2, max: 3650, label: 'Top up to', hint: 'days — the size of each top-up' },
  { group: 'thresholds', key: 'diluteWhenUtilizationAbove', kind: 'percent', looserWhen: null,
    min: 10, max: 100, label: 'Dilute when fullest bucket exceeds', hint: 'percent full' },

  { group: 'limits', key: 'maxTopupBzzPerBatch', kind: 'bzz', looserWhen: 'higher',
    label: 'Max per action', hint: 'xBZZ',
    risk: 'Raising this is the last stop between a mis-typed duration and the wallet.' },
  { group: 'limits', key: 'maxTopupBzzPerDay', kind: 'bzz', looserWhen: 'higher',
    label: 'Max per 24 hours', hint: 'xBZZ',
    risk: 'This bounds a runaway loop rather than one action. Raising it widens the worst day.' },
  { group: 'limits', key: 'maxAutoDiluteDepth', kind: 'int', looserWhen: 'higher',
    min: 17, max: 41, label: 'Never auto-dilute past depth', hint: 'depth',
    risk: 'Dilution cannot be undone and doubles every future top-up. Each extra depth doubles it again.' },
  { group: 'limits', key: 'minWalletBzz', kind: 'bzz', looserWhen: 'lower',
    label: 'Keep at least', hint: 'xBZZ in the wallet',
    risk: 'This reserve is what stops automation spending the wallet to nothing.' },
  { group: 'limits', key: 'minWalletXdai', kind: 'float', looserWhen: 'lower',
    min: 0, max: 100, label: 'Keep at least', hint: 'xDAI for gas',
    risk: 'Below this a transaction cannot land, so a top-up would fail after being authorised.' },

  { group: 'alerts', key: 'walletLowRunwayDays', kind: 'int', looserWhen: null,
    min: 1, max: 3650, label: 'Warn when runway below', hint: 'days' },
  { group: 'alerts', key: 'webhookUrl', kind: 'string', looserWhen: null,
    label: 'Webhook URL', hint: 'where alerts are POSTed — unset means nothing is announced' },

  { group: 'sharing', key: 'publicGatewayUrl', kind: 'string', looserWhen: null,
    label: 'Public gateway', hint: 'base URL used to build shareable download links' },
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
    case 'publicGatewayUrl': return cfg.publicGatewayUrl;
    default: return null;
  }
}

/**
 * Would this change weaken a guard?
 *
 * Used to decide whether a confirmation is required. Tightening never needs
 * one — the cautious direction should not have a ceremony attached to it.
 */
export function isLoosening(key: string, current: number, next: number): boolean {
  const spec = BY_KEY.get(key);
  if (!spec?.looserWhen) return false;
  return spec.looserWhen === 'higher' ? next > current : next < current;
}

/** The risk sentence shown when confirming a loosening change. */
export function riskOf(key: string): string | null {
  return BY_KEY.get(key)?.risk ?? null;
}

/**
 * Seed the settings table from the environment, once.
 *
 * Only ever writes keys that are absent, so this runs on first boot and is a
 * no-op forever after. That is what makes the database authoritative rather
 * than a layer on top of the environment: after seeding, changing a compose
 * value has no effect and the dashboard is the only place a value lives.
 */
export function seedSettings(
  db: { settings(): Record<string, string>; setSetting(k: string, v: string | null): void },
  cfg: Config,
): string[] {
  const have = db.settings();
  const seeded: string[] = [];
  for (const spec of EDITABLE) {
    if (spec.key in have) continue;
    const v = envValue(cfg, spec.key);
    if (v === null || v === undefined) continue;
    db.setSetting(spec.key, String(v));
    seeded.push(spec.key);
  }
  return seeded;
}

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
      if (spec.key === 'publicGatewayUrl') out.publicGatewayUrl = raw.trim().replace(/\/+$/, '');
      continue;
    }

    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const value = n;

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

  // ── coherence, enforced last since each half is edited independently ──

  // A target at or below the trigger would re-fire and spend every cycle.
  if (out.topupTargetTtlSec <= out.topupWhenTtlBelowSec) {
    out.topupTargetTtlSec = cfg.topupTargetTtlSec;
    out.topupWhenTtlBelowSec = cfg.topupWhenTtlBelowSec;
  }

  // A per-action cap above the daily cap is a cap that can never be respected:
  // the first action would exhaust the day. loadConfig rejects this pairing in
  // the environment, and now that the database is authoritative the same rule
  // has to hold here — otherwise the UI could store a combination the service
  // would refuse to start with.
  if (out.maxTopupPlurPerBatch > out.maxTopupPlurPerDay) {
    out.maxTopupPlurPerBatch = out.maxTopupPlurPerDay;
  }

  return out;
}
