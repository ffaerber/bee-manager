/**
 * Can anyone else actually reach this node?
 *
 * Every other health signal here is self-reported. `/topology` says how many
 * peers the node has, and it says a healthy number whether or not a single one
 * of them could dial back — because those are connections the node made
 * OUTBOUND. A node behind a broken forward, or advertising an address that
 * stopped being its own, reports a full peer table and looks perfect.
 *
 * That is not hypothetical: the homelab node advertised a WAN address that had
 * rotated away six weeks earlier. It reported ~120 peers the whole time.
 * Swarmscan had been dialling the stale address and timing out since
 * 2026-07-06, and nothing local knew. The forward was fine; only the
 * advertised address was wrong, which is a failure with no local symptom at
 * all.
 *
 * So this asks someone else. An outside view is the only thing that can
 * distinguish "reachable" from "reports a lot of peers", and the two look
 * identical from inside.
 *
 * ── Never influences a spending decision. ──
 *
 * Like the fiat price, this is a third-party reading and is allowed to be null
 * at any moment: no network, a rate limit, an API change, or
 * REACHABILITY_ENABLED=false all produce it. Nothing here gates a top-up. An
 * unreachable node still needs its batches renewed — arguably more.
 *
 * The overlay address is sent to a third party to ask about it. That is not a
 * secret: it is broadcast to every peer on the network and is already indexed
 * publicly. It is still an outbound call to someone else's service, so it can
 * be switched off.
 */

export interface Reachability {
  /** The overlay this describes, so a stale reading cannot be misattributed. */
  overlay: string;
  /**
   * True when the outside view could NOT dial the node.
   *
   * Null when the answer is unknown — upstream down, disabled, or the node not
   * yet indexed. Null must never be rendered as "fine": a node nobody has
   * looked at is not a node known to be reachable.
   */
  unreachable: boolean | null;
  /** Round-trip for the handshake, in ms. A ~5000 here is a timeout, not a slow node. */
  handshakeMs: number | null;
  /** Upstream's user-agent string, absent until a handshake actually completes. */
  userAgent: string | null;
  /** When the outside observer last tried, epoch ms. Its cadence, not ours. */
  lastCheckedAt: number | null;
  /** Why the dial failed, trimmed. Usually names the address that was tried. */
  error: string | null;
  /** When WE fetched this, so the UI can show staleness of the reading itself. */
  fetchedAt: number;
}

export interface ReachabilityOptions {
  enabled?: boolean;
  /**
   * Long by design. The upstream observer re-checks on its own schedule —
   * measured in tens of minutes at best — so polling it every 5-minute cycle
   * would be noise at their expense and would not produce a fresher answer.
   */
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** Trim an upstream error to something a dashboard can show on one line. */
function firstLine(s: unknown): string | null {
  if (typeof s !== 'string' || !s.trim()) return null;
  return s.split('\n')[0]!.trim().slice(0, 200);
}

export class ReachabilityFeed {
  private cached: Reachability | null = null;
  private inflight: Promise<Reachability | null> | null = null;

  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: ReachabilityOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.swarmscan.io').replace(/\/+$/, '');
  }

  get last(): Reachability | null {
    return this.cached;
  }

  /**
   * Never throws. A failure returns the previous reading rather than null, so
   * one bad fetch does not blank a finding that is still true — reachability
   * changes on the scale of router configs, not seconds.
   */
  async get(overlay: string, now = Date.now()): Promise<Reachability | null> {
    if (!this.enabled || !overlay) return null;
    // A different overlay invalidates the cache outright: reporting one node's
    // reachability under another's identity is worse than reporting nothing.
    const fresh = this.cached
      && this.cached.overlay === overlay
      && now - this.cached.fetchedAt < this.ttlMs;
    if (fresh) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchOne(overlay, now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchOne(overlay: string, now: number): Promise<Reachability | null> {
    const url = `${this.baseUrl}/v1/network/nodes/${overlay}`;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      // A 404 is meaningful and not an error: the network has no record of this
      // node at all, which for a node that has been running is itself a finding.
      if (res.status === 404) {
        return (this.cached = {
          overlay, unreachable: null, handshakeMs: null, userAgent: null,
          lastCheckedAt: null, error: 'not indexed by the observer', fetchedAt: now,
        });
      }
      if (!res.ok) return this.cached;
      const b: any = await res.json();

      // Only trust a payload that is about the overlay we asked for.
      if (typeof b?.overlay === 'string' && b.overlay.toLowerCase() !== overlay.toLowerCase()) {
        return this.cached;
      }

      const ms = Number(b?.handshakeDurationMilliseconds);
      const checked = Date.parse(b?.lastCheckTime ?? '');
      return (this.cached = {
        overlay,
        // Absent means reachable upstream: the field is only set on failure.
        // Coerced explicitly so `undefined` cannot read as "unknown" when it
        // actually means the dial worked.
        unreachable: typeof b?.unreachable === 'boolean' ? b.unreachable : false,
        handshakeMs: Number.isFinite(ms) ? ms : null,
        userAgent: typeof b?.userAgent === 'string' ? b.userAgent : null,
        lastCheckedAt: Number.isFinite(checked) ? checked : null,
        error: firstLine(b?.error),
        fetchedAt: now,
      });
    } catch {
      // Offline, timeout, or a shape we did not expect. Keep the last reading.
      return this.cached;
    }
  }
}
