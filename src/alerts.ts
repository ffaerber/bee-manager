/**
 * Outbound alerts via a single generic webhook (Discord/Slack/ntfy/n8n all
 * accept a JSON POST), deduplicated so a 5-minute poll cannot emit the same
 * warning 288 times a day.
 *
 * A blocked action is as important as an executed one: "I would have topped up
 * but the daily cap stopped me" is precisely the message that must not be lost.
 */

import type { Db } from './db';

export type AlertEvent =
  | 'batch_low'
  | 'batch_disappeared'
  | 'topup_executed'
  | 'topup_blocked'
  | 'topup_failed'
  | 'dilute_executed'
  | 'batch_bought'
  | 'wallet_low'
  | 'chequebook_low'
  | 'batch_full'
  | 'quota_exceeded'
  | 'node_unreachable'
  /** Distinct from node_unreachable: WE can reach it, the NETWORK cannot. */
  | 'node_undialable'
  /** Staked height and configured reserve doubling disagree. */
  | 'stake_height_mismatch';

export interface Alert {
  event: AlertEvent;
  level: 'info' | 'warn' | 'error';
  message: string;
  batchId?: string;
  app?: string;
  costBzz?: number;
  details?: Record<string, unknown>;
}

/** Events that should re-fire immediately once the condition clears. */
const CLEARABLE: AlertEvent[] = ['batch_low', 'wallet_low', 'node_unreachable', 'node_undialable', 'stake_height_mismatch'];

export class Alerter {
  constructor(
    private readonly db: Db,
    private readonly webhookUrl: string | null,
    private readonly cooldownMs: number,
  ) {}

  /** Dedup key — per event *and* subject, so two batches alert independently. */
  private key(a: Alert): string {
    return [a.event, a.app ?? '', a.batchId ?? ''].join(':');
  }

  /** Called when a condition no longer holds, so its next occurrence alerts at once. */
  clear(event: AlertEvent, subject: { app?: string; batchId?: string } = {}) {
    this.db.clearAlert(this.key({ event, level: 'info', message: '', ...subject }));
  }

  async send(alert: Alert): Promise<boolean> {
    // Errors bypass the cooldown for their first occurrence but are still keyed,
    // so a persistently failing node does not become a firehose.
    if (!this.db.shouldAlert(this.key(alert), this.cooldownMs)) return false;

    const line = `[${alert.level}] ${alert.event}: ${alert.message}`;
    console.log(line);
    if (!this.webhookUrl) return false;

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: alert.event,
          level: alert.level,
          message: alert.message,
          batchId: alert.batchId ?? null,
          app: alert.app ?? null,
          costBzz: alert.costBzz ?? null,
          details: alert.details ?? {},
          // Text field so chat webhooks that ignore structure still render usefully.
          text: line,
          ts: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return true;
    } catch (e: any) {
      // Never let alerting failure take down the poller — the alert is the
      // secondary concern; keeping the stamps alive is the primary one.
      console.error(`[alerts] webhook failed: ${e?.message ?? e}`);
      return false;
    }
  }

  isClearable(event: AlertEvent): boolean {
    return CLEARABLE.includes(event);
  }
}
