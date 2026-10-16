/**
 * Prometheus exposition for bee-manager.
 *
 * Served on its own port (METRICS_PORT), not on the public API port: wallet
 * balances and batch ids are nobody else's business, and the public port is
 * what Traefik routes to. Everything comes from the last poll and the local
 * database, so a scrape makes no Bee requests.
 */

import type { Db } from './db';
import type { PollResult } from './poller';
import { plurToBzz } from './math';

export interface Sample {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  values: { labels?: Record<string, string | number>; value: number }[];
}

function esc(v: string | number): string {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Prometheus text format 0.0.4. Metrics without samples are omitted. */
export function render(samples: Sample[]): string {
  const out: string[] = [];
  for (const s of samples) {
    if (!s.values.length) continue;
    out.push(`# HELP ${s.name} ${s.help}`, `# TYPE ${s.name} ${s.type}`);
    for (const { labels, value } of s.values) {
      const l = labels && Object.keys(labels).length
        ? `{${Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}`
        : '';
      out.push(`${s.name}${l} ${Number.isFinite(value) ? value : 'NaN'}`);
    }
  }
  return out.join('\n') + '\n';
}

const ACTION_STATUSES = ['submitted', 'confirmed', 'failed', 'blocked', 'dry-run', 'awaiting-topup'];

export function collect(last: PollResult | null, db: Db, now = Date.now()): Sample[] {
  const g = (name: string, help: string, values: Sample['values']): Sample => ({ name, help, type: 'gauge', values });
  const batches = last?.batches ?? [];
  const bl = (b: { batchID: string; label: string }) => ({ batch: b.batchID.slice(0, 12), label: b.label || '-' });

  const counts = db.actionCounts();
  const counts24 = db.actionCounts(now - 86_400_000);
  // Every kind seen ever × the known statuses, so a status that drops to zero
  // in the last 24 h shows 0 instead of vanishing (an alert on > 0 can resolve).
  const kinds = [...new Set(counts.map((c) => c.kind))];
  const grid = (rows: typeof counts) => kinds.flatMap((kind) => ACTION_STATUSES.map((status) => ({
    labels: { kind, status },
    value: rows.find((r) => r.kind === kind && r.status === status)?.n ?? 0,
  })));
  const ups = db.uploadStats(now - 86_400_000);

  return [
    g('beemgr_poll_ok', '1 if the last poll of the Bee node succeeded.', [{ value: last?.ok ? 1 : 0 }]),
    g('beemgr_last_poll_timestamp_seconds', 'Unix time of the last poll (successful or not).', last ? [{ value: last.polledAt / 1000 }] : []),
    g('beemgr_batches', 'Batches reported by the node.', [{ value: batches.length }]),
    g('beemgr_batch_ttl_seconds', 'Remaining batch lifetime.', batches.map((b) => ({ labels: bl(b), value: b.batchTTL }))),
    g('beemgr_batch_depth', 'Batch depth.', batches.map((b) => ({ labels: bl(b), value: b.depth }))),
    g('beemgr_batch_utilization_ratio', 'Fullest bucket / bucket capacity (1 = a bucket is full).', batches.map((b) => ({ labels: bl(b), value: b.utilizationRatio }))),
    g('beemgr_batch_usable', '1 if the node will stamp with this batch.', batches.map((b) => ({ labels: bl(b), value: b.usable ? 1 : 0 }))),
    g('beemgr_batch_immutable', '1 for an immutable batch.', batches.map((b) => ({ labels: bl(b), value: b.immutableFlag ? 1 : 0 }))),
    g('beemgr_batch_managed', '1 if this service tops it up / dilutes it automatically.', batches.map((b) => ({ labels: bl(b), value: db.isManaged(b.batchID) ? 1 : 0 }))),
    g('beemgr_wallet_bzz', 'Node wallet xBZZ balance.', last?.wallet ? [{ value: plurToBzz(last.wallet.bzzBalance) }] : []),
    g('beemgr_wallet_xdai', 'Node wallet xDAI balance (gas).', last?.wallet ? [{ value: Number(last.wallet.nativeTokenBalance) / 1e18 }] : []),
    g('beemgr_burn_bzz_per_30d', 'Postage burn across all batches, xBZZ per 30 days.', last ? [{ value: last.burnPer30DaysBzz }] : []),
    g('beemgr_wallet_runway_days', 'Days the wallet covers at the current burn.', last ? [{ value: last.runwayDays }] : []),
    g('beemgr_spent_bzz_24h', 'xBZZ spent on top-ups/dilutes in the last 24 h.', [{ value: plurToBzz(db.spentLast24h(now)) }]),
    g('beemgr_actions', 'Recorded actions by kind and status (all time).', grid(counts)),
    g('beemgr_actions_24h', 'Recorded actions by kind and status in the last 24 h.', grid(counts24)),
    g('beemgr_uploads_24h', 'Completed uploads per app in the last 24 h.', ups.map((u) => ({ labels: { app: u.app }, value: u.n }))),
    g('beemgr_upload_bytes_24h', 'Uploaded bytes per app in the last 24 h.', ups.map((u) => ({ labels: { app: u.app }, value: u.bytes }))),
  ];
}
