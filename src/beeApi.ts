/**
 * A Bee-compatible façade.
 *
 * Mirrors the Bee node's own endpoint shapes so an unmodified bee-js client can
 * point at this service instead of at a node:
 *
 *     const bee = new Bee('https://stamps.example.org', {
 *       headers: { 'x-api-key': DEPLOY_KEY },
 *     })
 *     await bee.uploadData(anyBatchId, data)
 *
 * The point is that callers stop tracking batch IDs. bee-js requires one as an
 * argument, so it is accepted and then **ignored**: the API key identifies the
 * app, and the app's own batch is substituted. Honouring a caller-supplied
 * batch would let one app's key spend another app's capacity and would undo the
 * per-app quotas.
 *
 * Only the endpoints a storage client actually needs are implemented — uploads,
 * downloads, stamps, health. Nothing here reaches Bee's wallet, chequebook or
 * stake surface, so exposing this does not expose the node.
 */

import { Elysia } from 'elysia';
import type { BeeClient } from './bee';
import type { Db, AppRow } from './db';
import { hashApiKey, safeEqual } from './auth';
import { checkQuota, limitsFor } from './quota';
import type { Poller } from './poller';

export interface BeeApiDeps {
  bee: BeeClient;
  db: Db;
  poller: Poller;
  /** When set, the catch-all passthrough additionally requires this header. */
  adminToken: string | null;
}

/** Bee's own error shape, so bee-js surfaces failures the way callers expect. */
const beeError = (code: number, message: string) => ({ code, message });

export function createBeeApi({ bee, db, poller, adminToken }: BeeApiDeps) {
  /**
   * Paths the monitor owns and must never hand to the passthrough.
   * `/health` is ours (it reports the monitor's health, not the node's), the
   * dashboard lives at `/`, and `/api/*` is the monitor's own API.
   */
  const OWNED = /^\/(api|health|assets|batch|settings)(\/|$)|^\/$|^\/index\.html$/;
  /** Resolve the calling app from its API key. */
  async function appFor(headers: Record<string, string | undefined>): Promise<AppRow | null> {
    const key = headers['x-api-key'] ?? headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!key) return null;
    return db.appByApiKeyHash(await hashApiKey(key));
  }

  return new Elysia()
    // /health lives in server.ts so there is exactly one definition.
    /**
     * The app's own batch, in Bee's shape, so `getAllPostageBatch()` works and a
     * client can see TTL and usability. Deliberately only the caller's batch —
     * this is not a window onto the node's other stamps.
     */
    .get('/stamps', async ({ headers, set }) => {
      const app = await appFor(headers as any);
      if (!app) { set.status = 401; return beeError(401, 'unknown or missing API key'); }
      const b = poller.last?.batches.find((x) => x.batchID === app.batchId);
      if (!b) return { stamps: [] };
      return {
        stamps: [{
          batchID: b.batchID, utilization: b.utilization, usable: b.usable, label: b.label,
          depth: b.depth, amount: b.amount.toString(), bucketDepth: b.bucketDepth,
          blockNumber: b.blockNumber, immutableFlag: b.immutableFlag, exists: b.exists,
          batchTTL: b.batchTTL, utilizationRatio: b.utilizationRatio,
        }],
      };
    })

    .get('/stamps/:id', async ({ headers, params, set }) => {
      const app = await appFor(headers as any);
      if (!app) { set.status = 401; return beeError(401, 'unknown or missing API key'); }
      // Any id maps to the app's batch: callers do not own batch identity here.
      const b = poller.last?.batches.find((x) => x.batchID === app.batchId);
      if (!b) { set.status = 404; return beeError(404, 'issuer does not exist'); }
      return {
        batchID: b.batchID, utilization: b.utilization, usable: b.usable, label: b.label,
        depth: b.depth, amount: b.amount.toString(), bucketDepth: b.bucketDepth,
        blockNumber: b.blockNumber, immutableFlag: b.immutableFlag, exists: b.exists,
        batchTTL: b.batchTTL, utilizationRatio: b.utilizationRatio,
      };
    })

    // ── uploads ──────────────────────────────────────────────────────────
    .post('/bytes', ({ request, headers, set }) => upload(request, headers as any, set, false))
    .post('/bzz', ({ request, headers, set }) => upload(request, headers as any, set, true))

    // ── downloads: no stamp involved, proxied from the node ──────────────
    .get('/bytes/:ref', ({ params, headers, set }) => download(`/bytes/${params.ref}`, headers as any, set))
    .get('/bzz/:ref', ({ params, headers, set }) => download(`/bzz/${params.ref}`, headers as any, set))
    .get('/bzz/:ref/*', ({ params, headers, set }) =>
      download(`/bzz/${params.ref}/${(params as any)['*'] ?? ''}`, headers as any, set))

    // Everything else on the node — admin only. See passthrough() below.
    .all('/*', passthrough());

  async function upload(
    request: Request,
    headers: Record<string, string | undefined>,
    set: { status?: number | string },
    isBzz: boolean,
  ) {
    const app = await appFor(headers);
    if (!app) { set.status = 401; return beeError(401, 'unknown or missing API key'); }
    if (!app.batchId) { set.status = 503; return beeError(503, `no batch assigned to app "${app.name}"`); }

    const bytes = new Uint8Array(await request.arrayBuffer());
    const verdict = checkQuota(db, app, 'api-key', bytes.byteLength, limitsFor(app, 'api-key'));
    if (!verdict.allowed) { set.status = 429; return beeError(429, verdict.reason); }

    // Note the Swarm-Postage-Batch-Id header a bee-js client sends is ignored:
    // the key already identifies the app, and its batch is authoritative.
    const collection = /^(1|true)$/i.test(String(headers['swarm-collection'] ?? ''));
    try {
      const reference = isBzz
        ? await bee.upload(app.batchId, bytes, {
            name: headers['swarm-index-document'] ? undefined : app.name,
            contentType: headers['content-type'] ?? undefined,
            collection,
            indexDocument: headers['swarm-index-document'],
            errorDocument: headers['swarm-error-document'],
          })
        : await bee.uploadBytes(app.batchId, bytes, headers['content-type'] ?? 'application/octet-stream');
      db.recordUpload(app.name, 'api-key', bytes.byteLength, reference, {
        batchId: app.batchId,
        contentType: headers['content-type'],
      });
      db.setAppReference(app.name, reference);
      return { reference };
    } catch (e: any) {
      set.status = 502;
      return beeError(502, e?.message ?? String(e));
    }
  }

  /**
   * Reads need no stamp and cost nothing but bandwidth. Proxied rather than
   * redirected so a bee-js client configured with one URL works for both
   * directions — and because the node is internal-only, so a redirect would
   * point at something the caller cannot reach.
   */
  async function download(path: string, headers: Record<string, string | undefined>, set: { status?: number | string }) {
    const app = await appFor(headers);
    if (!app) { set.status = 401; return beeError(401, 'unknown or missing API key'); }
    try {
      const res = await bee.raw(path);
      set.status = res.status;
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' },
      });
    } catch (e: any) {
      set.status = 502;
      return beeError(502, e?.message ?? String(e));
    }
  }

  /**
   * Catch-all passthrough to the Bee node — every endpoint, any method.
   *
   * This is deliberately ADMIN-ONLY. It reaches /wallet, /chequebook/*, /stake
   * and POST /stamps/{amount}/{depth}, i.e. everything that taking Bee off
   * Traefik was meant to hide. An app's upload key must never open it, or a
   * per-app deploy credential becomes a wallet-drain credential and the quotas
   * become decorative.
   *
   * It sits behind the reverse proxy's basicauth like the rest of the root
   * path, and behind ADMIN_TOKEN too when that is configured.
   *
   * Registered last so every specific route above wins. bee-js cannot keep a
   * path prefix in its base URL (it rewrites `/api/bee/health` to `/api/bee`),
   * so this has to be at the root rather than namespaced.
   */
  function passthrough() {
    return async ({ request, params, headers, set }: any) => {
      const path = '/' + (params['*'] ?? '');
      if (OWNED.test(path)) { set.status = 404; return beeError(404, 'not found'); }
      // Fails closed for the same reason the admin API does: this reaches
      // /wallet, /chequebook and POST /stamps.
      if (!adminToken) {
        set.status = 503;
        return beeError(503, 'direct node access disabled: no ADMIN_TOKEN configured');
      }
      if (!safeEqual(String(headers['x-admin-token'] ?? ''), adminToken)) {
        set.status = 401;
        return beeError(401, 'admin token required for direct node access');
      }
      const url = new URL(request.url);
      const init: RequestInit = { method: request.method };
      // Forward Swarm-* headers and content-type; drop hop-by-hop and our auth.
      const fwd: Record<string, string> = {};
      for (const [k, v] of request.headers as any) {
        if (/^(swarm-|content-type|accept)/i.test(k)) fwd[k] = v;
      }
      init.headers = fwd;
      if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
      try {
        const res = await bee.raw(path + url.search, init);
        set.status = res.status;
        return new Response(res.body, {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' },
        });
      } catch (e: any) {
        set.status = 502;
        return beeError(502, e?.message ?? String(e));
      }
    };
  }
}
