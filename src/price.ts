/**
 * Fiat price for BZZ, for display only.
 *
 * ── This must never influence a spending decision. ──
 *
 * Every cap, threshold and top-up amount in this service is denominated in BZZ
 * and PLUR, and that is deliberate: those are the units the batch is actually
 * priced in, and they stay correct whether or not a third-party price API is
 * up, honest, or returning a number in the currency it claims. Converting to
 * fiat anywhere in `evaluate.ts` would mean an outage or a bad tick at
 * CoinGecko could move a real spend limit. So the price lives here, is read
 * only by the presentation layer, and is allowed to be `null` at any moment.
 *
 * `null` is a normal state, not an error: no network, a rate-limit, a slow
 * response, or PRICE_ENABLED=false all produce it, and the dashboard simply
 * omits the fiat column. Nothing retries hard and nothing logs loudly, because
 * a missing decorative number is not an incident.
 *
 * Note on xBZZ: the dashboard labels the balance xBZZ because that is what is
 * on Gnosis, but the quote is for BZZ. The bridged token is redeemable 1:1 for
 * mainnet BZZ, so the price is the same asset; there is no separate liquid
 * market for the bridged form worth quoting.
 */

/** CoinGecko's id for Swarm. Confirmed via /api/v3/search?query=bzz. */
const COINGECKO_ID = 'swarm-bzz';

export interface Price {
  usd: number;
  eur: number;
  /** Percent change over 24h, as reported upstream. */
  usd24hChange: number;
  /** When this quote was fetched (epoch ms), so the UI can show staleness. */
  fetchedAt: number;
}

export interface PriceOptions {
  enabled?: boolean;
  /** Serve a cached quote for this long before fetching again. */
  ttlMs?: number;
  /** Kept short: this is decorative, and must not stall a poll cycle. */
  timeoutMs?: number;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * A price with a cache in front of it.
 *
 * The cache exists mainly to be a good citizen: the poll interval is 5 minutes
 * but the dashboard also refreshes on demand, and CoinGecko's free tier is
 * rate-limited. It also means a brief upstream failure keeps showing the last
 * known figure rather than blanking the column.
 */
export class PriceFeed {
  private cached: Price | null = null;
  private inflight: Promise<Price | null> | null = null;

  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: PriceOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.coingecko.com').replace(/\/+$/, '');
  }

  /** The last quote, without fetching. */
  get last(): Price | null {
    return this.cached;
  }

  /**
   * A quote, fetching only if the cache has expired. Never throws and never
   * rejects — callers treat `null` as "no fiat figure available right now".
   * Concurrent callers share one in-flight request.
   */
  async get(now = Date.now()): Promise<Price | null> {
    if (!this.enabled) return null;
    if (this.cached && now - this.cached.fetchedAt < this.ttlMs) return this.cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchQuote(now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchQuote(now: number): Promise<Price | null> {
    const url =
      `${this.baseUrl}/api/v3/simple/price` +
      `?ids=${COINGECKO_ID}&vs_currencies=usd,eur&include_24hr_change=true`;
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return this.cached;
      const body: any = await res.json();
      const q = body?.[COINGECKO_ID];
      // Guard every field: a malformed or partial response must not put NaN on
      // the dashboard, and must not evict a good cached quote.
      const usd = Number(q?.usd);
      const eur = Number(q?.eur);
      if (!Number.isFinite(usd) || usd <= 0) return this.cached;
      const price: Price = {
        usd,
        eur: Number.isFinite(eur) && eur > 0 ? eur : 0,
        usd24hChange: Number.isFinite(Number(q?.usd_24h_change)) ? Number(q.usd_24h_change) : 0,
        fetchedAt: now,
      };
      this.cached = price;
      return price;
    } catch {
      // Offline, rate-limited, or slow. Keep whatever we had.
      return this.cached;
    }
  }
}
