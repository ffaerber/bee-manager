/**
 * Keeping references is the whole point: Swarm has no way to enumerate what a
 * batch holds, so a reference not recorded here is unreachable even though the
 * data is still stored and still being paid for.
 *
 * These also cover the migration, because the live database predates the
 * batch_id/name/content_type columns and must survive gaining them.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Db } from '../src/db';

const BATCH = '49aebf397afc8b83306c15d459bf08ecfef9fb8304bcd6e01d4cbdd2fba7b3b2';
const OTHER = 'aa'.repeat(32);

const fresh = () => new Db(':memory:');

describe('upload history', () => {
  it('records what is needed to fetch a file back', () => {
    const db = fresh();
    db.recordUpload('admin:t4t', 'dashboard', 1234, 'ref1',
      { batchId: BATCH, name: 'cat.png', contentType: 'image/png' });
    const [u] = db.uploadsForBatch(BATCH);
    expect(u.reference).toBe('ref1');
    expect(u.name).toBe('cat.png');
    expect(u.contentType).toBe('image/png');
    expect(u.bytes).toBe(1234);
    db.close();
  });

  it('scopes to the batch that stamped it', () => {
    const db = fresh();
    db.recordUpload('a', 'dashboard', 1, 'r1', { batchId: BATCH });
    db.recordUpload('a', 'dashboard', 1, 'r2', { batchId: OTHER });
    expect(db.uploadsForBatch(BATCH).map((u) => u.reference)).toEqual(['r1']);
    expect(db.uploadsForBatch(OTHER).map((u) => u.reference)).toEqual(['r2']);
    db.close();
  });

  it('lists newest first', () => {
    const db = fresh();
    db.recordUpload('a', 'd', 1, 'old', { batchId: BATCH }, 1_000);
    db.recordUpload('a', 'd', 1, 'new', { batchId: BATCH }, 9_000);
    expect(db.uploadsForBatch(BATCH).map((u) => u.reference)).toEqual(['new', 'old']);
    db.close();
  });

  it('omits rows with no reference — there would be nothing to fetch', () => {
    const db = fresh();
    db.recordUpload('a', 'd', 1, null, { batchId: BATCH });
    db.recordUpload('a', 'd', 1, 'r', { batchId: BATCH });
    expect(db.uploadsForBatch(BATCH).map((u) => u.reference)).toEqual(['r']);
    db.close();
  });

  it('still counts toward quota accounting', () => {
    // The columns were added to a table that exists for rate limiting; that
    // job must keep working unchanged.
    const db = fresh();
    db.recordUpload('app', '0xABC', 2048, 'r', { batchId: BATCH });
    expect(db.bytesUploaded('app')).toBe(2048);
    expect(db.uploadCount('app', 86_400_000, '0xabc')).toBe(1);
    db.close();
  });
});

describe('migration onto a pre-existing database', () => {
  /** The uploads table exactly as it shipped, without the new columns. */
  function legacy(path: string) {
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE uploads (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        INTEGER NOT NULL,
        app_name  TEXT NOT NULL,
        address   TEXT NOT NULL DEFAULT '',
        bytes     INTEGER NOT NULL,
        reference TEXT
      );
    `);
    raw.query(`INSERT INTO uploads (ts, app_name, address, bytes, reference)
               VALUES (1, 'legacy', '0x1', 99, 'oldref')`).run();
    raw.close();
  }

  it('adds the columns without losing existing rows', () => {
    const path = `/tmp/ssm-mig-${Date.now()}.sqlite`;
    legacy(path);
    const db = new Db(path);
    // The old row survives and still counts for quota. Its ts is 1, so the
    // window has to reach back to the epoch to include it.
    expect(db.bytesUploaded('legacy', Number.MAX_SAFE_INTEGER)).toBe(99);
    // It has no batch, so it appears under none — it never carried one.
    expect(db.uploadsForBatch(BATCH)).toEqual([]);
    // And new rows work.
    db.recordUpload('new', 'd', 5, 'r', { batchId: BATCH, name: 'x' });
    expect(db.uploadsForBatch(BATCH)).toHaveLength(1);
    db.close();
  });

  it('is idempotent — opening twice does not fail', () => {
    const path = `/tmp/ssm-mig2-${Date.now()}.sqlite`;
    legacy(path);
    new Db(path).close();
    const db = new Db(path);
    db.recordUpload('a', 'd', 1, 'r', { batchId: BATCH });
    expect(db.uploadsForBatch(BATCH)).toHaveLength(1);
    db.close();
  });
});
