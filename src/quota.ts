/**
 * Upload quotas for the public write API.
 *
 * The node's wallet pays for every user's upload across every dapp, so this
 * endpoint is the one place where strangers can spend your money. Be honest
 * about what this can and cannot do:
 *
 *   - It CANNOT prevent Sybil abuse. Wallet addresses are free to generate, so
 *     per-address limits slow an attacker down but do not stop one.
 *   - It CAN bound the loss. The per-app daily byte budget is the blast radius:
 *     the worst realistic outcome is a wasted day's budget plus an alert, not a
 *     drained wallet.
 *
 * Limits are on *bytes*, not BZZ, because for a write service capacity is what
 * gets consumed — filling a batch forces a dilution, and dilution is what costs.
 */

import type { Db, AppRow } from './db';
import { CHUNK_BYTES } from './math';

export interface QuotaLimits {
  /** Largest single upload accepted. */
  maxUploadBytes: number;
  /** Bytes an app may absorb per day across all users. The blast radius. */
  appDailyBytes: number;
  /** Bytes one address may upload per day. */
  addressDailyBytes: number;
  /** Uploads one address may make per day. */
  addressDailyUploads: number;
}

export interface QuotaVerdict {
  allowed: boolean;
  reason: string;
  /** Set when the app-wide budget is what blocked — worth alerting on. */
  appBudgetExhausted?: boolean;
  remaining: { appBytes: number; addressBytes: number; addressUploads: number };
}

const MB = 1024 * 1024;

/**
 * Browser callers, authenticated by wallet signature. Addresses are free to
 * mint, so these are deliberately small: the per-request cap keeps any single
 * upload cheap, and the app-wide budget is the real blast radius.
 */
export const DEFAULT_LIMITS: QuotaLimits = {
  maxUploadBytes: 5 * MB,
  appDailyBytes: 256 * MB,
  addressDailyBytes: 16 * MB,
  addressDailyUploads: 100,
};

/** No daily limit: larger than anything a day of uploads can reach. */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

/**
 * Callers with a per-app API key — a secret only you and your apps hold, so
 * the caller is trusted in a way a wallet signature never is. No daily
 * counters: they only ever blocked the owner's own apps (one key's uploads all
 * share one counter, so 50 a day stopped an image board mid-afternoon). What
 * stays is the per-request cap, because a body is read into memory whole; a
 * site deploy is one tar of the whole build, so it is well above the
 * browser-facing 5 MB.
 *
 * Uploads are still recorded (dashboard, metrics, history), and still count
 * toward the signature path's app-wide budget, which keeps bounding strangers.
 */
export const PIPELINE_LIMITS: QuotaLimits = {
  maxUploadBytes: 64 * MB,
  appDailyBytes: UNLIMITED,
  addressDailyBytes: UNLIMITED,
  addressDailyUploads: UNLIMITED,
};

/** Chunks a payload occupies — what actually consumes batch capacity. */
export function chunksFor(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / CHUNK_BYTES);
}

export function checkQuota(
  db: Db,
  app: AppRow,
  address: string,
  bytes: number,
  limits: QuotaLimits = DEFAULT_LIMITS,
  now = Date.now(),
): QuotaVerdict {
  const appUsed = db.bytesUploaded(app.name, 86_400_000, undefined, now);
  const addrUsed = db.bytesUploaded(app.name, 86_400_000, address, now);
  const addrCount = db.uploadCount(app.name, 86_400_000, address, now);

  const remaining = {
    appBytes: Math.max(0, limits.appDailyBytes - appUsed),
    addressBytes: Math.max(0, limits.addressDailyBytes - addrUsed),
    addressUploads: Math.max(0, limits.addressDailyUploads - addrCount),
  };

  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  if (bytes <= 0) {
    return { allowed: false, reason: 'empty upload', remaining };
  }
  if (bytes > limits.maxUploadBytes) {
    return { allowed: false, reason: `upload is ${mb(bytes)}, over the ${mb(limits.maxUploadBytes)} per-request limit`, remaining };
  }
  if (addrCount >= limits.addressDailyUploads) {
    return { allowed: false, reason: `address has made ${addrCount} uploads today, at the ${limits.addressDailyUploads} limit`, remaining };
  }
  if (addrUsed + bytes > limits.addressDailyBytes) {
    return { allowed: false, reason: `address has used ${mb(addrUsed)} of its ${mb(limits.addressDailyBytes)} daily allowance`, remaining };
  }
  // Checked last so the more specific per-address messages win, and so this
  // distinct flag only fires when the shared budget is genuinely the blocker.
  if (appUsed + bytes > limits.appDailyBytes) {
    return {
      allowed: false,
      appBudgetExhausted: true,
      reason: `${app.name} has used ${mb(appUsed)} of its ${mb(limits.appDailyBytes)} daily budget`,
      remaining,
    };
  }
  return { allowed: true, reason: `within quota (${mb(remaining.appBytes)} left for ${app.name} today)`, remaining };
}

/**
 * Limits for a caller, chosen by how it authenticated. An API key is a real
 * secret held by a deploy pipeline; a signature is not, because anyone can make
 * a wallet.
 */
export function limitsFor(
  _app: AppRow,
  via: 'api-key' | 'signature' = 'signature',
  overrides: Partial<QuotaLimits> = {},
): QuotaLimits {
  return { ...(via === 'api-key' ? PIPELINE_LIMITS : DEFAULT_LIMITS), ...overrides };
}
