/**
 * Where THIS node is.
 *
 * The peer map deliberately did not plot it. That was the right default while
 * the only available position would have been a guess: one made-up dot among
 * real ones is worse than an absent dot, because nothing on screen says which
 * is which. Asked for explicitly, it needs a real reading — so this resolves
 * one, and reports nothing at all when it cannot.
 *
 * ── Two sources, in order of authority ──
 *
 *   1. The same index that places the peers, by our own overlay. Free,
 *      consistent with every other dot on the map, and requires no new
 *      third party. It currently returns no location for this node, so in
 *      practice it is the fallback that answers.
 *   2. Geolocating the public address the node itself advertises. This is
 *      the node's real address — the one peers dial — read from Bee's own
 *      /addresses rather than assumed from wherever this process happens to
 *      run. Those can differ, and using the monitor's own IP would silently
 *      plot the wrong machine.
 *
 * ── This publishes an approximate location ──
 *
 * A home node's public IP geolocates to its town. That address is already
 * known to every peer that dials it, but /api/public/state is unauthenticated,
 * which makes it harvestable by someone who never joined the network. Hence
 * PEER_MAP_SELF=false, and hence coordinates only — no ISP, no region, no
 * address, none of which the map needs.
 *
 * ── Never influences a spending decision. ──
 */

import type { PeerLocation } from './db';

/** RFC1918, loopback, link-local, CGNAT — anything that is not routable. */
function isPrivate(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);   // CGNAT: routable-looking, not reachable
}

/**
 * The one address on the list that the outside world can reach.
 *
 * Bee advertises everything it can see — docker bridges, the LAN, loopback,
 * and the real WAN address together. Picking the first would plot the node in
 * a private range, which geolocates to nothing or, worse, to the geographic
 * centre of a country.
 */
export function publicIpv4(underlay: string[] | undefined): string | null {
  for (const addr of underlay ?? []) {
    const m = /^\/ip4\/(\d+\.\d+\.\d+\.\d+)\//.exec(addr);
    if (m && !isPrivate(m[1])) return m[1];
  }
  return null;
}

export interface SelfLocOptions {
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Long: a node does not move. Re-read only to survive a relocation. */
  ttlMs?: number;
  swarmscanBase?: string;
  geoBase?: string;
}

export class SelfLocationFeed {
  private cached: PeerLocation | null = null;
  private fetchedAt = 0;

  private readonly enabled: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly swarmscanBase: string;
  private readonly geoBase: string;

  constructor(opts: SelfLocOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.ttlMs = opts.ttlMs ?? 12 * 3_600_000;
    this.swarmscanBase = (opts.swarmscanBase ?? 'https://api.swarmscan.io').replace(/\/+$/, '');
    this.geoBase = (opts.geoBase ?? 'http://ip-api.com').replace(/\/+$/, '');
  }

  get last(): PeerLocation | null {
    return this.cached;
  }

  /**
   * Never throws, and never invents. A node that cannot be placed returns
   * null, and the map draws no dot and no lines rather than a plausible one.
   */
  async get(
    overlay: string | undefined,
    underlay: string[] | undefined,
    now = Date.now(),
  ): Promise<PeerLocation | null> {
    if (!this.enabled) return null;
    if (this.cached && now - this.fetchedAt < this.ttlMs) return this.cached;

    const found = (await this.viaIndex(overlay)) ?? (await this.viaAddress(underlay));
    if (found) { this.cached = found; this.fetchedAt = now; }
    // A failed lookup keeps the last good position rather than making the node
    // vanish off the map on one bad request.
    return this.cached;
  }

  private async viaIndex(overlay: string | undefined): Promise<PeerLocation | null> {
    if (!overlay) return null;
    try {
      const res = await this.fetchImpl(`${this.swarmscanBase}/v1/network/nodes/${overlay}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return null;
      const l: any = (await res.json())?.location;
      if (typeof l?.latitude !== 'number' || typeof l?.longitude !== 'number') return null;
      return {
        overlay, country: l.country ?? null, city: l.city ?? null,
        lat: l.latitude, lon: l.longitude,
      };
    } catch { return null; }
  }

  private async viaAddress(underlay: string[] | undefined): Promise<PeerLocation | null> {
    const ip = publicIpv4(underlay);
    if (!ip) return null;
    try {
      // Only the fields the map draws. Asking for the ISP or the region would
      // put them in a public response for no gain.
      const res = await this.fetchImpl(
        `${this.geoBase}/json/${ip}?fields=status,country,city,lat,lon`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!res.ok) return null;
      const d: any = await res.json();
      if (d?.status !== 'success' || typeof d.lat !== 'number' || typeof d.lon !== 'number') return null;
      return { overlay: 'self', country: d.country ?? null, city: d.city ?? null, lat: d.lat, lon: d.lon };
    } catch { return null; }
  }
}
