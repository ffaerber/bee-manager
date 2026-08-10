/**
 * The daemon loop: read the node, record it, decide, and (only when explicitly
 * enabled) act.
 *
 * Ordering matters in two places. Dilution runs before its follow-up top-up,
 * because diluting halves remaining TTL. And an action is recorded as
 * `submitted` *before* the Bee call, so a crash mid-transaction leaves evidence
 * rather than a silent double-spend on the next poll.
 */

import { BeeClient, type Batch, type ChainState, type Wallet } from './bee';
import { Db } from './db';
import { Alerter } from './alerts';
import { evaluateAll, findDisappeared, totalBurnPer30Days, type EvalContext, type Plan } from './evaluate';
import { plurToBzz, runwaySeconds, GNOSIS_MS_PER_BLOCK } from './math';
import type { Config } from './config';

export interface PollResult {
  ok: boolean;
  batches: Batch[];
  chain?: ChainState;
  wallet?: Wallet;
  plans: Plan[];
  msPerBlock: number;
  burnPer30DaysBzz: number;
  runwayDays: number;
  error?: string;
}

export class Poller {
  private lastBlock: { block: number; at: number } | null = null;
  private msPerBlock = GNOSIS_MS_PER_BLOCK;
  private timer: Timer | null = null;
  last: PollResult | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly bee: BeeClient,
    private readonly db: Db,
    private readonly alerter: Alerter,
  ) {}

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
    let batches: Batch[], chain: ChainState, wallet: Wallet;
    try {
      [batches, chain, wallet] = await Promise.all([
        this.bee.stamps(), this.bee.chainstate(), this.bee.wallet(),
      ]);
      this.alerter.clear('node_unreachable');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      await this.alerter.send({ event: 'node_unreachable', level: 'error', message: `Bee unreachable: ${msg}` });
      this.last = { ok: false, batches: [], plans: [], msPerBlock: this.msPerBlock, burnPer30DaysBzz: 0, runwayDays: 0, error: msg };
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
    const runwayDays = runwaySeconds(wallet.bzzBalance, burn) / 86_400;

    if (runwayDays < this.cfg.walletLowRunwayDays) {
      await this.alerter.send({
        event: 'wallet_low', level: 'warn',
        message: `Wallet covers ~${runwayDays.toFixed(0)} more days at the current burn of ` +
                 `${plurToBzz(burn).toFixed(2)} BZZ/30d (balance ${plurToBzz(wallet.bzzBalance).toFixed(2)} BZZ).`,
        details: { runwayDays, burnPer30DaysBzz: plurToBzz(burn) },
      });
    } else {
      this.alerter.clear('wallet_low');
    }

    const ctx: EvalContext = {
      config: this.cfg, wallet, chain,
      spentLast24h: this.db.spentLast24h(now),
      inFlight: this.db.inFlightBatchIds(),
      msPerBlock: this.msPerBlock,
    };
    const plans = evaluateAll(managedBatches, ctx);
    for (const plan of plans) await this.handle(plan, batches);

    this.last = {
      ok: true, batches, chain, wallet, plans,
      msPerBlock: this.msPerBlock,
      burnPer30DaysBzz: plurToBzz(burn),
      runwayDays,
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
               `(${plurToBzz(plan.cost).toFixed(3)} BZZ)`,
    });

    if (!this.cfg.autoTopupEnabled || this.cfg.dryRun) {
      this.db.recordAction({
        batchId: plan.batchId, appName: batch?.label ?? null,
        kind: plan.kind === 'dilute' ? 'dilute' : 'topup',
        amount: plan.kind === 'dilute' ? plan.thenTopup : plan.amountPerChunk,
        cost: plan.cost, status: 'dry-run', reason: plan.reason, error: null,
      });
      console.log(`[poll] would ${plan.kind} ${plan.batchId.slice(0, 12)}… — ${plan.reason} ` +
                  `(${this.cfg.autoTopupEnabled ? 'DRY_RUN' : 'AUTO_TOPUP_ENABLED=false'})`);
      return;
    }

    await this.execute(plan, batch);
  }

  /** The only place in the codebase that spends money on a schedule. */
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
        await this.alerter.send({
          event: 'dilute_executed', level: 'info', batchId: plan.batchId,
          message: `Diluted to depth ${plan.newDepth}: ${plan.reason}`,
        });
        if (plan.thenTopup > 0n) await this.bee.topUp(plan.batchId, plan.thenTopup);
      } else {
        await this.bee.topUp(plan.batchId, plan.amountPerChunk);
      }
      this.db.updateActionStatus(id, 'confirmed');
      await this.alerter.send({
        event: 'topup_executed', level: 'info', batchId: plan.batchId,
        costBzz: plurToBzz(plan.cost),
        message: `${kind} on ${batch?.label || plan.batchId.slice(0, 12)}: ` +
                 `${plurToBzz(plan.cost).toFixed(3)} BZZ — ${plan.reason}`,
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.db.updateActionStatus(id, 'failed', msg);
      await this.alerter.send({
        event: 'topup_failed', level: 'error', batchId: plan.batchId,
        message: `${kind} failed on ${plan.batchId.slice(0, 12)}…: ${msg}`,
      });
    }
  }
}
