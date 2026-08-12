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

export const getState = () => req<State>('/state');
export const getActions = () => req<Action[]>('/actions?limit=25');
export const getLadder = (days: number, storedBytes?: string) =>
  req<Ladder>(`/wizard/ladder?days=${days}${storedBytes ? `&storedBytes=${storedBytes}` : ''}`);
export const poll = () => req<unknown>('/poll', { method: 'POST' });
export const patchBatch = (id: string, patch: { label?: string; managed?: boolean }) =>
  req<unknown>(`/batches/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const buy = (b: { depth: number; days: number; label?: string; immutable?: boolean; confirm?: boolean }) =>
  req<any>('/wizard/buy', { method: 'POST', body: JSON.stringify(b) });
