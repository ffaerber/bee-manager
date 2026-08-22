/**
 * Where this node's peers are.
 *
 * Bee knows WHO it is connected to — 140 overlay addresses — and nothing about
 * where any of them is. The location comes from the same outside observer that
 * answers whether we are dialable, because an overlay is a hash and carries no
 * geography at all.
 *
 * ── Resolved once per peer, then remembered. ──
 *
 * A lookup costs ~4 KB and half a second, and a node holds ~140 peers, so
 * resolving the set on every start would be a burst of requests at a free
 * third-party API for answers already on disk. Instead: a few per tick, cached
 * in SQLite permanently, and unlocatable peers marked so they are not retried
 * forever. After the first hour the traffic is whatever churn brings — usually
 * nothing.
 *
 * The map is therefore INCOMPLETE at first, and says so. A partial map that
 * looks complete would misrepresent the network as smaller and more
 * concentrated than it is, which is the sort of quiet wrongness this codebase
 * keeps finding.
 *
 * ── Never influences a spending decision. ──
 */

import type { Db, PeerLocation } from './db';

export interface PeerMapOptions {
  enabled?: boolean;
  /**
   * Lookups per tick. Deliberately small: this is someone else's API, the
   * answer does not change, and a map that fills in over an hour is no worse
   * than one that arrives at once.
   */
  perTick?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface PeerMapState {
  /** Peers we have placed. */
  located: PeerLocation[];
  /** Connected peers, total. */
  connected: number;
  /** Still to look up. Shown, so a partial map is never read as the whole. */
  pending: number;
  /** Asked about and genuinely unplaceable — the observer has no location. */
  unplaceable: number;
}

export class PeerMapFeed {
  private readonly enabled: boolean;
  private readonly perTick: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly db: Db, opts: PeerMapOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.perTick = Math.max(1, opts.perTick ?? 6);
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.swarmscan.io').replace(/\/+$/, '');
  }

  /**
   * Resolve a few unknown peers and return what can be drawn.
   *
   * Never throws: a map is decoration, and a failed lookup must not cost a
   * poll cycle that also renews postage.
   */
  async tick(connectedOverlays: string[]): Promise<PeerMapState> {
    const connected = connectedOverlays.length;
    if (!this.enabled) {
      return { located: [], connected, pending: 0, unplaceable: 0 };
    }

    const known = this.db.peerLocationKnown();
    const unknown = connectedOverlays.filter((o) => !known.has(o));

    for (const overlay of unknown.slice(0, this.perTick)) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/v1/network/nodes/${overlay}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 404) {
          // Not indexed. A real answer — record it so we stop asking.
          this.db.putPeerLocation(overlay, null);
          continue;
        }
        if (!res.ok) continue;   // transient; try again next tick
        const b: any = await res.json();
        // The index says latitude/longitude; storage says lat/lon. Normalised
        // here so the shape of someone else's API stops at this file — and
        // because passing it through unmapped silently marked every peer
        // unplaceable, which looks exactly like "nobody is indexed".
        const l = b?.location;
        this.db.putPeerLocation(overlay, l ? {
          country: l.country ?? null,
          city: l.city ?? null,
          lat: typeof l.latitude === 'number' ? l.latitude : null,
          lon: typeof l.longitude === 'number' ? l.longitude : null,
        } : null);
      } catch {
        // Offline or slow. Leave it unknown rather than recording a miss:
        // "we could not ask" is not "there is no answer".
        break;
      }
    }

    const all = this.db.peerLocations();
    const set = new Set(connectedOverlays);
    // Only peers we are connected to RIGHT NOW. The table accumulates
    // everything ever seen, and drawing old peers would show a network this
    // node no longer has.
    const located = all.filter((p) => set.has(p.overlay));
    const knownAfter = this.db.peerLocationKnown();
    const stillUnknown = connectedOverlays.filter((o) => !knownAfter.has(o)).length;

    return {
      located,
      connected,
      pending: stillUnknown,
      unplaceable: connected - located.length - stillUnknown,
    };
  }
}
