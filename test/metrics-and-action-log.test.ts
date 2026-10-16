import { describe, it, expect, beforeEach } from 'bun:test';
import { Db, formatActionLog } from '../src/db';
import { render, collect } from '../src/metrics';

const BATCH = 'ab'.repeat(32);
let db: Db;
let lines: string[];

beforeEach(() => {
  db = new Db(':memory:');
  lines = [];
  db.onActionLog = (l) => lines.push(l);
  db.seenBatch(BATCH, 't4t-gateway-v2', 18, false);
});

const action = (status: any, over: Record<string, unknown> = {}) => db.recordAction({
  batchId: BATCH, appName: null, kind: 'topup', amount: 1n, cost: 87_313_435_977_580_540n,
  status, reason: '100.0% full (over 90%), diluting to depth 19', error: null, ...over,
});

describe('action log lines (for Loki)', () => {
  it('writes one logfmt line per recorded action, with the batch label', () => {
    action('blocked');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('[action] id=1 kind=topup status=blocked batch=abababab');
    expect(lines[0]).toContain('label="t4t-gateway-v2"');
    expect(lines[0]).toContain('cost_bzz=8.7313');
    expect(lines[0]).toContain('reason="100.0% full (over 90%), diluting to depth 19"');
  });

  it('logs a status change, including the error', () => {
    const id = action('submitted');
    db.updateActionStatus(id, 'failed', 'cannot dilute batch');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('status=failed');
    expect(lines[1]).toContain('error="cannot dilute batch"');
  });

  it('does not log an update that changed nothing', () => {
    const id = action('confirmed');
    expect(db.updateActionStatus(id, 'failed', 'x', 'submitted')).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('escapes quotes and newlines so the line stays parseable', () => {
    const l = formatActionLog({ id: 1, kind: 'topup', status: 'failed', batchId: null, cost: 0n, error: 'bad "x"\nnext' });
    expect(l).toContain('error="bad \\"x\\" next"');
    expect(l).toContain('batch=-');
  });

  it('is silent without a hook (tests, scripts)', () => {
    db.onActionLog = undefined;
    expect(() => action('blocked')).not.toThrow();
  });
});

describe('metrics', () => {
  const last: any = {
    ok: true, polledAt: 1_790_000_000_000, plans: [], msPerBlock: 5000,
    burnPer30DaysBzz: 1.5, runwayDays: 120, totalRunwayDays: 300, committedBzz: 3,
    wallet: { bzzBalance: 25n * 10n ** 16n, nativeTokenBalance: 2n * 10n ** 18n, chainID: 100, walletAddress: '0x', chequebookContractAddress: '0x' },
    batches: [{ batchID: BATCH, label: 't4t-gateway-v2', depth: 18, utilizationRatio: 1, usable: true,
      immutableFlag: false, batchTTL: 86_400 * 20, utilization: 4, amount: 1n, bucketDepth: 16, blockNumber: 1, exists: true }],
  };

  it('exposes batch, wallet and action metrics', () => {
    action('blocked'); action('blocked'); action('confirmed');
    const txt = render(collect(last, db));
    expect(txt).toContain('beemgr_poll_ok 1');
    expect(txt).toContain('beemgr_batch_utilization_ratio{batch="abababababab",label="t4t-gateway-v2"} 1');
    expect(txt).toContain('beemgr_batch_ttl_seconds{batch="abababababab",label="t4t-gateway-v2"} 1728000');
    expect(txt).toContain('beemgr_wallet_bzz 25');
    expect(txt).toContain('beemgr_wallet_xdai 2');
    expect(txt).toContain('beemgr_actions{kind="topup",status="blocked"} 2');
    expect(txt).toContain('beemgr_actions{kind="topup",status="confirmed"} 1');
    // Zero rows are kept, so an alert on "failed > 0" can resolve.
    expect(txt).toContain('beemgr_actions_24h{kind="topup",status="failed"} 0');
  });

  it('still renders before the first poll', () => {
    const txt = render(collect(null, db));
    expect(txt).toContain('beemgr_poll_ok 0');
    expect(txt).not.toContain('beemgr_wallet_bzz');
  });
});
