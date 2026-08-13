/**
 * Display formatting shared by the overview and the batch page.
 *
 * Here rather than in either page so the two cannot disagree about what "14 d"
 * or "warning" means — the batch row and the batch's own page have to agree,
 * or opening a batch appears to change its state.
 */

/**
 * Severity for a batch's remaining life, against the configured top-up
 * threshold. Below the threshold is a warning rather than a failure: that is
 * the point at which the monitor intends to act, not the point at which
 * anything is broken.
 */
export function ttlSeverity(days: number, thresholdDays: number): 'good' | 'warning' | 'critical' {
  if (days <= 0) return 'critical';
  if (days < thresholdDays) return 'warning';
  return 'good';
}

export function fmtDays(d: number): string {
  if (!isFinite(d)) return '∞';
  if (d >= 365) return `${(d / 365).toFixed(1)} yr`;
  return `${d.toFixed(d < 10 ? 1 : 0)} d`;
}

/** Decimal units (kB = 1000), matching how storage is normally quoted. */
export function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log10(n) / 3), u.length - 1);
  const v = n / Math.pow(1000, i);
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** When a batch runs out, as a local date. */
export function expiryDate(ttlDays: number, now = Date.now()): string {
  if (!isFinite(ttlDays) || ttlDays <= 0) return 'expired';
  return new Date(now + ttlDays * 86_400_000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
