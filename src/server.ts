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
import { staticPlugin } from '@elysiajs/static';
import { existsSync } from 'node:fs';
import { BeeClient } from './bee';
import { Db } from './db';
import { Alerter } from './alerts';
import { Poller } from './poller';
import { authenticate, sha256Hex } from './auth';
import { checkQuota, limitsFor } from './quota';
import { burnRate, quote, depthLadder, recommendDepth, reviewQuote, formatBytes, MIN_DEPTH, MAX_DEPTH } from './wizard';
import { plurToBzz, bzzToPlur, storedBytes, capacityBytes, costPlur } from './math';
import { checkCaps } from './evaluate';
import type { Config } from './config';

export interface ServerDeps {
  cfg: Config;
  bee: BeeClient;
  db: Db;
  alerter: Alerter;
  poller: Poller;
  adminToken: string | null;
}

/** bigint is not JSON-serialisable; render as string to preserve exactness. */
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

export function createServer(deps: ServerDeps) {
  const { cfg, bee, db, alerter, poller, adminToken } = deps;

  const app = new Elysia()
    .onError(({ error, set }) => {
      set.status = (error as any)?.status ?? 500;
      return { error: (error as any)?.message ?? String(error) };
    })

    .get('/health', () => ({ ok: true, lastPollOk: poller.last?.ok ?? null }))

    // ── admin ────────────────────────────────────────────────────────────
    .group('/api/admin', (admin) =>
      admin
        .onBeforeHandle(({ headers, set }) => {
          if (!adminToken) return; // relying on the reverse proxy
          if (headers['x-admin-token'] !== adminToken) {
            set.status = 401;
            return { error: 'admin token required' };
          }
        })

        .get('/state', () => {
          const r = poller.last;
          if (!r) return { ok: false, error: 'no poll completed yet' };
          const batches = r.batches.map((b) => ({
            ...b,
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
        .get('/batches', () => json(db.batches()))

        /**
         * Exclude a batch from management, or put it back. An unmanaged batch is
         * never topped up or diluted and raises no low-TTL or expiry alert — for
         * deliberately short-lived stamps where renewal would be the bug.
         */
        .patch('/batches/:id/managed', ({ params, body, set }) => {
          const managed = (body as any).managed;
          if (!db.setManaged(params.id, managed)) {
            set.status = 404;
            return { error: 'batch not seen yet — it is recorded on the first poll after it exists' };
          }
          return json({ batchId: params.id, managed });
        }, { body: t.Object({ managed: t.Boolean() }) })
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
              message: `Bought depth-${depth} batch "${label ?? ''}" for ${days}d — ${q.costBzz.toFixed(3)} BZZ`,
            });
            return json({ batchId, cost: q });
          } catch (e: any) {
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
        db.recordUpload(app.name, auth.address, bytes.byteLength, reference);
        db.setAppReference(app.name, reference);
        return json({ reference, bytes: bytes.byteLength, remaining: verdict.remaining });
      } catch (e: any) {
        set.status = 502;
        return { error: `upload failed: ${e?.message ?? e}` };
      }
    });

  // The built dashboard, when present. Absent in dev (Vite serves it and
  // proxies /api here) and in a bare API-only deployment.
  const webDist = process.env.WEB_DIST ?? 'web/dist';
  if (existsSync(webDist)) {
    app.use(staticPlugin({ assets: webDist, prefix: '/', indexHTML: true }));
  } else {
    console.log(`[server] no dashboard at ${webDist} — API only`);
  }

  return app;
}
