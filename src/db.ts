/**
 * SQLite persistence.
 *
 * The single most important job here is remembering batch IDs. Expired batches
 * vanish from `GET /stamps` outright — without a local record, a batch that
 * lapsed and a batch that never existed look identical, and the lapse that took
 * pinkchainsaw down would be invisible after the fact.
 *
 * PLUR values are stored as TEXT. SQLite integers are 64-bit and a depth-24
 * batch cost is ~1e18, which fits, but the *sum* over a day does not reliably —
 * and JS would read them back as lossy Numbers regardless.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type ActionKind = 'topup' | 'dilute' | 'buy';
export type ActionStatus = 'planned' | 'submitted' | 'confirmed' | 'failed' | 'blocked' | 'dry-run';

export interface ActionRow {
  id: number;
  ts: number;
  batchId: string | null;
  appName: string | null;
  kind: ActionKind;
  amount: bigint;
  cost: bigint;
  status: ActionStatus;
  reason: string;
  error: string | null;
}

export interface AppRow {
  name: string;
  policy: 'ephemeral' | 'permanent';
  depth: number;
  durationDays: number;
  batchId: string | null;
  budgetPlurPerDay: bigint;
  ensName: string | null;
  lastReference: string | null;
  apiKeyHash: string | null;
}

export class Db {
  private db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id    TEXT PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        depth       INTEGER NOT NULL,
        immutable   INTEGER NOT NULL DEFAULT 0,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        gone_at     INTEGER,
        -- 0 = leave this batch alone entirely: no top-up, no dilution, and no
        -- low-TTL or disappeared alerts. For deliberately short-lived stamps
        -- ("share a file, let it expire") where renewal would be the bug.
        managed     INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id      TEXT NOT NULL,
        ts            INTEGER NOT NULL,
        ttl           INTEGER NOT NULL,
        amount        TEXT NOT NULL,
        depth         INTEGER NOT NULL,
        utilization   REAL NOT NULL,
        price         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_batch_ts ON snapshots (batch_id, ts DESC);
      CREATE TABLE IF NOT EXISTS actions (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        batch_id  TEXT,
        app_name  TEXT,
        kind      TEXT NOT NULL,
        amount    TEXT NOT NULL,
        cost      TEXT NOT NULL,
        status    TEXT NOT NULL,
        reason    TEXT NOT NULL DEFAULT '',
        error     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions (ts DESC);
      CREATE TABLE IF NOT EXISTS apps (
        name              TEXT PRIMARY KEY,
        policy            TEXT NOT NULL,
        depth             INTEGER NOT NULL,
        duration_days     INTEGER NOT NULL,
        batch_id          TEXT,
        budget_per_day    TEXT NOT NULL DEFAULT '0',
        ens_name          TEXT,
        last_reference    TEXT,
        api_key_hash      TEXT
      );
      CREATE TABLE IF NOT EXISTS alerts_sent (
        key     TEXT PRIMARY KEY,
        ts      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        app_name  TEXT NOT NULL,
        address   TEXT NOT NULL DEFAULT '',
        bytes     INTEGER NOT NULL,
        reference TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_uploads_app_ts  ON uploads (app_name, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_uploads_addr_ts ON uploads (address, ts DESC);
    `);

    // SQLite has no ADD COLUMN IF NOT EXISTS, and a database created before
    // `managed` existed will not have it. Add it once, defaulting to managed so
    // upgrading never silently stops maintaining a batch someone relies on.
    const cols = this.db.query(`PRAGMA table_info(batches)`).all() as any[];
    if (!cols.some((c) => c.name === 'managed')) {
      this.db.exec(`ALTER TABLE batches ADD COLUMN managed INTEGER NOT NULL DEFAULT 1`);
    }
  }

  close() { this.db.close(); }

  // ── batches ──────────────────────────────────────────────────────────

  /** Record that a batch is currently live, and clear any prior gone marker. */
  seenBatch(batchId: string, label: string, depth: number, immutable: boolean, now = Date.now()) {
    this.db.query(`
      INSERT INTO batches (batch_id, label, depth, immutable, first_seen, last_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(batch_id) DO UPDATE SET
        last_seen = ?5, label = ?2, depth = ?3, immutable = ?4, gone_at = NULL
    `).run(batchId, label, depth, immutable ? 1 : 0, now);
  }

  /** Batch IDs we have seen and not yet recorded as gone. */
  liveKnownBatchIds(): string[] {
    return this.db.query(`SELECT batch_id FROM batches WHERE gone_at IS NULL`)
      .all().map((r: any) => r.batch_id);
  }

  /**
   * Batches explicitly excluded from management. The poller neither tops these
   * up nor alerts on them — an expiry is the intended outcome, not an incident.
   */
  unmanagedBatchIds(): Set<string> {
    const rows = this.db.query(`SELECT batch_id FROM batches WHERE managed = 0`).all() as any[];
    return new Set(rows.map((r) => r.batch_id));
  }

  /**
   * Update the cached label. The poller refreshes this from the node on every
   * tick anyway; writing it here just avoids the dashboard showing a stale name
   * for up to one poll interval after a rename.
   */
  setLabel(batchId: string, label: string): boolean {
    const res = this.db.query(`UPDATE batches SET label = ? WHERE batch_id = ?`).run(label, batchId);
    return res.changes > 0;
  }

  isManaged(batchId: string): boolean {
    const r = this.db.query(`SELECT managed FROM batches WHERE batch_id = ?`).get(batchId) as any;
    return r ? r.managed === 1 : true; // unknown batches default to managed
  }

  /** Returns false if the batch is not known yet. */
  setManaged(batchId: string, managed: boolean): boolean {
    const res = this.db.query(`UPDATE batches SET managed = ? WHERE batch_id = ?`)
      .run(managed ? 1 : 0, batchId);
    return res.changes > 0;
  }

  batches(): { batchId: string; label: string; depth: number; managed: boolean; goneAt: number | null }[] {
    return this.db.query(`SELECT batch_id, label, depth, managed, gone_at FROM batches ORDER BY label`)
      .all().map((r: any) => ({
        batchId: r.batch_id, label: r.label, depth: r.depth,
        managed: r.managed === 1, goneAt: r.gone_at,
      }));
  }

  /** Mark a batch as vanished. Returns false if it was already marked. */
  markGone(batchId: string, now = Date.now()): boolean {
    const res = this.db.query(
      `UPDATE batches SET gone_at = ?2 WHERE batch_id = ?1 AND gone_at IS NULL`,
    ).run(batchId, now);
    return res.changes > 0;
  }

  recordSnapshot(batchId: string, ttl: number, amount: bigint, depth: number, utilization: number, price: bigint, now = Date.now()) {
    this.db.query(`
      INSERT INTO snapshots (batch_id, ts, ttl, amount, depth, utilization, price)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(batchId, now, ttl, amount.toString(), depth, utilization, price.toString());
  }

  snapshots(batchId: string, limit = 500) {
    return this.db.query(
      `SELECT ts, ttl, amount, depth, utilization, price FROM snapshots
       WHERE batch_id = ? ORDER BY ts DESC LIMIT ?`,
    ).all(batchId, limit).map((r: any) => ({ ...r, amount: BigInt(r.amount), price: BigInt(r.price) }));
  }

  /** Drop snapshots older than `days` so the file does not grow without bound. */
  pruneSnapshots(days = 90, now = Date.now()) {
    this.db.query(`DELETE FROM snapshots WHERE ts < ?`).run(now - days * 86_400_000);
  }

  // ── actions / spend ledger ───────────────────────────────────────────

  recordAction(a: Omit<ActionRow, 'id' | 'ts'> & { ts?: number }): number {
    const res = this.db.query(`
      INSERT INTO actions (ts, batch_id, app_name, kind, amount, cost, status, reason, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      a.ts ?? Date.now(), a.batchId, a.appName, a.kind,
      a.amount.toString(), a.cost.toString(), a.status, a.reason, a.error,
    );
    return Number(res.lastInsertRowid);
  }

  updateActionStatus(id: number, status: ActionStatus, error?: string) {
    this.db.query(`UPDATE actions SET status = ?, error = ? WHERE id = ?`).run(status, error ?? null, id);
  }

  /**
   * PLUR actually committed in the trailing 24h. Counts only actions that were
   * or may still be real spends — a blocked or dry-run action never moved money
   * and must not consume the budget, or the daemon would throttle itself on
   * actions it declined to take.
   */
  spentLast24h(now = Date.now(), appName?: string): bigint {
    const rows = this.db.query(
      `SELECT cost FROM actions
       WHERE ts > ? AND status IN ('submitted','confirmed')
         AND (?2 IS NULL OR app_name = ?2)`,
    ).all(now - 86_400_000, appName ?? null) as any[];
    return rows.reduce((sum, r) => sum + BigInt(r.cost), 0n);
  }

  /** Batches with a submitted-but-unconfirmed action. */
  inFlightBatchIds(): Set<string> {
    const rows = this.db.query(
      `SELECT DISTINCT batch_id FROM actions WHERE status = 'submitted' AND batch_id IS NOT NULL`,
    ).all() as any[];
    return new Set(rows.map((r) => r.batch_id));
  }

  recentActions(limit = 100): ActionRow[] {
    return this.db.query(`SELECT * FROM actions ORDER BY ts DESC LIMIT ?`).all(limit).map(toAction);
  }

  // ── apps ─────────────────────────────────────────────────────────────

  upsertApp(app: Omit<AppRow, 'lastReference'> & { lastReference?: string | null }) {
    this.db.query(`
      INSERT INTO apps (name, policy, depth, duration_days, batch_id, budget_per_day, ens_name, last_reference, api_key_hash)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(name) DO UPDATE SET
        policy = ?2, depth = ?3, duration_days = ?4, batch_id = COALESCE(?5, batch_id),
        budget_per_day = ?6, ens_name = ?7, api_key_hash = COALESCE(?9, api_key_hash)
    `).run(
      app.name, app.policy, app.depth, app.durationDays, app.batchId,
      app.budgetPlurPerDay.toString(), app.ensName, app.lastReference ?? null, app.apiKeyHash,
    );
  }

  /**
   * Find an app by its API key hash. Needed by the Bee-compatible routes, where
   * Bee's own API has no place to name an app — the key is the only identifier
   * the request carries.
   */
  appByApiKeyHash(hash: string): AppRow | null {
    const r = this.db.query(`SELECT * FROM apps WHERE api_key_hash = ?`).get(hash) as any;
    return r ? toApp(r) : null;
  }

  app(name: string): AppRow | null {
    const r = this.db.query(`SELECT * FROM apps WHERE name = ?`).get(name) as any;
    return r ? toApp(r) : null;
  }

  apps(): AppRow[] {
    return this.db.query(`SELECT * FROM apps ORDER BY name`).all().map(toApp);
  }

  setAppBatch(name: string, batchId: string) {
    this.db.query(`UPDATE apps SET batch_id = ? WHERE name = ?`).run(batchId, name);
  }

  setAppReference(name: string, reference: string) {
    this.db.query(`UPDATE apps SET last_reference = ? WHERE name = ?`).run(reference, name);
  }

  /**
   * Remove an app from the registry. Returns false if it was not there.
   *
   * Deliberately touches ONLY the registry row. It does not unmanage, dilute or
   * abandon the batch: several apps may share one batch, so removing an app
   * must never imply retiring a stamp that something else is still uploading
   * with. Retiring a batch is a separate, explicit act.
   *
   * Upload history is kept too — the ledger is an audit trail, and deleting it
   * because a name was retired would let a re-registered name start with a
   * clean daily quota.
   */
  deleteApp(name: string): boolean {
    const res = this.db.query(`DELETE FROM apps WHERE name = ?`).run(name);
    return res.changes > 0;
  }

  /** Apps grouped by the batch they upload with — several may share one. */
  appsByBatch(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const a of this.apps()) {
      const key = a.batchId ?? '(none)';
      (out[key] ??= []).push(a.name);
    }
    return out;
  }

  // ── uploads / quota accounting ───────────────────────────────────────

  recordUpload(appName: string, address: string, bytes: number, reference: string | null, now = Date.now()) {
    this.db.query(
      `INSERT INTO uploads (ts, app_name, address, bytes, reference) VALUES (?, ?, ?, ?, ?)`,
    ).run(now, appName, address.toLowerCase(), bytes, reference);
  }

  /** Bytes uploaded in the trailing window, optionally scoped to an address. */
  bytesUploaded(appName: string, windowMs = 86_400_000, address?: string, now = Date.now()): number {
    const row = this.db.query(
      `SELECT COALESCE(SUM(bytes), 0) AS total FROM uploads
       WHERE app_name = ?1 AND ts > ?2 AND (?3 IS NULL OR address = ?3)`,
    ).get(appName, now - windowMs, address?.toLowerCase() ?? null) as any;
    return Number(row?.total ?? 0);
  }

  /** Upload count in the trailing window, for per-address rate limiting. */
  uploadCount(appName: string, windowMs = 86_400_000, address?: string, now = Date.now()): number {
    const row = this.db.query(
      `SELECT COUNT(*) AS n FROM uploads
       WHERE app_name = ?1 AND ts > ?2 AND (?3 IS NULL OR address = ?3)`,
    ).get(appName, now - windowMs, address?.toLowerCase() ?? null) as any;
    return Number(row?.n ?? 0);
  }

  // ── alert dedup ──────────────────────────────────────────────────────

  /** True if this alert key has not fired within `cooldownMs`. Records it if so. */
  shouldAlert(key: string, cooldownMs: number, now = Date.now()): boolean {
    const row = this.db.query(`SELECT ts FROM alerts_sent WHERE key = ?`).get(key) as any;
    if (row && now - row.ts < cooldownMs) return false;
    this.db.query(
      `INSERT INTO alerts_sent (key, ts) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET ts = ?2`,
    ).run(key, now);
    return true;
  }

  /** Clear a dedup key so the next occurrence alerts immediately. */
  clearAlert(key: string) {
    this.db.query(`DELETE FROM alerts_sent WHERE key = ?`).run(key);
  }
}

function toAction(r: any): ActionRow {
  return {
    id: r.id, ts: r.ts, batchId: r.batch_id, appName: r.app_name, kind: r.kind,
    amount: BigInt(r.amount), cost: BigInt(r.cost), status: r.status,
    reason: r.reason, error: r.error,
  };
}

function toApp(r: any): AppRow {
  return {
    name: r.name, policy: r.policy, depth: r.depth, durationDays: r.duration_days,
    batchId: r.batch_id, budgetPlurPerDay: BigInt(r.budget_per_day),
    ensName: r.ens_name, lastReference: r.last_reference, apiKeyHash: r.api_key_hash,
  };
}
