/**
 * HTTP surface.
 *
 * Two tiers with very different exposure:
 *
 *   /api/admin/*  — dashboard and anything that spends BZZ. Expected to sit
 *                   behind Traefik basicauth on the internal network; an
 *                   ADMIN_TOKEN adds defence in depth so a misconfigured proxy
 *                   does not immediately expose spending endpoints.
 *   /api/apps/*   — the public path dapps call instead of the Bee node. Only
 *                   ever uploads with an app's own batch, gated by quota.
 *
 * Nothing here reaches the Bee node's own API surface: /wallet, /chequebook,
 * /stake and friends stay unreachable from outside, which is what lets the node
 * come off Traefik entirely.
 */

import { Elysia, t } from 'elysia';
import { existsSync } from 'node:fs';
import { BeeClient, BeeIndeterminateError } from './bee';
import { Db } from './db';
import { Alerter } from './alerts';
import { Poller } from './poller';
import { createBeeApi } from './beeApi';
import { authenticate, sha256Hex, safeEqual } from './auth';
import { checkQuota, limitsFor } from './quota';
import { burnRate, quote, depthLadder, recommendDepth, reviewQuote, formatBytes, MIN_DEPTH, MAX_DEPTH } from './wizard';
import { plurToBzz, bzzToPlur, storedBytes, capacityBytes, costPlur } from './math';
import { checkCaps } from './evaluate';
import type { Config } from './config';
import { PriceFeed } from './price';
import { buildGrid, bucketPressure } from './buckets';

export interface ServerDeps {
  cfg: Config;
  bee: BeeClient;
  db: Db;
  alerter: Alerter;
  poller: Poller;
  adminToken: string | null;
  /** Optional fiat quote for display. Omitted in tests; never affects spending. */
  price?: PriceFeed;
}

/**
 * Ceiling on a dashboard upload.
 *
 * Not a quota — the admin is trusted — just a guard so a mis-picked file
 * cannot buffer something enormous into memory, and a reminder that each
 * upload permanently consumes batch capacity.
 */
const MAX_ADMIN_UPLOAD_BYTES = 32 * 1024 * 1024;

/** bigint is not JSON-serialisable; render as string to preserve exactness. */
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createServer(deps: ServerDeps) {
  const { cfg, bee, db, alerter, poller, adminToken } = deps;
  // Disabled feed when none supplied: get() then always resolves null and the
  // dashboard omits fiat, which is exactly the offline behaviour.
  const price$ = deps.price ?? new PriceFeed({ enabled: false });

  const app = new Elysia()
    .onError(({ error, set }) => {
      set.status = (error as any)?.status ?? 500;
      return { error: (error as any)?.message ?? String(error) };
    })

    /**
     * One health endpoint serving two callers: the container healthcheck (any
     * 200) and bee-js `isConnected()`, which looks for Bee's `status: "ok"`.
     * It reports OUR health — if the last poll failed we cannot upload, and
     * claiming ok would tell a client writes will work when they will not.
     */
    .get('/health', () => {
      const ok = poller.last?.ok ?? false;
      return {
        status: ok ? 'ok' : 'degraded',
        version: 'swarm-stamp-monitor',
        apiVersion: '8.1.0',
        lastPollOk: poller.last?.ok ?? null,
      };
    })

    // ── admin ────────────────────────────────────────────────────────────
    .group('/api/admin', (admin) =>
      admin
        /**
         * Fails CLOSED. With no proxy-level auth in front any more, an unset
         * token must disable the admin API rather than open it — these routes
         * buy postage batches. Refusing to serve is a visible outage; serving
         * without auth is a silent one.
         */
        .onBeforeHandle(({ headers, set }) => {
          if (!adminToken) {
            set.status = 503;
            return { error: 'admin API disabled: no ADMIN_TOKEN configured' };
          }
          if (!safeEqual(String(headers['x-admin-token'] ?? ''), adminToken)) {
            set.status = 401;
            return { error: 'admin token required' };
          }
        })

        .get('/state', async () => {
          const r = poller.last;
          if (!r) return { ok: false, error: 'no poll completed yet' };
          // Display only, and allowed to be null — see src/price.ts. Awaited
          // here rather than in the poller so the figure is fresh on a manual
          // refresh, but it is cached and never throws, so it cannot delay or
          // fail this response in any meaningful way.
          const price = await price$.get();
          const unmanaged = db.unmanagedBatchIds();
          const batches = r.batches.map((b) => ({
            ...b,
            managed: !unmanaged.has(b.batchID),
            storedBytes: storedBytes(b.utilizationRatio, b.depth).toString(),
            capacityBytes: capacityBytes(b.depth).toString(),
            storedHuman: formatBytes(storedBytes(b.utilizationRatio, b.depth)),
            capacityHuman: formatBytes(capacityBytes(b.depth)),
            ttlDays: b.batchTTL / 86_400,
          }));
          return json({
            ok: r.ok,
            error: r.error ?? null,
            msPerBlock: r.msPerBlock,
            burnPer30DaysBzz: r.burnPer30DaysBzz,
            runwayDays: r.runwayDays,
            wallet: r.wallet && {
              bzz: plurToBzz(r.wallet.bzzBalance),
              xdai: Number(r.wallet.nativeTokenBalance) / 1e18,
              address: r.wallet.walletAddress,
            },
            chain: r.chain && { block: r.chain.block, price: r.chain.currentPrice.toString() },
            /** Fiat quote for BZZ, or null when unavailable. Never used in any calculation that spends. */
            fiat: price && {
              usd: price.usd, eur: price.eur,
              usd24hChange: price.usd24hChange,
              fetchedAt: price.fetchedAt,
            },
            batches,
            plans: r.plans,
            config: {
              autoTopupEnabled: cfg.autoTopupEnabled,
              dryRun: cfg.dryRun,
              topupWhenTtlBelowDays: cfg.topupWhenTtlBelowSec / 86_400,
              topupTargetTtlDays: cfg.topupTargetTtlSec / 86_400,
            },
          });
        })

        .get('/actions', ({ query }) => json(db.recentActions(Number(query.limit ?? 100))))
        .get('/apps', () => json(db.apps()))
        /** Which apps share which batch — check before retiring either. */
        .get('/apps/by-batch', () => json(db.appsByBatch()))

        /**
         * Remove an app from the registry.
         *
         * Registry-only: the batch is untouched. Apps may share a batch, so
         * deleting one must not abandon a stamp another is still uploading
         * with — retiring a batch is a separate act (PATCH .../managed).
         * The response says which batch is now possibly unreferenced so the
         * caller can decide.
         */
        .delete('/apps/:name', ({ params, set }) => {
          const app = db.app(params.name);
          if (!app) { set.status = 404; return { error: `unknown app "${params.name}"` }; }
          db.deleteApp(params.name);
          const stillUsing = app.batchId
            ? db.apps().filter((a) => a.batchId === app.batchId).map((a) => a.name)
            : [];
          return json({
            deleted: params.name,
            batchId: app.batchId,
            batchUntouched: true,
            otherAppsOnThatBatch: stillUsing,
            note: app.batchId && stillUsing.length === 0
              ? 'No app references that batch now. It is still live and still managed — retire it explicitly if you want it to lapse.'
              : undefined,
          });
        })

        .get('/batches', () => json(db.batches()))

        /**
         * Upload straight to one batch, from the dashboard.
         *
         * Unlike /api/apps/* this is not quota'd per app — it is the admin
         * acting directly on a batch they picked. It still spends real,
         * unrecoverable capacity: stamps consumed cannot be reclaimed, and on
         * an immutable batch the bucket slots are gone for the batch's life.
         * It also publishes: anything uploaded is retrievable by anyone
         * holding the reference. The UI says both things next to the button.
         */
        .post('/batches/:id/upload', async ({ params, request, query, set }) => {
          const b = poller.last?.batches.find((x) => x.batchID === params.id);
          if (!b) { set.status = 404; return { error: 'unknown batch' }; }
          if (!b.usable) { set.status = 409; return { error: 'batch is not usable' }; }

          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength === 0) { set.status = 400; return { error: 'empty body' }; }
          if (bytes.byteLength > MAX_ADMIN_UPLOAD_BYTES) {
            set.status = 413;
            return { error: `upload is ${formatBytes(BigInt(bytes.byteLength))}, over the ${formatBytes(BigInt(MAX_ADMIN_UPLOAD_BYTES))} limit` };
          }

          const name = typeof query.name === 'string' ? query.name : undefined;
          try {
            const reference = await bee.upload(params.id, bytes, {
              name,
              contentType: request.headers.get('content-type') ?? 'application/octet-stream',
            });
            db.recordUpload(`admin:${b.label || params.id.slice(0, 8)}`, 'dashboard', bytes.byteLength, reference, {
              batchId: params.id,
              name,
              contentType: request.headers.get('content-type') ?? undefined,
            });
            return json({ reference, bytes: bytes.byteLength, name: name ?? null });
          } catch (e: any) {
            set.status = 502;
            return { error: e?.message ?? String(e) };
          }
        })

        /**
         * Fetch uploaded content back through the monitor.
         *
         * The Bee node is not reachable from outside, so a stored reference is
         * only useful if something here can retrieve it. Reads cost nothing and
         * touch no stamp — this is a proxy, not a second upload path.
         */
        .get('/content/:ref', async ({ params, query, set }) => {
          if (!/^[0-9a-fA-F]{64,128}$/.test(params.ref)) {
            set.status = 400; return { error: 'not a swarm reference' };
          }
          try {
            const res = await bee.raw(`/bzz/${params.ref}`);
            const name = typeof query.name === 'string' ? query.name : null;
            const headers: Record<string, string> = {
              'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
            };
            // Only when asked: without this the browser renders images and text
            // inline, which is what you want for a quick look.
            if (query.download != null && name) {
              headers['content-disposition'] = `attachment; filename="${name.replace(/["\r\n]/g, '')}"`;
            }
            set.status = res.status;
            return new Response(res.body, { status: res.status, headers });
          } catch (e: any) {
            set.status = 502;
            return { error: e?.message ?? String(e) };
          }
        })

        /** What has been uploaded with this batch, newest first. */
        .get('/batches/:id/uploads', ({ params, query }) =>
          json(db.uploadsForBatch(params.id, Math.min(500, Number(query.limit ?? 100))))) 

        /**
         * Per-bucket occupancy for one batch — the data behind the grid.
         *
         * Fetched on demand rather than in the poll loop: it is 65,536 entries
         * per batch and only matters when someone is looking at it. The poller
         * stays cheap and this stays exact.
         */
        .get('/batches/:id/buckets', async ({ params, set }) => {
          const b = poller.last?.batches.find((x) => x.batchID === params.id);
          try {
            const grid = buildGrid(await bee.buckets(params.id));
            return json({
              ...grid,
              label: b?.label ?? '',
              immutable: b?.immutableFlag ?? false,
              pressure: bucketPressure(grid, b?.immutableFlag ?? false),
            });
          } catch (e: any) {
            set.status = e?.status === 404 ? 404 : 502;
            return { error: e?.message ?? String(e) };
          }
        })

        /**
         * Edit a batch: its label and/or whether it is managed.
         *
         * `label` is written through to Bee, because the label lives on the node
         * and other tools discover batches by it. `managed` is local-only — an
         * unmanaged batch is never topped up or diluted and raises no low-TTL or
         * expiry alert, for short-lived stamps where renewal would be the bug.
         *
         * Deliberately NOT coupled: renaming a batch to the unmanaged prefix does
         * not change whether it is managed. A rename silently altering spending
         * behaviour is the kind of hidden coupling that surprises people later —
         * the UI suggests it instead.
         */
        .patch('/batches/:id', async ({ params, body, set }) => {
          const { label, managed } = body as { label?: string; managed?: boolean };
          if (label === undefined && managed === undefined) {
            set.status = 400;
            return { error: 'provide label, managed, or both' };
          }
          if (!db.batches().some((b) => b.batchId === params.id)) {
            set.status = 404;
            return { error: 'batch not seen yet — it is recorded on the first poll after it exists' };
          }

          // Bee first: if the node rejects the rename, the local row must not be
          // updated, or the dashboard would show a name the node does not have.
          if (label !== undefined) {
            try {
              await bee.setLabel(params.id, label);
            } catch (e: any) {
              set.status = 502;
              return { error: `bee rejected the rename: ${e?.message ?? e}` };
            }
            db.setLabel(params.id, label);
          }
          if (managed !== undefined) db.setManaged(params.id, managed);

          return json(db.batches().find((b) => b.batchId === params.id));
        }, {
          body: t.Object({
            label: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
            managed: t.Optional(t.Boolean()),
          }),
        })
        .post('/poll', async () => json(await poller.tick()))

        // The slider surface: one quote per depth at the chosen duration.
        .get('/wizard/ladder', ({ query }) => {
          const r = poller.last;
          if (!r?.ok || !r.chain || !r.wallet) return { error: 'no poll data yet' };
          const days = Math.max(1, Number(query.days ?? 30));
          const rate = burnRate(r.batches, r.chain, r.msPerBlock);
          const ladder = depthLadder(rate, days, r.wallet.bzzBalance, 0n, MIN_DEPTH, MAX_DEPTH);
          const stored = query.storedBytes ? BigInt(query.storedBytes as string) : 0n;
          return json({
            days,
            recommended: stored > 0n ? recommendDepth(stored) : null,
            ladder: ladder.map((q) => ({
              ...q,
              capacityHuman: formatBytes(q.capacityBytes),
              warnings: stored > 0n ? reviewQuote(q, stored, r.wallet!.bzzBalance) : [],
            })),
          });
        })

        // Buy a batch. Guarded by the same caps the daemon obeys.
        .post('/wizard/buy', async ({ body, set }) => {
          const r = poller.last;
          if (!r?.ok || !r.chain || !r.wallet) { set.status = 503; return { error: 'no poll data yet' }; }
          const { depth, days, label, immutable, confirm } = body as any;
          if (depth <= 16) { set.status = 400; return { error: 'depth must exceed the bucket depth of 16' }; }

          const rate = burnRate(r.batches, r.chain, r.msPerBlock);
          const q = quote(rate, depth, days, r.wallet.bzzBalance);
          const warnings = reviewQuote(q, 0n, r.wallet.bzzBalance);

          // Two-step by design: the first call prices it, the second commits.
          if (!confirm) return json({ preview: q, warnings, confirmRequired: true });

          const verdict = checkCaps(q.costPlur, {
            config: cfg, wallet: r.wallet, chain: r.chain,
            spentLast24h: db.spentLast24h(), inFlight: db.inFlightBatchIds(), msPerBlock: r.msPerBlock,
          });
          if (!verdict.allowed) { set.status = 403; return { error: `blocked by caps: ${verdict.reason}` }; }
          if (cfg.dryRun) return json({ dryRun: true, wouldBuy: q });

          const id = db.recordAction({
            batchId: null, appName: label ?? null, kind: 'buy',
            amount: q.amountPerChunk, cost: q.costPlur, status: 'submitted',
            reason: `manual buy: depth ${depth}, ${days}d`, error: null,
          });
          try {
            const batchId = await bee.buyBatch(q.amountPerChunk, depth, { label, immutable });
            db.updateActionStatus(id, 'confirmed');
            if (label) db.setAppBatch(label, batchId);
            await alerter.send({
              event: 'batch_bought', level: 'info', batchId, costBzz: q.costBzz,
              message: `Bought depth-${depth} batch "${label ?? ''}" for ${days}d — ${q.costBzz.toFixed(3)} xBZZ`,
            });
            return json({ batchId, cost: q });
          } catch (e: any) {
            if (e instanceof BeeIndeterminateError) {
              // Stays `submitted`, and the response says so — the batch may
              // appear on the node minutes later. Retrying buys a second one.
              set.status = 504;
              return {
                error: e.message,
                indeterminate: true,
                advice: 'Do not retry. Check GET /api/admin/batches after the next poll.',
              };
            }
            db.updateActionStatus(id, 'failed', e?.message ?? String(e));
            set.status = 502;
            return { error: e?.message ?? String(e) };
          }
        }, {
          body: t.Object({
            depth: t.Number(), days: t.Number(),
            label: t.Optional(t.String()), immutable: t.Optional(t.Boolean()),
            confirm: t.Optional(t.Boolean()),
          }),
        })

        .post('/apps', ({ body }) => {
          const b = body as any;
          db.upsertApp({
            name: b.name, policy: b.policy, depth: b.depth, durationDays: b.durationDays,
            batchId: b.batchId ?? null, budgetPlurPerDay: bzzToPlur(b.budgetBzzPerDay ?? '0'),
            ensName: b.ensName ?? null, apiKeyHash: b.apiKeyHash ?? null,
          });
          return json(db.app(b.name));
        }, {
          body: t.Object({
            name: t.String(), policy: t.Union([t.Literal('ephemeral'), t.Literal('permanent')]),
            depth: t.Number(), durationDays: t.Number(),
            batchId: t.Optional(t.String()), budgetBzzPerDay: t.Optional(t.String()),
            ensName: t.Optional(t.String()), apiKeyHash: t.Optional(t.String()),
          }),
        }),
    )

    // ── public: what dapps call instead of the Bee node ──────────────────
    .get('/api/apps/:name/stamp', ({ params, set }) => {
      const app = db.app(params.name);
      if (!app?.batchId) { set.status = 404; return { error: 'no batch assigned to this app' }; }
      const batch = poller.last?.batches.find((b) => b.batchID === app.batchId);
      if (!batch) { set.status = 404; return { error: 'assigned batch is not present on the node' }; }
      return json({
        batchId: batch.batchID, usable: batch.usable,
        ttlSeconds: batch.batchTTL, ttlDays: batch.batchTTL / 86_400,
        utilizationRatio: batch.utilizationRatio, depth: batch.depth,
      });
    })

    .post('/api/apps/:name/upload', async ({ params, request, headers, set }) => {
      const app = db.app(params.name);
      if (!app) { set.status = 404; return { error: `unknown app "${params.name}"` }; }
      if (!app.batchId) { set.status = 503; return { error: 'app has no batch assigned yet' }; }

      const bytes = new Uint8Array(await request.arrayBuffer());
      const contentSha256 = await sha256Hex(bytes);

      const auth = await authenticate({
        app: params.name,
        contentSha256,
        address: headers['x-address'],
        signature: headers['x-signature'],
        timestamp: headers['x-timestamp'] ? Number(headers['x-timestamp']) : undefined,
        apiKey: headers['x-api-key'],
      }, app.apiKeyHash);
      if (!auth.ok) { set.status = 401; return { error: auth.reason }; }

      const verdict = checkQuota(db, app, auth.address, bytes.byteLength, limitsFor(app, auth.via));
      if (!verdict.allowed) {
        set.status = 429;
        if (verdict.appBudgetExhausted) {
          await alerter.send({
            event: 'quota_exceeded', level: 'warn', app: app.name,
            message: `${app.name} hit its daily upload budget: ${verdict.reason}`,
          });
        }
        return { error: verdict.reason, remaining: verdict.remaining };
      }

      // Collection upload: a tar of a built site, so `make deploy-frontend` can
      // post here instead of to the Bee node — which is what lets Bee stay off
      // the public internet. Header names mirror Bee's own so existing deploy
      // scripts only need their URL changed.
      const collection = /^(1|true|yes)$/i.test(String(headers['swarm-collection'] ?? ''));

      try {
        const reference = await bee.upload(app.batchId, bytes, {
          name: (headers['x-filename'] as string) || app.name,
          contentType: (headers['x-content-type'] as string)
            || (collection ? 'application/x-tar' : 'application/octet-stream'),
          collection,
          indexDocument: (headers['swarm-index-document'] as string) || undefined,
          errorDocument: (headers['swarm-error-document'] as string) || undefined,
        });
        db.recordUpload(app.name, auth.address, bytes.byteLength, reference, {
          batchId: app.batchId,
          name: (headers['x-filename'] as string) || undefined,
          contentType: (headers['x-content-type'] as string) || undefined,
        });
        db.setAppReference(app.name, reference);
        return json({ reference, bytes: bytes.byteLength, remaining: verdict.remaining });
      } catch (e: any) {
        set.status = 502;
        return { error: `upload failed: ${e?.message ?? e}` };
      }
    });

  // The dashboard, served as explicit routes rather than a static-plugin
  // catch-all. The plugin claims every unmatched path and 404s it, which would
  // swallow the Bee passthrough below; naming the three real paths keeps
  // precedence deterministic.
  const webDist = process.env.WEB_DIST ?? 'web/dist';

  /**
   * The root must always answer 200: bee-js's `isConnected()` probes the base
   * URL itself, not /health (verified against bee-js v11 — it GETs `/`). If the
   * dashboard is not built, serve a small status document instead so a client
   * pointed here still reports connected.
   */
  if (!existsSync(webDist)) {
    app.get('/', () => ({ status: 'ok', service: 'swarm-stamp-monitor', dashboard: false }));
  }

  if (existsSync(webDist)) {
    const index = () => new Response(Bun.file(`${webDist}/index.html`), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    app.get('/', index);
    app.get('/index.html', index);
    /**
     * Client-side route for a single batch. Declared explicitly rather than as
     * a catch-all SPA fallback: everything not matched here falls through to
     * the Bee passthrough, and a broad fallback would shadow node endpoints
     * the façade is supposed to forward.
     */
    app.get('/batch/:id', index);
    app.get('/assets/*', ({ params, set }: any) => {
      const file = Bun.file(`${webDist}/assets/${params['*']}`);
      set.status = 200;
      return new Response(file);
    });
  } else {
    console.log(`[server] no dashboard at ${webDist} — API only`);
  }

  // Bee-compatible façade + admin-only passthrough. Registered LAST so every
  // route above wins; bee-js cannot keep a path prefix, so this must be at root.
  app.use(createBeeApi({ bee, db, poller, adminToken }));

  return app;
}
