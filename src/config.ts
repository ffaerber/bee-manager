/**
 * Configuration. Every spending-related default is deliberately the safe one:
 * auto top-up off, dry run on. The node is currently reachable from the public
 * internet, so a daemon that spends without being explicitly switched on would
 * be worse than no daemon at all.
 */

import { bzzToPlur, PLUR_PER_BZZ } from './math';

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${key}: expected a boolean, got "${v}"`);
}

function int(key: string, fallback: number, min = 0): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`${key}: expected an integer >= ${min}, got "${v}"`);
  }
  return n;
}

/** BZZ-denominated config is parsed to exact PLUR — never held as a float. */
function plur(key: string, fallbackBzz: string): bigint {
  const v = process.env[key];
  try {
    return bzzToPlur(v === undefined || v === '' ? fallbackBzz : v);
  } catch {
    throw new Error(`${key}: expected a positive decimal xBZZ amount, got "${v}"`);
  }
}

export interface Config {
  beeUrl: string;
  beeTimeoutMs: number;
  /** Writes are on-chain transactions; a short timeout only means giving up mid-spend. */
  beeWriteTimeoutMs: number;
  beeUploadTimeoutMs: number;
  maxUploadBytes: number;
  pollIntervalMs: number;
  dbPath: string;
  port: number;

  autoTopupEnabled: boolean;
  dryRun: boolean;

  topupWhenTtlBelowSec: number;
  topupTargetTtlSec: number;
  diluteWhenUtilizationAbove: number;
  diluteEnabled: boolean;
  maxAutoDiluteDepth: number;

  maxTopupPlurPerBatch: bigint;
  maxTopupPlurPerDay: bigint;
  minWalletPlur: bigint;
  minWalletXdaiWei: bigint;

  /** New batches whose label starts with this are auto-excluded from management. */
  unmanagedLabelPrefix: string;

  webhookUrl: string | null;
  publicGatewayUrl: string;
  alertCooldownMs: number;
  walletLowRunwayDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const prev = process.env;
  process.env = env as any;
  try {
    const cfg: Config = {
      beeUrl: str('BEE_URL', 'http://bee:1633'),
      beeTimeoutMs: int('BEE_TIMEOUT_MS', 15_000, 1_000),
      beeWriteTimeoutMs: int('BEE_WRITE_TIMEOUT_MS', 300_000, 10_000),
      beeUploadTimeoutMs: int('BEE_UPLOAD_TIMEOUT_MS', 300_000, 10_000),
      /**
       * Ceiling on a dashboard upload.
       *
       * Bounded by memory, not policy: the request body is buffered whole
       * before being handed to Bee, and the container is limited to 512 MB.
       * 32 MB leaves ample headroom for the buffer, Bee's own copy and the
       * 65,536-bucket reads happening alongside it. Raise it only together
       * with the container's memory limit.
       */
      maxUploadBytes: int('MAX_UPLOAD_BYTES', 32 * 1024 * 1024, 4096),
      pollIntervalMs: int('POLL_INTERVAL_MS', 300_000, 10_000),
      dbPath: str('DB_PATH', './data/monitor.sqlite'),
      port: int('PORT', 3000, 1),

      autoTopupEnabled: bool('AUTO_TOPUP_ENABLED', false),
      dryRun: bool('DRY_RUN', true),

      topupWhenTtlBelowSec: int('TOPUP_WHEN_TTL_BELOW_DAYS', 14, 1) * 86_400,
      topupTargetTtlSec: int('TOPUP_TARGET_TTL_DAYS', 60, 1) * 86_400,
      diluteWhenUtilizationAbove: Number(str('DILUTE_WHEN_UTILIZATION_ABOVE', '0.8')),
      diluteEnabled: bool('DILUTE_ENABLED', true),
      /**
       * Automatic dilution stops here.
       *
       * Dilution cannot be undone and permanently doubles the cost of every
       * future top-up, since cost scales with 2^depth. An unbounded automatic
       * version could walk a batch up to a running cost nothing else in this
       * service would authorise — the spend caps only see one action at a
       * time, not the burn rate it leaves behind. Past this depth it becomes a
       * human decision, which usually means buying a right-sized batch instead.
       */
      maxAutoDiluteDepth: int('MAX_AUTO_DILUTE_DEPTH', 22, 17),

      maxTopupPlurPerBatch: plur('MAX_TOPUP_BZZ_PER_BATCH', '10'),
      maxTopupPlurPerDay: plur('MAX_TOPUP_BZZ_PER_DAY', '25'),
      minWalletPlur: plur('MIN_WALLET_BZZ', '5'),
      minWalletXdaiWei: BigInt(Math.round(Number(str('MIN_WALLET_XDAI', '0.5')) * 1e18)),

      // "share a file and forget it" stamps: label them tmp-* and the poller
      // will never renew them or alert when they lapse.
      unmanagedLabelPrefix: str('UNMANAGED_LABEL_PREFIX', 'tmp-'),

      webhookUrl: str('WEBHOOK_URL', '') || null,
      /**
       * Base for shareable links. Note this is NOT gateway.ethswarm.org: that
       * host serves the gateway's own web app for /bzz/<ref> and returns 200
       * with an HTML page, so a link built from it looks fine and downloads
       * nothing. download.gateway.ethswarm.org serves the bytes, and needs a
       * trailing slash or it 308s to add one.
       */
      publicGatewayUrl: str('PUBLIC_GATEWAY_URL', 'https://download.gateway.ethswarm.org').replace(/\/+$/, ''),
      alertCooldownMs: int('ALERT_COOLDOWN_MS', 6 * 3_600_000, 0),
      walletLowRunwayDays: int('WALLET_LOW_RUNWAY_DAYS', 30, 1),
    };

    if (cfg.topupTargetTtlSec <= cfg.topupWhenTtlBelowSec) {
      throw new Error('TOPUP_TARGET_TTL_DAYS must exceed TOPUP_WHEN_TTL_BELOW_DAYS, or every poll would top up');
    }
    if (!(cfg.diluteWhenUtilizationAbove > 0 && cfg.diluteWhenUtilizationAbove <= 1)) {
      throw new Error('DILUTE_WHEN_UTILIZATION_ABOVE must be between 0 and 1');
    }
    if (cfg.maxTopupPlurPerBatch > cfg.maxTopupPlurPerDay) {
      throw new Error('MAX_TOPUP_BZZ_PER_BATCH exceeds MAX_TOPUP_BZZ_PER_DAY — the daily cap could never be respected');
    }
    return cfg;
  } finally {
    process.env = prev;
  }
}

export function describeConfig(c: Config): string {
  const bzz = (p: bigint) => (Number(p) / Number(PLUR_PER_BZZ)).toFixed(2);
  return [
    `bee=${c.beeUrl} poll=${c.pollIntervalMs / 1000}s`,
    `autoTopup=${c.autoTopupEnabled ? 'ON' : 'off'} dryRun=${c.dryRun ? 'ON' : 'off'}`,
    `topup when TTL<${c.topupWhenTtlBelowSec / 86400}d -> ${c.topupTargetTtlSec / 86400}d`,
    `caps: ${bzz(c.maxTopupPlurPerBatch)}/action ${bzz(c.maxTopupPlurPerDay)}/day floor ${bzz(c.minWalletPlur)} xBZZ`,
    // Dilution was armed by default and reported nowhere. It is irreversible
    // and permanently raises the burn rate, so it belongs in the banner beside
    // auto top-up rather than being discovered from a depth that changed.
    `dilute=${c.diluteEnabled ? `ON >${c.diluteWhenUtilizationAbove * 100}% up to depth ${c.maxAutoDiluteDepth}` : 'off'}`,
    `webhook=${c.webhookUrl ? 'set' : 'none'}`,
  ].join(' | ');
}
