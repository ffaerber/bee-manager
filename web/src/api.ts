/** Thin client for the admin API. The token is supplied by the operator at
 *  runtime (the service normally sits behind Traefik basicauth as well). */

const TOKEN_KEY = 'ssm-admin-token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': getToken(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * The ticker shown for every on-chain amount.
 *
 * The node is on Gnosis, so its wallet, its batch costs and every cap are
 * denominated in xBZZ — mainnet BZZ bridged 1:1 via Omnibridge — exactly as the
 * gas balance beside it is xDAI rather than DAI. The only place "BZZ" is correct
 * on its own is the market quote, which prices the underlying asset.
 *
 * Defined once so the two cannot drift apart again.
 */
export const TOKEN = 'xBZZ';

export interface Batch {
  batchID: string; label: string; depth: number; batchTTL: number; ttlDays: number;
  utilizationRatio: number; usable: boolean; immutableFlag: boolean;
  storedHuman: string; capacityHuman: string; managed: boolean;
  /** Stored overrides; null means this batch follows the global setting. */
  policy: BatchPolicy;
  /** What is actually in force once the globals are applied. */
  effective: {
    topupWhenTtlBelowSec: number; topupTargetTtlSec: number;
    diluteWhenUtilizationAbove: number; maxAutoDiluteDepth: number;
  };
}
export interface BatchPolicy {
  topupBelowDays: number | null;
  topupTargetDays: number | null;
  diluteAbove: number | null;
  maxDiluteDepth: number | null;
}
export interface Chequebook {
  totalBzz: number;
  /** Spendable on bandwidth right now — outstanding cheques already deducted. */
  availableBzz: number;
  sentBzz: number;
  receivedBzz: number;
  /** Null until an hour of history exists to measure a rate over. */
  spendPer30DaysBzz: number | null;
  /** Null when nothing is being spent. Never Infinity — JSON would drop it. */
  runwayDays: number | null;
  windowMs: number;
  peers: number;
  peersOwingUs: number;
  low: boolean;
}

export interface State {
  ok: boolean; error: string | null; msPerBlock: number;
  burnPer30DaysBzz: number;
  /**
   * Wallet / burn — what is left to fund future top-ups. Flat between spends.
   *
   * Null means nothing is burning, so the runway is unbounded. It is null and
   * not Infinity because Infinity does not survive JSON: the server sends null
   * either way, and typing it honestly stops `isFinite(null) === true` turning
   * "forever" into a critical zero.
   */
  runwayDays: number | null;
  /** (Wallet + committed batch value) / burn. The one that truly counts down. */
  totalRunwayDays: number | null;
  /** Value paid into the batches and not yet consumed, in xBZZ. */
  committedBzz: number;
  /** Age of this snapshot in ms, measured on the server. /state is cached. */
  dataAgeMs: number;
  /** SWAP settlement health. Null when the node has no readable chequebook. */
  chequebook: Chequebook | null;
  wallet?: {
    bzz: number; xdai: number; address: string;
    chainId: number; chequebookAddress: string;
    /** Held in the chequebook / staking contract — real xBZZ, but not spendable on postage. */
    chequebookBzz: number | null; chequebookAvailableBzz: number | null; stakedBzz: number | null;
  };
  node?: {
    healthy: boolean; version?: string; beeMode?: string;
    peers: number | null; storageRadius: number | null;
  };
  chain?: { block: number; price: string };
  /** Display-only fiat quote; null/absent whenever the price feed is off or unreachable. */
  fiat?: { usd: number; eur: number; usd24hChange: number; fetchedAt: number } | null;
  batches: Batch[];
  plans: { kind: 'none' | 'topup' | 'dilute' | 'blocked'; batchId: string; reason: string }[];
  config: { autoTopupEnabled: boolean; dryRun: boolean; topupWhenTtlBelowDays: number; topupTargetTtlDays: number };
}
export interface Quote {
  depth: number; days: number; costBzz: number; capacityGb: number;
  capacityHuman: string; costPer30DaysBzz: number; runwayDaysAfter: number;
  affordable: boolean; amountPerChunk: string; warnings: string[];
}
export interface Ladder {
  days: number;
  recommended: { depth: number; reason: string } | null;
  ladder: Quote[];
}
export interface Action {
  id: number; ts: number; batchId: string | null; kind: string;
  cost: string; status: string; reason: string; error: string | null;
}

/** Per-bucket occupancy for one batch. Fetched on demand — it is 65,536 entries. */
export interface BucketGrid {
  depth: number; bucketDepth: number; bucketUpperBound: number; side: number;
  totalChunks: number; usedBuckets: number; emptyBuckets: number; fullBuckets: number;
  maxCollisions: number; storedBytes: number; capacityBytes: number;
  /** Chunks before the first bucket fills — where behaviour changes. */
  firstFullChunks: number;
  /** Base for public download links, from settings. */
  publicGatewayUrl: string;
  /** Server's upload ceiling, so the browser can refuse before transferring. */
  maxUploadBytes: number;
  /** Chunk slots free batch-wide — an upper bound; buckets bind tighter. */
  freeChunks: number;
  /** base64, one byte per bucket, fill scaled 0-255. */
  grid: string;
  label: string; immutable: boolean;
  pressure: { level: 'good' | 'warning' | 'critical'; message: string };
}

export const getBuckets = (id: string) => req<BucketGrid>(`/batches/${id}/buckets`);

/** Preview of what a manual top-up would do. */
export interface TopupPreview {
  batchId: string; fromDays: number; toDays: number;
  costBzz: number; allowed: boolean; reason: string;
  /** The batch is set to expire; spending on it is allowed but worth saying. */
  unmanaged: boolean;
}
export const topup = (id: string, opts: { days?: number; confirm?: boolean }) =>
  req<{ preview?: TopupPreview; confirmRequired?: boolean; toppedUp?: TopupPreview; dryRun?: boolean; wouldTopup?: TopupPreview }>(
    `/batches/${id}/topup`, { method: 'POST', body: JSON.stringify(opts) });

/** Preview of what diluting would do. */
export interface DilutePreview {
  batchId: string; unmanaged: boolean; tooThin: boolean;
  fromDepth: number; toDepth: number;
  capacityBeforeHuman: string; capacityAfterHuman: string;
  ttlDaysBefore: number; ttlDaysAfter: number;
  restoreToDays: number; restoreCostBzz: number; restoreAffordable: boolean;
}
export const dilute = (id: string, opts: { newDepth?: number; confirm?: boolean }) =>
  req<{ preview?: DilutePreview; confirmRequired?: boolean; diluted?: DilutePreview; dryRun?: boolean; wouldDilute?: DilutePreview }>(
    `/batches/${id}/dilute`, { method: 'POST', body: JSON.stringify(opts) });

/** One stored upload for a batch. */
export interface Upload {
  id: number; ts: number; bytes: number;
  reference: string; name: string | null; contentType: string | null;
}
export const getUploads = (id: string) => req<Upload[]>(`/batches/${id}/uploads`);

/**
 * Fetch uploaded content back, authenticated.
 *
 * A plain <a href> cannot carry the admin token, so content is pulled with
 * fetch and handed to the browser as an object URL. Callers must revoke it.
 */
export async function fetchContent(reference: string): Promise<string> {
  const res = await fetch(`/api/admin/content/${reference}`, { headers: { 'x-admin-token': getToken() } });
  if (!res.ok) throw new Error(`could not fetch content (HTTP ${res.status})`);
  return URL.createObjectURL(await res.blob());
}

/** Upload a file straight to one batch. Consumes capacity and publishes. */
export const uploadToBatch = (id: string, file: File) =>
  req<{ reference: string; bytes: number; name: string | null }>(
    `/batches/${id}/upload?name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } },
  );
/** One runtime setting, with its environment value and any override. */
export interface SettingSpec {
  key: string; kind: 'bool' | 'int' | 'float' | 'percent' | 'depth' | 'days' | 'bzz' | 'string';
  group: 'automation' | 'thresholds' | 'limits' | 'alerts' | 'sharing';
  /** Direction that weakens this guard, or null when it guards nothing. */
  looserWhen: 'higher' | 'lower' | null;
  label: string; hint?: string; risk?: string; min?: number; max?: number; stops?: number[];
  /** The value in force. There is only one — the database is authoritative. */
  value: string | number | boolean | null;
}
export interface SettingChange {
  key: string; label: string; from: unknown; to: unknown; risk: string | null;
}
export interface SettingsResponse {
  settings: SettingSpec[];
  fixed: { beeUrl: string; pollIntervalMs: number; dbPath: string; maxUploadBytes: number };
}
export const getSettings = () => req<SettingsResponse>('/settings');
export const patchSettings = (patch: Record<string, unknown>) =>
  req<{
    applied?: Record<string, unknown>; loosened?: string[];
    confirmRequired?: boolean; changes?: SettingChange[];
  }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) });

export const getState = () => req<State>('/state');
export const getActions = () => req<Action[]>('/actions?limit=25');
export const getLadder = (days: number, storedBytes?: string) =>
  req<Ladder>(`/wizard/ladder?days=${days}${storedBytes ? `&storedBytes=${storedBytes}` : ''}`);
export const poll = () => req<unknown>('/poll', { method: 'POST' });
export const patchBatch = (
  id: string,
  patch: { label?: string; managed?: boolean } & Partial<BatchPolicy>,
) =>
  req<unknown>(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const buy = (b: { depth: number; days: number; label?: string; immutable?: boolean; confirm?: boolean }) =>
  req<any>('/wizard/buy', { method: 'POST', body: JSON.stringify(b) });
