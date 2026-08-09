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

export const DEFAULT_LIMITS: QuotaLimits = {
  maxUploadBytes: 5 * 1024 * 1024,
  appDailyBytes: 256 * 1024 * 1024,
  addressDailyBytes: 16 * 1024 * 1024,
  addressDailyUploads: 100,
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

/** Parse limits from an app row's overrides, falling back to the defaults. */
export function limitsFor(_app: AppRow, overrides: Partial<QuotaLimits> = {}): QuotaLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}
