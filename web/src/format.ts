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
export function ttlSeverity(days: number, thresholdDays: number | null): 'good' | 'warning' | 'critical' {
  if (days <= 0) return 'critical';
  // A read-only viewer is told no thresholds, so there is nothing to be "below".
  // Already expired still reads critical — that is a fact about the batch, not
  // about anyone's policy.
  if (thresholdDays != null && days < thresholdDays) return 'warning';
  return 'good';
}

export function fmtDays(d: number): string {
  if (!isFinite(d)) return '∞';
  if (d >= 365) return `${(d / 365).toFixed(1)} yr`;
  return `${d.toFixed(d < 10 ? 1 : 0)} d`;
}

/**
 * Split a duration into whole days and a hh:mm:ss clock.
 *
 * Two fields rather than one string because they are typeset differently: the
 * day count is the reading you take at a glance, the clock is the part that
 * moves. Callers that want them the same size can just join them.
 *
 * Truncates rather than rounds, so the clock counts down through 00:00:00 to
 * the next day instead of displaying a day that has not fully elapsed — a
 * countdown that reads "3 d" when 2 d 23 h remain is wrong in the direction
 * that matters, since this number exists to warn.
 */
export function countdown(ms: number): { days: number; clock: string; done: boolean } {
  if (!isFinite(ms)) return { days: Infinity, clock: '', done: false };
  const left = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(left / 86_400);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(Math.floor((left % 86_400) / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  return { days, clock, done: left === 0 };
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

/**
 * Capacity at a given depth, for labelling a depth control.
 *
 * Lives here rather than beside the slider because it is a pure function, and a
 * .tsx module cannot be imported by the server-side test project — the root
 * tsconfig has no `jsx` setting, and adding one to typecheck a helper would be
 * configuring around the wrong thing.
 */
export function depthCapacity(depth: number): string {
  return fmtBytes(Math.pow(2, depth) * 4096);
}

/**
 * Milliseconds left on a runway figure that was already stale when it arrived.
 *
 * `/state` serves a cached poll, so three clocks are involved and only two of
 * them can be trusted together:
 *
 *   days      the runway as computed at poll time, on the server
 *   ageMs     how long ago that poll was, measured on the SERVER at request
 *             time — never by comparing a server timestamp to a browser one,
 *             because a browser clock that is wrong by minutes would corrupt it
 *   elapsed   how long this tab has had the response, measured by the browser
 *             against itself, which is safe
 *
 * Dropping `ageMs` is the tempting mistake: the clock then runs up to a full
 * poll interval ahead of the truth and lurches backwards each time a fresh
 * poll lands.
 */
export function runwayRemainingMs(days: number, ageMs: number, elapsedMs: number): number {
  if (!isFinite(days)) return Infinity;
  return days * 86_400_000 - ageMs - elapsedMs;
}
