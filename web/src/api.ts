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
}
export interface State {
  ok: boolean; error: string | null; msPerBlock: number;
  burnPer30DaysBzz: number; runwayDays: number;
  wallet?: { bzz: number; xdai: number; address: string };
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
  /** base64, one byte per bucket, fill scaled 0-255. */
  grid: string;
  label: string; immutable: boolean;
  pressure: { level: 'good' | 'warning' | 'critical'; message: string };
}

export const getBuckets = (id: string) => req<BucketGrid>(`/batches/${id}/buckets`);
export const getState = () => req<State>('/state');
export const getActions = () => req<Action[]>('/actions?limit=25');
export const getLadder = (days: number, storedBytes?: string) =>
  req<Ladder>(`/wizard/ladder?days=${days}${storedBytes ? `&storedBytes=${storedBytes}` : ''}`);
export const poll = () => req<unknown>('/poll', { method: 'POST' });
export const patchBatch = (id: string, patch: { label?: string; managed?: boolean }) =>
  req<unknown>(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const buy = (b: { depth: number; days: number; label?: string; immutable?: boolean; confirm?: boolean }) =>
  req<any>('/wizard/buy', { method: 'POST', body: JSON.stringify(b) });
