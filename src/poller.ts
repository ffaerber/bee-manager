/**
 * The daemon loop: read the node, record it, decide, and (only when explicitly
 * enabled) act.
 *
 * Ordering matters in two places. Dilution runs before its follow-up top-up,
 * because diluting halves remaining TTL. And an action is recorded as
 * `submitted` *before* the Bee call, so a crash mid-transaction leaves evidence
 * rather than a silent double-spend on the next poll.
 */

import { BeeClient, BeeIndeterminateError, type Batch, type ChainState, type NodeStatus, type Wallet } from './bee';
import { Db } from './db';
import { applySettings } from './settings';
import { ReachabilityFeed, type Reachability } from './reachability';
import { StakeFeed, heightMismatch, type StakeInfo } from './staking';
import { PeerMapFeed, type PeerMapState } from './peermap';
import { Alerter } from './alerts';
import { evaluateAll, findDisappeared, totalBurnPer30Days, totalCommitted, type EvalContext, type Plan } from './evaluate';
import {
  chequebookRunwayDays, chequebookSpendPer30Days,
  plurToBzz, runwaySeconds, GNOSIS_MS_PER_BLOCK,
} from './math';
import type { Config } from './config';

/**
 * How far back the chequebook rate is measured.
 *
 * An hour, because settlement is lumpy: cheques are written when a peer's debt
 * crosses a threshold, not continuously. Over seconds the observed rate is
 * either zero or a spike; over an hour it is a rate.
 */
const CHEQUEBOOK_RATE_WINDOW_MS = 3_600_000;

/**
 * How long an action may sit `submitted` before the in-flight lock is released.
 *
 * Long enough that a genuinely pending transaction is never released early —
 * Gnosis blocks are ~5s, so half an hour is two orders of magnitude of slack —
 * and short enough that a stranded row cannot quietly cost a batch its life.
 */
const STALE_INFLIGHT_MS = 30 * 60_000;

export interface PollResult {
  ok: boolean;
  batches: Batch[];
  chain?: ChainState;
  wallet?: Wallet;
  /**
   * Node health and the money that is NOT in the wallet.
   *
   * The chequebook and the stake hold real xBZZ that the wallet figure does not
   * include, and neither can pay for postage — so showing only the wallet made
   * the balance look smaller than it is while showing all three without saying
   * which is spendable would be worse. Best-effort: a node with the chequebook
   * disabled is still a node worth reporting on.
   */
  node?: NodeStatus;
  plans: Plan[];
  msPerBlock: number;
  burnPer30DaysBzz: number;
  /** Wallet / burn. Flat between top-ups; this is what the low-wallet alert uses. */
  runwayDays: number;
  /**
   * (Wallet + value already committed to batches) / burn.
   *
   * The only runway that truly counts down: the committed part drains every
   * block at exactly the burn rate, so this falls at one second per second.
   */
  totalRunwayDays: number;
  /** Value paid into the batches and not yet consumed, in xBZZ. */
  committedBzz: number;
  /**
   * Whether anyone outside can dial this node, as reported by a third party.
   * Null when unknown, disabled, or unreadable — never assume reachable.
   */
  reachability?: Reachability | null;
  /** Stake as the chain holds it, so it can be checked against the config. */
  stake?: StakeInfo | null;
  /** Peer positions, filling in over time. Null when disabled or unread. */
  peerMap?: PeerMapState | null;
  /**
   * SWAP settlement health. Absent when the node has no chequebook, or when
   * the endpoints could not be read — the rest of the poll still stands.
   */
  chequebook?: {
    totalBzz: number;
    /** Spendable on bandwidth right now. Outstanding cheques are already out. */
    availableBzz: number;
    sentBzz: number;
    receivedBzz: number;
    /** Null until there is enough history to measure a rate over. */
    spendPer30DaysBzz: number | null;
    /** Null when nothing is being spent — never Infinity, which JSON drops. */
    runwayDays: number | null;
    /** How long the rate was measured over, in ms. Zero when unmeasured. */
    windowMs: number;
    peers: number;
    peersOwingUs: number;
    low: boolean;
  };
  /**
   * When this snapshot was taken, in server-clock epoch ms.
   *
   * /state serves the cached result, so a caller can receive a figure computed
   * up to a full poll interval ago. Anything counting down from it has to know
   * how stale it is, or it runs ahead of the truth and then jumps backwards
   * every time a fresh poll lands.
   */
  polledAt: number;
  error?: string;
}

export class Poller {
  private lastBlock: { block: number; at: number } | null = null;
  private msPerBlock = GNOSIS_MS_PER_BLOCK;
  private timer: Timer | null = null;
  last: PollResult | null = null;

  /**
   * Correct the cached label for one batch, after a rename.
   *
   * /state serves labels from the last poll, so without this a rename is
   * invisible until the next cycle — up to POLL_INTERVAL_MS, five minutes by
   * default. The node and the database are both already correct at that point;
   * only this cache is behind, and it is the one the dashboard reads. The
   * result is a rename that appears to silently fail.
   *
   * Deliberately narrow: it edits the one field that changed rather than
   * triggering a full tick, because a tick also runs the evaluate/top-up pass,
   * and a rename must not be able to set off a spend.
   */
  patchCachedLabel(batchId: string, label: string) {
    const b = this.last?.batches.find((x) => x.batchID === batchId);
    if (b) b.label = label;
  }

  /**
   * Re-read one batch from the node and replace its cached entry.
   *
   * For changes that move several fields at once — dilution alters depth,
   * utilisation and TTL together — patching individual fields would be
   * guesswork. Reading the one stamp back is authoritative and costs a single
   * request.
   *
   * Still not a full tick, for the same reason patchCachedLabel is not: a tick
   * runs the evaluate/top-up pass, and a manual operation must not be able to
   * set off an unrelated spend as a side effect.
   */
  async refreshBatch(batchId: string): Promise<void> {
    if (!this.last) return;
    try {
      const fresh = await this.bee.stamp(batchId);
      const i = this.last.batches.findIndex((x) => x.batchID === batchId);
      if (i >= 0) this.last.batches[i] = fresh;
    } catch {
      // Leave the cache alone: a stale entry beats a missing one, and the next
      // scheduled poll corrects it regardless.
    }
  }

  constructor(
    private readonly cfg: Config,
    private readonly bee: BeeClient,
    private readonly db: Db,
    private readonly alerter: Alerter,
    /**
     * Optional third-party view of whether anyone can dial this node. Omitted
     * in tests and when disabled; the poll is unaffected either way, because
     * nothing here gates a spend on it.
     */
    private readonly reach?: ReachabilityFeed,
    /** On-chain stake and height. Optional; nothing here gates a spend on it. */
    private readonly stakeFeed?: StakeFeed,
    /** Where the peers are. Decoration; a failure here costs a map, nothing else. */
    private readonly peerMap?: PeerMapFeed,
  ) {}

  /**
   * The config actually in force: environment plus dashboard overrides.
   *
   * Read through this everywhere rather than touching `this.cfg`, so a setting
   * changed from the dashboard applies on the next cycle. `this.cfg` remains
   * the environment layer, and for spend caps the ceiling an override cannot
   * exceed — see src/settings.ts.
   */
  private effective(): Config {
    return applySettings(this.cfg, this.db.settings());
  }

  start() {
    this.tick().catch((e) => console.error('[poll] first tick failed', e));
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[poll] tick failed', e));
    }, this.cfg.pollIntervalMs);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /**
   * Measure block time from successive chainstate reads instead of assuming it.
   * Gnosis measured at 4.997 s/block, but measuring means a chain-level change
   * cannot silently mis-size every purchase.
   */
  private updateBlockRate(chain: ChainState, now: number) {
    if (this.lastBlock && chain.block > this.lastBlock.block) {
      const blocks = chain.block - this.lastBlock.block;
      const elapsed = now - this.lastBlock.at;
      const observed = elapsed / blocks;
      // Ignore implausible readings (clock jumps, long gaps, a stalled node).
      if (observed > 500 && observed < 60_000) {
        this.msPerBlock = Math.round(this.msPerBlock * 0.7 + observed * 0.3);
      }
    }
    this.lastBlock = { block: chain.block, at: now };
  }

  async tick(): Promise<PollResult> {
    const now = Date.now();
    // Environment plus dashboard overrides, resolved once per cycle.
    const cfg = this.effective();
    let batches: Batch[], chain: ChainState, wallet: Wallet;
    try {
      [batches, chain, wallet] = await Promise.all([
        this.bee.stamps(), this.bee.chainstate(), this.bee.wallet(),
      ]);
      this.alerter.clear('node_unreachable');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      await this.alerter.send({ event: 'node_unreachable', level: 'error', message: `Bee unreachable: ${msg}` });
      this.last = { ok: false, batches: [], plans: [], msPerBlock: this.msPerBlock, burnPer30DaysBzz: 0, runwayDays: 0, totalRunwayDays: 0, committedBzz: 0, polledAt: Date.now(), error: msg };
      return this.last;
    }

    this.updateBlockRate(chain, now);

    // Disappearance must be detected before recording the current batches,
    // otherwise a batch that vanished this tick is never compared.
    const known = this.db.liveKnownBatchIds();
    const unmanaged = this.db.unmanagedBatchIds();
    for (const gone of findDisappeared(known, batches)) {
      if (this.db.markGone(gone, now)) {
        // An unmanaged batch expiring is the intended outcome, not an incident.
        if (unmanaged.has(gone)) {
          console.log(`[poll] unmanaged batch ${gone.slice(0, 12)}… expired as intended`);
          continue;
        }
        await this.alerter.send({
          event: 'batch_disappeared', level: 'error', batchId: gone,
          message: `Batch ${gone.slice(0, 12)}… has expired and is gone from the node. ` +
                   `Data stamped with it is no longer retrievable; a new batch is required.`,
        });
      }
    }

    const knownSet = new Set(known);
    for (const b of batches) {
      const isNew = !knownSet.has(b.batchID);
      this.db.seenBatch(b.batchID, b.label, b.depth, b.immutableFlag, now);
      // Label convention, applied once when a batch first appears: creating a
      // throwaway stamp should not require a second call to opt it out.
      if (isNew && this.cfg.unmanagedLabelPrefix && b.label.startsWith(this.cfg.unmanagedLabelPrefix)) {
        this.db.setManaged(b.batchID, false);
        unmanaged.add(b.batchID);
        console.log(`[poll] ${b.label} matches "${this.cfg.unmanagedLabelPrefix}" — left unmanaged`);
      }
      this.db.recordSnapshot(b.batchID, b.batchTTL, b.amount, b.depth, b.utilizationRatio, chain.currentPrice, now);
    }

    // Unmanaged batches are observed and charted, but never acted on.
    const managedBatches = batches.filter((b) => !unmanaged.has(b.batchID));

    const burn = totalBurnPer30Days(batches, chain.currentPrice, this.msPerBlock);
    // Wallet-only: what is left to FUND future top-ups. Flat between spends,
    // and the figure the low-wallet alert is defined against.
    const runwayDays = runwaySeconds(wallet.bzzBalance, burn) / 86_400;
    // Wallet plus what the batches are already paid up for. This is the one
    // that genuinely ticks down, because the committed half drains each block.
    const committed = totalCommitted(batches);
    const totalRunwayDays = runwaySeconds(wallet.bzzBalance + committed, burn) / 86_400;


    if (runwayDays < cfg.walletLowRunwayDays) {
      await this.alerter.send({
        event: 'wallet_low', level: 'warn',
        message: `Wallet covers ~${runwayDays.toFixed(0)} more days at the current burn of ` +
                 `${plurToBzz(burn).toFixed(2)} xBZZ/30d (balance ${plurToBzz(wallet.bzzBalance).toFixed(2)} xBZZ).`,
        details: { runwayDays, burnPer30DaysBzz: plurToBzz(burn) },
      });
    } else {
      this.alerter.clear('wallet_low');
    }

    const ctx: EvalContext = {
      config: cfg, wallet, chain,
      spentLast24h: this.db.spentLast24h(now),
      inFlight: this.db.inFlightBatchIds(),
      msPerBlock: this.msPerBlock,
      // Read fresh each tick so an override takes effect on the next cycle
      // rather than at the next restart.
      policies: new Map(this.db.batches().map((b) => [b.batchId, {
        topupBelowDays: b.topupBelowDays,
        topupTargetDays: b.topupTargetDays,
        diluteAbove: b.diluteAbove,
        maxDiluteDepth: b.maxDiluteDepth,
      }])),
    };
    // Release anything stranded in-flight before planning, or a batch stays
    // locked out for good. Recorded as `failed` rather than deleted: the ledger
    // is the audit trail for money, and "we submitted this and never saw it
    // land" is a fact worth keeping.
    for (const a of this.db.staleSubmitted(STALE_INFLIGHT_MS, now)) {
      this.db.updateActionStatus(a.id, 'failed', `never confirmed; released after ${STALE_INFLIGHT_MS / 60_000} min`);
      await this.alerter.send({
        event: 'topup_failed', level: 'warn', batchId: a.batch_id ?? undefined,
        message: `A ${a.kind} submitted ${Math.round((now - a.ts) / 60_000)} min ago was never confirmed. ` +
                 `Released so the batch can be acted on again — check whether it landed before assuming it did not.`,
      });
    }

    const plans = evaluateAll(managedBatches, ctx);
    for (const plan of plans) await this.handle(plan, batches);

    // Never fails the poll: this is context, not a decision input, and the
    // stamps it reports on are already read above.
    const node = await this.bee.nodeStatus().catch(() => undefined);

    // Depends on `node`, so it has to come after that read.
    const chequebook = await this.readChequebook(node, cfg, now);

    /**
     * The outside view. Cached for an hour upstream of here, so this is a
     * cheap read on almost every tick, and it never throws — a node whose
     * reachability is unknown is still a node whose batches must be renewed.
     */
    const reachability = node?.overlay
      ? await this.reach?.get(node.overlay, now).catch(() => null) ?? null
      : null;

    /**
     * Undialable is a warning, not an error: nothing here is broken from this
     * side, and the batches still renew. It is reported because it is the one
     * fault with no local symptom — the node reports a full peer table either
     * way, since those peers were all dialled outbound.
     *
     * Only fires on a definite `true`. Unknown stays silent: an observer being
     * down is not evidence about the node, and crying wolf on a third party's
     * outage is how a real finding gets ignored.
     */
    /**
     * The stake, and whether it matches how the node is configured to run.
     *
     * Read after `wallet` because it is keyed by the node's own address.
     */
    const stake = wallet?.walletAddress
      ? await this.stakeFeed?.get(wallet.walletAddress, now).catch(() => null) ?? null
      : null;

    /**
     * Height and doubling are the same number set in two places, and nothing
     * else notices when they disagree. Storing more than the stake covers is
     * not a local fault: the node runs, reports a healthy reserve, and simply
     * fails to win rounds or has its deposit frozen.
     *
     * Silent when either side is unknown — an unread stake is not evidence.
     */
    /**
     * A few peer lookups, then whatever can be drawn. Wrapped because the
     * peer list is a second call to Bee and a map is not worth failing a poll
     * that also renews postage.
     */
    const peerMap = this.peerMap
      ? await this.bee.peers()
          .then((o) => this.peerMap!.tick(o, { overlay: node?.overlay, underlay: node?.underlay }))
          .catch(() => null)
      : null;

    const drift = heightMismatch(stake, node?.reserveCapacityDoubling);
    if (drift) {
      await this.alerter.send({
        event: 'stake_height_mismatch', level: 'warn',
        message: `Staked height is ${drift.staked} but the node runs with ` +
                 `reserve-capacity-doubling=${drift.configured}. These are the same setting in two ` +
                 `places and must match: the reserve is 2^(22+n) chunks and the stake collateralises ` +
                 `it. Nothing local reports this — the node keeps serving either way.`,
        details: { stakedHeight: drift.staked, configuredDoubling: drift.configured },
      });
    } else if (stake && node?.reserveCapacityDoubling != null) {
      await this.alerter.clear('stake_height_mismatch');
    }

    if (reachability?.unreachable === true) {
      await this.alerter.send({
        event: 'node_undialable', level: 'warn',
        message: `Peers cannot dial this node from the internet` +
                 `${reachability.error ? ` — ${reachability.error}` : ''}. ` +
                 `Local peer counts look normal regardless, because those connections are ` +
                 `outbound. Usually a port forward, or an advertised address that no longer ` +
                 `matches the WAN address.`,
        details: {
          overlay: reachability.overlay,
          handshakeMs: reachability.handshakeMs,
          lastCheckedAt: reachability.lastCheckedAt,
        },
      });
    } else if (reachability?.unreachable === false) {
      await this.alerter.clear('node_undialable');
    }

    this.last = {
      ok: true, batches, chain, wallet, node, plans, reachability, stake, peerMap,
      msPerBlock: this.msPerBlock,
      burnPer30DaysBzz: plurToBzz(burn),
      runwayDays,
      totalRunwayDays,
      committedBzz: plurToBzz(committed),
      chequebook,
      polledAt: now,
    };
    this.db.pruneSnapshots(90, now);
    return this.last;
  }

  private async handle(plan: Plan, batches: Batch[]) {
    const batch = batches.find((b) => b.batchID === plan.batchId);

    if (plan.kind === 'none') return;

    if (plan.kind === 'blocked') {
      this.db.recordAction({
        batchId: plan.batchId, appName: batch?.label ?? null, kind: 'topup',
        amount: 0n, cost: plan.wouldHaveCost, status: 'blocked', reason: plan.reason, error: null,
      });
      await this.alerter.send({
        event: 'topup_blocked', level: 'warn', batchId: plan.batchId,
        costBzz: plurToBzz(plan.wouldHaveCost),
        message: `Batch ${batch?.label || plan.batchId.slice(0, 12)}: ${plan.reason}`,
      });
      return;
    }

    // A batch below threshold is worth knowing about even when we cannot act.
    await this.alerter.send({
      event: 'batch_low', level: 'warn', batchId: plan.batchId,
      costBzz: plurToBzz(plan.cost),
      message: `Batch ${batch?.label || plan.batchId.slice(0, 12)}: ${plan.reason} ` +
               `(${plurToBzz(plan.cost).toFixed(3)} xBZZ)`,
    });

    const cfg = this.effective();
    if (!cfg.autoTopupEnabled || cfg.dryRun) {
      this.db.recordAction({
        batchId: plan.batchId, appName: batch?.label ?? null,
        kind: plan.kind === 'dilute' ? 'dilute' : 'topup',
        amount: plan.kind === 'dilute' ? plan.thenTopup : plan.amountPerChunk,
        cost: plan.cost, status: 'dry-run', reason: plan.reason, error: null,
      });
      console.log(`[poll] would ${plan.kind} ${plan.batchId.slice(0, 12)}… — ${plan.reason} ` +
                  `(${cfg.autoTopupEnabled ? 'DRY_RUN' : 'AUTO_TOPUP_ENABLED=false'})`);
      return;
    }

    await this.execute(plan, batch);
  }

  /** The only place in the codebase that spends money on a schedule. */
  /**
   * Chequebook health, and the rate it is being spent at.
   *
   * The rate has to be measured because Bee reports a balance and nothing
   * about its velocity — there is no chequebook equivalent of batchTTL. So
   * every poll records a snapshot and the rate comes from comparing against
   * one at least an hour old. Until that much history exists the rate is null
   * and the UI says "measuring", rather than dividing by a few seconds and
   * printing a number that is pure noise.
   *
   * Deliberately never throws: an unreadable chequebook must not fail a poll
   * whose real job is keeping stamps alive.
   */
  private async readChequebook(node: NodeStatus | undefined, cfg: Config, now: number) {
    const total = node?.chequebookBalance;
    const available = node?.chequebookAvailable;
    if (total == null || available == null) return undefined;

    const sent = node?.settlementsSent ?? 0n;
    const received = node?.settlementsReceived ?? 0n;

    this.db.recordChequebook(total, available, sent, received, now);

    const base = this.db.chequebookBaseline(CHEQUEBOOK_RATE_WINDOW_MS, now);
    const spend = base
      ? chequebookSpendPer30Days(sent, BigInt(base.sent), now - base.ts)
      : null;

    const low = available < cfg.chequebookLowPlur;
    if (low) {
      await this.alerter.send({
        event: 'chequebook_low', level: 'warn',
        message: `Chequebook has ${plurToBzz(available).toFixed(4)} xBZZ spendable, below the ` +
                 `${plurToBzz(cfg.chequebookLowPlur).toFixed(4)} xBZZ floor. Uploads and retrievals ` +
                 `are paid from this — an empty chequebook degrades them silently rather than ` +
                 `expiring anything.`,
        details: { availableBzz: plurToBzz(available), floorBzz: plurToBzz(cfg.chequebookLowPlur) },
      });
    }

    return {
      totalBzz: plurToBzz(total),
      availableBzz: plurToBzz(available),
      sentBzz: plurToBzz(sent),
      receivedBzz: plurToBzz(received),
      spendPer30DaysBzz: spend == null ? null : plurToBzz(spend),
      runwayDays: chequebookRunwayDays(available, spend),
      windowMs: base ? now - base.ts : 0,
      peers: node?.chequePeers ?? 0,
      peersOwingUs: node?.peersOwingUs ?? 0,
      low,
    };
  }

  private async execute(plan: Extract<Plan, { kind: 'topup' | 'dilute' }>, batch?: Batch) {
    const kind = plan.kind === 'dilute' ? 'dilute' : 'topup';
    const amount = plan.kind === 'dilute' ? plan.thenTopup : plan.amountPerChunk;

    // Recorded before the call: if the process dies mid-transaction the ledger
    // shows `submitted`, which blocks a duplicate on the next poll.
    const id = this.db.recordAction({
      batchId: plan.batchId, appName: batch?.label ?? null, kind,
      amount, cost: plan.cost, status: 'submitted', reason: plan.reason, error: null,
    });

    try {
      if (plan.kind === 'dilute') {
        await this.bee.dilute(plan.batchId, plan.newDepth);
        // Closed the moment the dilute lands, BEFORE the follow-up top-up.
        //
        // These are two transactions, and the second failing used to leave the
        // first one's row `submitted` forever — which is what inFlightBatchIds()
        // reads, so the batch was locked out of the planner permanently. It
        // could then be neither topped up nor diluted again, and would quietly
        // run to expiry. Observed on t4t-v3: a dilute landed, the top-up did
        // not, and the batch sat blocked for hours with 24 days of life left
        // and no way to renew it.
        this.db.updateActionStatus(id, 'confirmed');
        await this.alerter.send({
          event: 'dilute_executed', level: 'info', batchId: plan.batchId,
          message: `Diluted to depth ${plan.newDepth}: ${plan.reason}`,
        });
        if (plan.thenTopup > 0n) {
          // Its own row, so its own failure is recorded against itself and
          // cannot strand the dilute that already succeeded.
          const topupId = this.db.recordAction({
            batchId: plan.batchId, appName: batch?.label ?? null, kind: 'topup',
            amount: plan.thenTopup, cost: plan.cost, status: 'submitted',
            reason: `restoring TTL after dilute to depth ${plan.newDepth}`, error: null,
          });
          await this.bee.topUp(plan.batchId, plan.thenTopup);
          this.db.updateActionStatus(topupId, 'confirmed');
        }
      } else {
        await this.bee.topUp(plan.batchId, plan.amountPerChunk);
        this.db.updateActionStatus(id, 'confirmed');
      }
      await this.alerter.send({
        event: 'topup_executed', level: 'info', batchId: plan.batchId,
        costBzz: plurToBzz(plan.cost),
        message: `${kind} on ${batch?.label || plan.batchId.slice(0, 12)}: ` +
                 `${plurToBzz(plan.cost).toFixed(3)} xBZZ — ${plan.reason}`,
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (e instanceof BeeIndeterminateError) {
        // Leave it `submitted`: the transaction may still be mined, and
        // `submitted` is what the in-flight check reads to refuse a retry.
        // Marking it failed here is how you buy the same thing twice.
        await this.alerter.send({
          event: 'topup_failed', level: 'error', batchId: plan.batchId,
          message: `${kind} on ${plan.batchId.slice(0, 12)}… timed out client-side. It may still ` +
                   `have been mined — left in-flight, NOT retried. Check the batch before acting.`,
        });
        return;
      }
      this.db.updateActionStatus(id, 'failed', msg);
      await this.alerter.send({
        event: 'topup_failed', level: 'error', batchId: plan.batchId,
        message: `${kind} failed on ${plan.batchId.slice(0, 12)}…: ${msg}`,
      });
    }
  }
}
