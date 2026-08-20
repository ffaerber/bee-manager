/**
 * HTTP surface.
 *
 * Three tiers with very different exposure:
 *
 *   /api/public/* — no credentials. A read-only view of the node and its
 *                   batches, so the thing can be shown to people who have no
 *                   business spending from it. Built by removing fields from
 *                   the admin payload, so a new field is private until
 *                   published on purpose.
 *   /api/admin/*  — dashboard and anything that spends BZZ. ADMIN_TOKEN is the
 *                   whole protection, not defence in depth behind a proxy, so
 *                   it is checked at onRequest — before body validation, which
 *                   otherwise answered anonymous callers with a schema.
 *   /api/apps/*   — the path dapps and CI call instead of the Bee node. Uploads
 *                   only with the batch its key names, gated by quota; the
 *                   batch id a caller supplies is ignored.
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
import { authenticate, sha256Hex, safeEqual, hashApiKey } from './auth';
import { checkQuota, limitsFor } from './quota';
import { burnRate, quote, depthLadder, recommendDepth, reviewQuote, formatBytes, MIN_DEPTH, MAX_DEPTH } from './wizard';
import { plurToBzz, bzzToPlur, storedBytes, capacityBytes, costPlur, amountForDuration } from './math';
import { checkCaps, policyFor, fullnessOf, fullnessMessage, type Fullness } from './evaluate';
import type { Config } from './config';
import { PriceFeed } from './price';
import { buildGrid, bucketPressure } from './buckets';
import { EDITABLE, applySettings, envValue, isLoosening, riskOf } from './settings';

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
 * Which build this is, stamped into the image by CI.
 *
 * Exists because "is the dashboard I am looking at the one I just deployed?"
 * had no answer short of diffing hashed asset filenames against a local build.
 * A stale page and a current one looked identical, which is a bad property for
 * a page whose whole job is telling you the truth about a node.
 */
export const BUILD = {
  sha: (process.env.BUILD_SHA || 'dev').slice(0, 7),
  time: process.env.BUILD_TIME || null,
};

/** bigint is not JSON-serialisable; render as string to preserve exactness. */
const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));


/**
 * After a write, re-read the batch and report what room is left.
 *
 * An upload is the ONLY thing that consumes bucket space, so fullness is
 * write-driven and does not belong on a timer. Waiting for the 5-minute poll
 * meant an immutable batch could sit full for minutes, refusing uploads, with
 * nothing saying why. One cheap `/stamps/{id}` read closes that window.
 *
 * Never throws and never fails the upload: the bytes are already stamped and
 * paid for by the time this runs. A failed refresh costs a late warning, not
 * a lost file.
 */
async function fullnessAfterUpload(
  deps: { poller: any; db: any; alerter: any; cfg: any },
  batchId: string,
): Promise<{ fullness: Fullness; message: string | null }> {
  try {
    await deps.poller.refreshBatch(batchId);
    const b = deps.poller.last?.batches.find((x: any) => x.batchID === batchId);
    if (!b) return { fullness: 'ok', message: null };

    // Same source the poller uses (there is no single-batch accessor), so a
    // per-batch dilute override is honoured here exactly as it is on a tick.
    const row = deps.db.batches().find((r: any) => r.batchId === batchId);
    const p = policyFor(deps.cfg, row ? {
      topupBelowDays: row.topupBelowDays,
      topupTargetDays: row.topupTargetDays,
      diluteAbove: row.diluteAbove,
      maxDiluteDepth: row.maxDiluteDepth,
    } : null);
    const fullness = fullnessOf(b, p.diluteWhenUtilizationAbove);
    const message = fullnessMessage(b, fullness);

    if (fullness === 'full' && message) {
      // Deduped by the alerter's cooldown, so a busy batch does not spam.
      await deps.alerter.send({
        event: 'batch_full', level: 'warn', batchId, message,
        details: { utilizationRatio: b.utilizationRatio, depth: b.depth, immutable: b.immutableFlag },
      });
    }
    return { fullness, message };
  } catch {
    return { fullness: 'ok', message: null };
  }
}

export function createServer(deps: ServerDeps) {
  const { cfg, bee, db, alerter, poller, adminToken } = deps;
  // Disabled feed when none supplied: get() then always resolves null and the
  // dashboard omits fiat, which is exactly the offline behaviour.
  const price$ = deps.price ?? new PriceFeed({ enabled: false });

  /**
   * The caps as they actually stand, env overlaid with the stored settings.
   *
   * Every spend path must read this and not `cfg`. The poller already did, but
   * the manual top-up and the buy wizard used the raw env config, so a cap
   * edited on the Settings page bound the daemon and not the two paths a human
   * drives — the page told the truth about one caller and not the others.
   *
   * The direction that matters is tightening. Lowering a cap to hold something
   * back would have kept showing the stricter number while still permitting the
   * looser env value, which is the sort of guard that is only discovered to be
   * decorative afterwards.
   */
  const effective = () => applySettings(cfg, db.settings());

  /**
   * The dashboard payload. Shared by the admin route and the public one, so
   * the two can never drift into disagreeing about the same node.
   */
  const stateFull = async () => {
        const r = poller.last;
        if (!r) return { ok: false, error: 'no poll completed yet' };
        // Display only, and allowed to be null — see src/price.ts. Awaited
        // here rather than in the poller so the figure is fresh on a manual
        // refresh, but it is cached and never throws, so it cannot delay or
        // fail this response in any meaningful way.
        const price = await price$.get();
        const unmanaged = db.unmanagedBatchIds();
        const rows = new Map(db.batches().map((x) => [x.batchId, x]));
        const batches = r.batches.map((b) => {
          const row = rows.get(b.batchID);
          return ({
          ...b,
          managed: !unmanaged.has(b.batchID),
          /** Overrides as stored: null means this batch follows the global. */
          policy: {
            topupBelowDays: row?.topupBelowDays ?? null,
            topupTargetDays: row?.topupTargetDays ?? null,
            diluteAbove: row?.diluteAbove ?? null,
            maxDiluteDepth: row?.maxDiluteDepth ?? null,
          },
          /** What is actually in force, after falling back to the globals. */
          effective: policyFor(cfg, row ?? null),
          storedBytes: storedBytes(b.utilizationRatio, b.depth).toString(),
          capacityBytes: capacityBytes(b.depth).toString(),
          storedHuman: formatBytes(storedBytes(b.utilizationRatio, b.depth)),
          capacityHuman: formatBytes(capacityBytes(b.depth)),
          ttlDays: b.batchTTL / 86_400,
        });
        });
        return json({
          build: BUILD,
          ok: r.ok,
          error: r.error ?? null,
          msPerBlock: r.msPerBlock,
          burnPer30DaysBzz: r.burnPer30DaysBzz,
          committedBzz: r.committedBzz,
          /**
           * How stale this snapshot is, measured entirely on the server
           * clock at request time. Sent as an AGE rather than a timestamp on
           * purpose: a client counting down needs to know how far the figure
           * has already run, and an age is immune to the browser's clock
           * being wrong, where comparing two absolute timestamps is not.
           */
          dataAgeMs: Math.max(0, Date.now() - r.polledAt),
          chequebook: r.chequebook ?? null,
          /**
           * Explicitly null, not Infinity.
           *
           * runwaySeconds() returns Infinity when nothing is burning, and
           * JSON.stringify turns that into null on the wire regardless. The
           * client's global isFinite() then reads null as 0 and reports a
           * critical, zero-day runway on a node that has nothing to burn.
           * Normalising here makes the wire contract match the type.
           */
          runwayDays: isFinite(r.runwayDays) ? r.runwayDays : null,
          totalRunwayDays: isFinite(r.totalRunwayDays) ? r.totalRunwayDays : null,
          wallet: r.wallet && {
            bzz: plurToBzz(r.wallet.bzzBalance),
            xdai: Number(r.wallet.nativeTokenBalance) / 1e18,
            address: r.wallet.walletAddress,
            chainId: r.wallet.chainID,
            chequebookAddress: r.wallet.chequebookContractAddress,
            /** Held in the chequebook for bandwidth — NOT spendable on postage. */
            chequebookBzz: r.node?.chequebookBalance != null ? plurToBzz(r.node.chequebookBalance) : null,
            chequebookAvailableBzz: r.node?.chequebookAvailable != null ? plurToBzz(r.node.chequebookAvailable) : null,
            /** Locked in the staking contract — also not spendable on postage. */
            stakedBzz: r.node?.stakedAmount != null ? plurToBzz(r.node.stakedAmount) : null,
          },
          node: r.node && {
            healthy: r.node.healthy, version: r.node.version,
            beeMode: r.node.beeMode, peers: r.node.peers ?? null,
            storageRadius: r.node.storageRadius ?? null,
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
  };

  /**
   * What an anonymous visitor gets.
   *
   * Built by REMOVING from the full payload rather than by assembling a second
   * one: a new field added to stateFull() is then private until someone
   * deliberately publishes it, which is the safe direction for a page that
   * anyone can open. The reverse — an allowlist rebuilt by hand — leaks by
   * omission the moment the two drift.
   *
   * Batches, node and wallet stay: all of it is already on-chain or derivable
   * from it, and it is the point of publishing the page. What goes is anything
   * describing INTENT rather than state — the planner's next moves and the caps
   * and thresholds behind them, which tell a reader what this node will do
   * automatically and how much it will spend doing it.
   */
  const statePublic = async () => {
    const full: any = await stateFull();
    if (!full || full.ok === false) return full;
    const { plans, config, ...rest } = full;
    return {
      ...rest,
      batches: (rest.batches ?? []).map((b: any) => {
        const { policy, effective, ...keep } = b;
        return keep;
      }),
      readOnly: true,
    };
  };


  const app = new Elysia()
    /**
     * Admin auth, enforced at the earliest hook there is.
     *
     * The group's own onBeforeHandle runs AFTER body validation, so an
     * anonymous POST to a route with a schema was answered with 422 and the
     * shape it expected, rather than 401. Nothing could be spent that way --
     * the handler never ran -- but describing your admin API to strangers is
     * not a thing to do by accident, and "validated, then rejected" is the
     * wrong order for anything that buys postage.
     *
     * The per-group check stays as well: this one is a gate, not a substitute.
     */
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/admin')) return;
      if (!adminToken) {
        set.status = 503;
        return { error: 'admin API disabled: no ADMIN_TOKEN configured' };
      }
      if (!safeEqual(String(request.headers.get('x-admin-token') ?? ''), adminToken)) {
        set.status = 401;
        return { error: 'admin token required' };
      }
    })
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
        build: BUILD,
        lastPollOk: poller.last?.ok ?? null,
      };
    })


    /**
     * Public, unauthenticated, read-only.
     *
     * Exists so the node can be shown to people who have no business spending
     * from it — batch fullness and expiry are the whole story of whether a
     * gateway is about to break, and that story is more useful shared than
     * hidden. Nothing here writes, and nothing here is a secret: batch IDs are
     * on-chain, and a batch ID grants no ability to upload, because stamping
     * requires a signature from the node's own key.
     */
    .get('/api/public/state', () => statePublic())

    /** Bucket map for one batch. Reads only; the same data the map already draws. */
    .get('/api/public/batches/:id/buckets', async ({ params, set }) => {
      const b = poller.last?.batches.find((x) => x.batchID === params.id);
      if (!b) { set.status = 404; return { error: 'unknown batch' }; }
      try {
        const r = await bee.buckets(params.id);
        const g = buildGrid(r);
        return json({ ...g, label: b.label, immutable: b.immutableFlag,
          pressure: bucketPressure(g, b.immutableFlag) });
      } catch (e: any) { set.status = 502; return { error: e?.message ?? String(e) }; }
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

        .get('/state', () => stateFull())

        /**
         * Runtime settings: every editable key, its environment value, any
         * override, and how it may be moved.
         *
         * The environment value is sent explicitly because for spend caps it is
         * a ceiling, not merely a default — the dashboard has to be able to say
         * "you cannot raise this past 5" rather than accepting a number and
         * silently clamping it.
         */
        .get('/settings', () => {
          const stored = db.settings();
          const eff = applySettings(cfg, stored);
          return json({
            settings: EDITABLE.map((spec) => {
              const v = envValue(eff, spec.key);
              return {
                ...spec,
                // Served in display units, so the page never has to know which
                // settings are secretly fractions.
                value: spec.kind === 'percent' && typeof v === 'number' ? v * 100 : v,
              };
            }),
            /**
             * Bootstrap only. These are read before the settings table exists
             * or before the request is authenticated, so they cannot live in
             * it. Shown read-only rather than omitted, so their absence from
             * the editable list is not a mystery.
             */
            fixed: {
              beeUrl: cfg.beeUrl,
              pollIntervalMs: cfg.pollIntervalMs,
              dbPath: cfg.dbPath,
              maxUploadBytes: cfg.maxUploadBytes,
            },
          });
        })

        .patch('/settings', ({ body, set }) => {
          const { confirm, ...patch } = body as Record<string, any>;
          const current = applySettings(cfg, db.settings());
          const applied: Record<string, unknown> = {};
          const needsConfirm: { key: string; label: string; from: unknown; to: unknown; risk: string | null }[] = [];

          for (const [key, raw] of Object.entries(patch)) {
            const spec = EDITABLE.find((x) => x.key === key);
            if (!spec) { set.status = 400; return { error: `unknown or non-editable setting: ${key}` }; }

            if (spec.kind === 'bool') { applied[key] = Boolean(raw); continue; }
            if (spec.kind === 'string') { applied[key] = String(raw ?? ''); continue; }

            // Percent settings arrive as 0-100 and are stored as a fraction,
            // which is what utilizationRatio is and what evaluate() compares
            // against. The conversion lives here so exactly one layer knows.
            const n = spec.kind === 'percent' ? Number(raw) / 100 : Number(raw);
            if (!Number.isFinite(n)) { set.status = 400; return { error: `${key} must be a number` }; }
            const shown = spec.kind === 'percent' ? n * 100 : n;
            if (spec.min !== undefined && shown < spec.min) { set.status = 400; return { error: `${key} must be at least ${spec.min}` }; }
            if (spec.max !== undefined && shown > spec.max) { set.status = 400; return { error: `${key} must be at most ${spec.max}` }; }

            // Loosening a guard is allowed, but never by accident. Tightening
            // needs no ceremony — the cautious direction should be frictionless.
            const now = envValue(current, key);
            if (typeof now === 'number' && isLoosening(key, now, n)) {
              needsConfirm.push({ key, label: spec.label, from: now, to: n, risk: riskOf(key) });
            }
            applied[key] = n;
          }

          if (needsConfirm.length && !confirm) {
            return json({ confirmRequired: true, changes: needsConfirm });
          }

          for (const [k, v] of Object.entries(applied)) db.setSetting(k, String(v));

          // Settings decide what this service may spend, so a change belongs in
          // the same ledger as the spends themselves.
          db.recordAction({
            batchId: null, appName: 'dashboard', kind: 'config',
            amount: 0n, cost: 0n, status: 'confirmed',
            reason: `settings: ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(', ')}`
              + (needsConfirm.length ? ' (loosened, confirmed)' : ''),
            error: null,
          });

          return json({ applied, loosened: needsConfirm.map((c) => c.key) });
        }, {
          body: t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()])),
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
          if (bytes.byteLength > cfg.maxUploadBytes) {
            set.status = 413;
            return { error: `upload is ${formatBytes(BigInt(bytes.byteLength))}, over the ${formatBytes(BigInt(cfg.maxUploadBytes))} limit` };
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
            const room = await fullnessAfterUpload({ poller, db, alerter, cfg }, params.id);
            return json({ reference, bytes: bytes.byteLength, name: name ?? null, ...room });
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

        /**
         * Top up a batch by hand.
         *
         * Same two-step shape as dilution and buying, and subject to the same
         * caps as the automatic path. Being deliberate does not make a spend
         * safe to leave unbounded — the caps are the only thing standing
         * between a mis-typed duration and the wallet — so a blocked manual
         * top-up reports which cap stopped it rather than silently proceeding.
         */
        .post('/batches/:id/topup', async ({ params, body, set }) => {
          const r = poller.last;
          if (!r?.ok || !r.chain || !r.wallet) { set.status = 503; return { error: 'no poll data yet' }; }
          const b = r.batches.find((x) => x.batchID === params.id);
          if (!b) { set.status = 404; return { error: 'unknown batch' }; }

          // `managed` governs AUTOMATION — whether the poller acts on its own.
          // It does not govern whether a human may act. Blocking manual top-up
          // and dilution here conflated the two and removed the one case that
          // most needs them: an unmanaged batch you have decided to keep alive
          // a little longer while migrating off it. Surfaced in the preview
          // instead, so it is a visible decision rather than a blocked one.
          const unmanaged = !(db.batch(params.id)?.managed ?? true);
          const { days, confirm } = body as { days?: number; confirm?: boolean };
          const pol = policyFor(cfg, db.batch(params.id));
          const targetDays = days ?? pol.topupTargetTtlSec / 86_400;
          const currentDays = b.batchTTL / 86_400;

          if (targetDays <= currentDays) {
            set.status = 400;
            return { error: `batch already has ${currentDays.toFixed(1)}d; a top-up can only extend` };
          }

          const seconds = Math.round((targetDays - currentDays) * 86_400);
          const perChunk = amountForDuration(r.chain.currentPrice, seconds, r.msPerBlock);
          const cost = costPlur(perChunk, b.depth);
          const verdict = checkCaps(cost, {
            config: effective(), wallet: r.wallet, chain: r.chain,
            spentLast24h: db.spentLast24h(), inFlight: db.inFlightBatchIds(), msPerBlock: r.msPerBlock,
          });

          const preview = {
            batchId: params.id,
            unmanaged,
            fromDays: currentDays,
            toDays: targetDays,
            costBzz: plurToBzz(cost),
            allowed: verdict.allowed,
            reason: verdict.reason,
          };

          if (!confirm) return json({ preview, confirmRequired: true });
          if (!verdict.allowed) { set.status = 403; return { error: `blocked by caps: ${verdict.reason}` }; }
          if (effective().dryRun) return json({ dryRun: true, wouldTopup: preview });

          const actionId = db.recordAction({
            batchId: params.id, appName: null, kind: 'topup',
            amount: perChunk, cost, status: 'submitted',
            reason: `manual top-up to ${targetDays}d`, error: null,
          });
          try {
            await bee.topUp(params.id, perChunk);
            db.updateActionStatus(actionId, 'confirmed');
            await poller.refreshBatch(params.id);
            return json({ toppedUp: preview });
          } catch (e: any) {
            if (e instanceof BeeIndeterminateError) {
              // Stays `submitted`: the transaction may still be mined, and
              // marking it failed would invite a second, duplicate top-up.
              set.status = 504;
              return { error: e.message, indeterminate: true };
            }
            db.updateActionStatus(actionId, 'failed', e?.message ?? String(e));
            set.status = 502;
            return { error: e?.message ?? String(e) };
          }
        }, {
          body: t.Object({
            days: t.Optional(t.Number({ minimum: 1, maximum: 3650 })),
            confirm: t.Optional(t.Boolean()),
          }),
        })

        /**
         * Dilute a batch: raise its depth, doubling capacity per step.
         *
         * The counter-intuitive part, and why this is two-step: dilution does
         * not add anything. The same per-chunk amount now has to cover twice
         * as many chunks, so REMAINING LIFE HALVES with each depth step. It
         * buys room at the cost of time, and topping up first would throw half
         * the top-up away — which is why the automatic path always dilutes
         * before it tops up.
         *
         * Immutable batches are refused: Bee will not dilute one, and it would
         * not help anyway, since a full bucket on an immutable batch rejects
         * writes permanently.
         */
        .post('/batches/:id/dilute', async ({ params, body, set }) => {
          const r = poller.last;
          if (!r?.ok || !r.chain || !r.wallet) { set.status = 503; return { error: 'no poll data yet' }; }
          const b = r.batches.find((x) => x.batchID === params.id);
          if (!b) { set.status = 404; return { error: 'unknown batch' }; }

          // `managed` governs AUTOMATION — whether the poller acts on its own.
          // It does not govern whether a human may act. Blocking manual top-up
          // and dilution here conflated the two and removed the one case that
          // most needs them: an unmanaged batch you have decided to keep alive
          // a little longer while migrating off it. Surfaced in the preview
          // instead, so it is a visible decision rather than a blocked one.
          const unmanaged = !(db.batch(params.id)?.managed ?? true);
          const { newDepth, confirm } = body as { newDepth?: number; confirm?: boolean };
          const target = newDepth ?? b.depth + 1;

          if (target <= b.depth) {
            set.status = 400;
            return { error: `depth can only increase; batch is already depth ${b.depth}` };
          }
          if (target > MAX_DEPTH) {
            set.status = 400;
            return { error: `depth ${target} is above the maximum of ${MAX_DEPTH}` };
          }

          const steps = target - b.depth;
          const ttlAfter = Math.floor(b.batchTTL / Math.pow(2, steps));
          // What it would cost to put back the life dilution removes, at this
          // batch's own target rather than the global one.
          const pol = policyFor(cfg, db.batch(params.id));
          const seconds = Math.max(0, pol.topupTargetTtlSec - ttlAfter);
          const perChunk = amountForDuration(r.chain.currentPrice, seconds, r.msPerBlock);
          const restoreCost = costPlur(perChunk, target);

          /**
           * increaseDepth divides the remaining per-chunk balance by 2^steps
           * and reverts with InsufficientBalance if the result falls below the
           * contract's minimum. A nearly-expired batch therefore cannot be
           * diluted at all — worth saying before the transaction, not after it
           * reverts and the gas is gone.
           */
          const tooThin = ttlAfter < r.chain.minimumValidityBlocks * (r.msPerBlock / 1000);

          const preview = {
            batchId: params.id,
            unmanaged,
            tooThin,
            fromDepth: b.depth,
            toDepth: target,
            capacityBefore: capacityBytes(b.depth).toString(),
            capacityAfter: capacityBytes(target).toString(),
            capacityBeforeHuman: formatBytes(capacityBytes(b.depth)),
            capacityAfterHuman: formatBytes(capacityBytes(target)),
            ttlDaysBefore: b.batchTTL / 86_400,
            ttlDaysAfter: ttlAfter / 86_400,
            restoreToDays: pol.topupTargetTtlSec / 86_400,
            restoreCostBzz: plurToBzz(restoreCost),
            restoreAffordable: restoreCost <= r.wallet.bzzBalance,
          };

          if (!confirm) return json({ preview, confirmRequired: true });
          if (tooThin) {
            set.status = 409;
            return { error: 'after dilution the remaining balance per chunk would fall below the contract minimum — top up first, then dilute' };
          }
          if (cfg.dryRun) return json({ dryRun: true, wouldDilute: preview });

          const actionId = db.recordAction({
            batchId: params.id, appName: null, kind: 'dilute',
            amount: BigInt(target), cost: 0n, status: 'submitted',
            reason: `manual dilute ${b.depth} -> ${target}`, error: null,
          });
          try {
            await bee.dilute(params.id, target);
            db.updateActionStatus(actionId, 'confirmed');
            // Depth, utilisation and TTL all move together, so re-read rather
            // than guess — otherwise the page shows the old depth for up to a
            // full poll interval.
            await poller.refreshBatch(params.id);
            return json({ diluted: preview });
          } catch (e: any) {
            if (e instanceof BeeIndeterminateError) {
              // Left as submitted on purpose: the transaction may still land,
              // and recording it failed would invite a duplicate dilution.
              set.status = 504;
              return { error: e.message, indeterminate: true };
            }
            db.updateActionStatus(actionId, 'failed', e?.message ?? String(e));
            set.status = 502;
            return { error: e?.message ?? String(e) };
          }
        }, {
          body: t.Object({
            newDepth: t.Optional(t.Integer({ minimum: 17, maximum: 41 })),
            confirm: t.Optional(t.Boolean()),
          }),
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
              /**
               * Sent so the browser can refuse an oversized file before
               * transferring it. Served rather than hardcoded client-side, so
               * the two cannot disagree after a config change.
               */
              maxUploadBytes: cfg.maxUploadBytes,
              /**
               * Chunk slots still free across the whole batch. An upper bound:
               * a chunk can only go in the bucket its address selects, so the
               * last slots are unreachable in practice — which is what the
               * fullest-bucket figure is for.
               */
              freeChunks: Math.max(0, Math.pow(2, grid.depth) - grid.totalChunks),
              /** Base for shareable download links, so the page need not hardcode one. */
              publicGatewayUrl: applySettings(cfg, db.settings()).publicGatewayUrl,
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

        /**
         * Issue an upload key for one batch.
         *
         * The plaintext is returned HERE AND NOWHERE ELSE. Only its hash is
         * stored, so a lost key is reissued rather than recovered — which is
         * why keys are plural per batch: adding one costs nothing, and rotation
         * is add-then-revoke with no window where CI and server disagree.
         */
        .post('/batches/:id/keys', async ({ params, body, set }) => {
          const { name } = (body ?? {}) as { name?: string };
          if (!name || !name.trim()) { set.status = 400; return { error: 'name is required' }; }
          if (!poller.last?.batches.some((b) => b.batchID === params.id)) {
            set.status = 404; return { error: 'unknown batch' };
          }
          // 32 bytes of CSPRNG. Prefixed so a leaked key is greppable in logs
          // and recognisable in a support paste without being guessable.
          const raw = 'ssm_' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map((b) => b.toString(16).padStart(2, '0')).join('');
          const id = db.addApiKey(name.trim(), params.id, await hashApiKey(raw));
          return json({ id, name: name.trim(), batchId: params.id, key: raw,
            note: 'Copy this now — it is not stored and cannot be shown again.' });
        }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 64 }) }) })

        /** Never returns key material — only what a key is for and when it ran. */
        .get('/batches/:id/keys', ({ params }) => json(db.apiKeys(params.id)))

        .delete('/keys/:id', ({ params, set }) => {
          const ok = db.revokeApiKey(Number(params.id));
          if (!ok) { set.status = 404; return { error: 'unknown or already revoked' }; }
          return { revoked: true };
        })

        .patch('/batches/:id', async ({ params, body, set }) => {
          const b = body as {
            label?: string; managed?: boolean;
            topupBelowDays?: number | null; topupTargetDays?: number | null;
            diluteAbove?: number | null; maxDiluteDepth?: number | null;
          };
          const { label, managed } = b;
          const policyKeys = ['topupBelowDays', 'topupTargetDays', 'diluteAbove', 'maxDiluteDepth'] as const;
          const hasPolicy = policyKeys.some((k) => k in b);
          if (label === undefined && managed === undefined && !hasPolicy) {
            set.status = 400;
            return { error: 'provide label, managed, or a policy field' };
          }
          if (b.topupBelowDays != null && b.topupTargetDays != null
              && b.topupBelowDays >= b.topupTargetDays) {
            // Topping up to a target at or below the trigger would re-fire
            // every cycle, spending on each one.
            set.status = 400;
            return { error: 'topupTargetDays must be greater than topupBelowDays' };
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
            // The dashboard reads labels from the poll cache, so correct it
            // now rather than leaving the rename invisible until the next
            // cycle. See Poller.patchCachedLabel.
            poller.patchCachedLabel(params.id, label);
          }
          if (managed !== undefined) db.setManaged(params.id, managed);
          if (hasPolicy) {
            db.setBatchPolicy(params.id, {
              topupBelowDays: b.topupBelowDays,
              topupTargetDays: b.topupTargetDays,
              diluteAbove: b.diluteAbove,
              maxDiluteDepth: b.maxDiluteDepth,
            });
          }

          return json(db.batch(params.id));
        }, {
          body: t.Object({
            label: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
            managed: t.Optional(t.Boolean()),
            // Null clears an override and returns the batch to the global
            // setting; omitting the key leaves it untouched.
            topupBelowDays: t.Optional(t.Union([t.Integer({ minimum: 1, maximum: 3650 }), t.Null()])),
            topupTargetDays: t.Optional(t.Union([t.Integer({ minimum: 2, maximum: 3650 }), t.Null()])),
            diluteAbove: t.Optional(t.Union([t.Number({ minimum: 0.1, maximum: 1 }), t.Null()])),
            maxDiluteDepth: t.Optional(t.Union([t.Integer({ minimum: 17, maximum: 41 }), t.Null()])),
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
            config: effective(), wallet: r.wallet, chain: r.chain,
            spentLast24h: db.spentLast24h(), inFlight: db.inFlightBatchIds(), msPerBlock: r.msPerBlock,
          });
          if (!verdict.allowed) { set.status = 403; return { error: `blocked by caps: ${verdict.reason}` }; }
          if (effective().dryRun) return json({ dryRun: true, wouldBuy: q });

          const id = db.recordAction({
            batchId: null, appName: label ?? null, kind: 'buy',
            amount: q.amountPerChunk, cost: q.costPlur, status: 'submitted',
            reason: `manual buy: depth ${depth}, ${days}d`, error: null,
          });
          try {
            const batchId = await bee.buyBatch(q.amountPerChunk, depth, { label, immutable: immutable ?? true });
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
        const room = await fullnessAfterUpload({ poller, db, alerter, cfg }, app.batchId!);
        return json({ reference, bytes: bytes.byteLength, remaining: verdict.remaining, ...room });
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
    /**
     * index.html is the pointer to the content-hashed bundle, so it is the one
     * file that must never be cached. It was served with NO cache headers at
     * all -- no Cache-Control, no ETag, no Last-Modified -- which leaves
     * browsers to apply heuristic caching, and a stale index pins the old
     * bundle indefinitely however many times the service is redeployed. That
     * is precisely how a deployed change appeared not to have shipped.
     */
    const index = () => new Response(Bun.file(`${webDist}/index.html`), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache, must-revalidate',
      },
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
    app.get('/settings', index);
    // The opposite rule, for the opposite reason: these filenames contain a
    // hash of their contents, so a given URL can never change. Caching them
    // for a year is free, and it is what makes a no-cache index cheap.
    app.get('/assets/*', ({ params, set }: any) => {
      const file = Bun.file(`${webDist}/assets/${params['*']}`);
      set.status = 200;
      return new Response(file, {
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      });
    });
  } else {
    console.log(`[server] no dashboard at ${webDist} — API only`);
  }

  // Bee-compatible façade + admin-only passthrough. Registered LAST so every
  // route above wins; bee-js cannot keep a path prefix, so this must be at root.
  app.use(createBeeApi({ bee, db, poller, adminToken }));

  return app;
}
