import { describe, it, expect, beforeEach } from 'bun:test';
import { Db, type AppRow } from '../src/db';
import { checkQuota, chunksFor, limitsFor, DEFAULT_LIMITS, PIPELINE_LIMITS, type QuotaLimits } from '../src/quota';

const MB = 1024 * 1024;
const ADDR = '0xAbC0000000000000000000000000000000000001';

let db: Db;
const app: AppRow = {
  name: 'pinkchainsaw', policy: 'ephemeral', depth: 17, durationDays: 10,
  batchId: 'b1', budgetPlurPerDay: 0n, ensName: null, lastReference: null, apiKeyHash: null,
};
const limits: QuotaLimits = {
  maxUploadBytes: 5 * MB, appDailyBytes: 20 * MB, addressDailyBytes: 8 * MB, addressDailyUploads: 5,
};

beforeEach(() => { db = new Db(':memory:'); });

describe('chunksFor', () => {
  it('rounds partial chunks up — capacity is consumed in whole chunks', () => {
    expect(chunksFor(1)).toBe(1);
    expect(chunksFor(4096)).toBe(1);
    expect(chunksFor(4097)).toBe(2);
    expect(chunksFor(0)).toBe(0);
  });
});

describe('per-request limit', () => {
  it('accepts an upload within all limits', () => {
    const v = checkQuota(db, app, ADDR, 1 * MB, limits);
    expect(v.allowed).toBe(true);
  });

  it('rejects one larger than the per-request cap', () => {
    const v = checkQuota(db, app, ADDR, 6 * MB, limits);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('per-request limit');
  });

  it('rejects an empty upload', () => {
    expect(checkQuota(db, app, ADDR, 0, limits).allowed).toBe(false);
  });
});

describe('per-address limits', () => {
  it('blocks once the address byte allowance is used', () => {
    db.recordUpload(app.name, ADDR, 7 * MB, 'r');
    const v = checkQuota(db, app, ADDR, 2 * MB, limits);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('daily allowance');
  });

  it('blocks once the address upload count is reached', () => {
    for (let i = 0; i < 5; i++) db.recordUpload(app.name, ADDR, 1024, 'r');
    const v = checkQuota(db, app, ADDR, 1024, limits);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('uploads today');
  });

  it('treats addresses independently', () => {
    db.recordUpload(app.name, ADDR, 7 * MB, 'r');
    expect(checkQuota(db, app, '0xdead', 1 * MB, limits).allowed).toBe(true);
  });

  it('is case-insensitive about addresses, so casing cannot dodge a quota', () => {
    db.recordUpload(app.name, ADDR.toLowerCase(), 7 * MB, 'r');
    const v = checkQuota(db, app, ADDR.toUpperCase(), 2 * MB, limits);
    expect(v.allowed).toBe(false);
  });

  it('forgets usage older than the window', () => {
    const now = Date.now();
    db.recordUpload(app.name, ADDR, 8 * MB, 'r', now - 25 * 3_600_000);
    expect(checkQuota(db, app, ADDR, 1 * MB, limits, now).allowed).toBe(true);
  });
});

describe('per-app budget — the blast radius', () => {
  it('blocks every address once the shared daily budget is gone', () => {
    for (let i = 0; i < 5; i++) db.recordUpload(app.name, `0x${i}`, 4 * MB, 'r');
    const v = checkQuota(db, app, '0xfresh', 1 * MB, limits);
    expect(v.allowed).toBe(false);
    expect(v.appBudgetExhausted).toBe(true);
    expect(v.reason).toContain('daily budget');
  });

  it('caps the damage a Sybil attacker can do — fresh addresses do not help', () => {
    // Each address stays under its own allowance, but the app budget still binds.
    for (let i = 0; i < 20; i++) db.recordUpload(app.name, `0xsybil${i}`, 1 * MB, 'r');
    expect(checkQuota(db, app, '0xsybil999', 1 * MB, limits).allowed).toBe(false);
  });

  it('scopes budgets per app, so one dapp cannot exhaust another', () => {
    for (let i = 0; i < 5; i++) db.recordUpload('other-app', `0x${i}`, 4 * MB, 'r');
    expect(checkQuota(db, app, ADDR, 1 * MB, limits).allowed).toBe(true);
  });

  it('reports remaining allowances so a client can back off', () => {
    db.recordUpload(app.name, ADDR, 2 * MB, 'r');
    const v = checkQuota(db, app, ADDR, 1 * MB, limits);
    expect(v.remaining.appBytes).toBe(18 * MB);
    expect(v.remaining.addressBytes).toBe(6 * MB);
    expect(v.remaining.addressUploads).toBe(4);
  });
});

describe('defaults', () => {
  it('ship conservatively — a single upload cannot exceed the app budget', () => {
    expect(DEFAULT_LIMITS.maxUploadBytes).toBeLessThan(DEFAULT_LIMITS.appDailyBytes);
    expect(DEFAULT_LIMITS.addressDailyBytes).toBeLessThanOrEqual(DEFAULT_LIMITS.appDailyBytes);
  });
});

describe('limits by authentication method', () => {
  it('gives a deploy pipeline room for a whole site tar', () => {
    // pinkchainsaw's build is ~900 kB, but a media-heavy site is tens of MB —
    // the browser-facing 5 MB cap would reject a legitimate deploy.
    const pipeline = limitsFor(app, 'api-key');
    expect(pipeline.maxUploadBytes).toBe(64 * MB);
    expect(checkQuota(db, app, 'ci', 40 * MB, pipeline).allowed).toBe(true);
  });

  it('keeps browser callers on the small cap', () => {
    const browser = limitsFor(app, 'signature');
    expect(browser.maxUploadBytes).toBe(5 * MB);
    expect(checkQuota(db, app, ADDR, 40 * MB, browser).allowed).toBe(false);
  });

  it('defaults to the browser limits when the method is unknown', () => {
    expect(limitsFor(app).maxUploadBytes).toBe(DEFAULT_LIMITS.maxUploadBytes);
  });

  it('does NOT raise the shared app budget for pipelines — it bounds a bad day for both', () => {
    expect(limitsFor(app, 'api-key').appDailyBytes).toBe(limitsFor(app, 'signature').appDailyBytes);
  });

  it('still stops a pipeline once the shared app budget is gone', () => {
    for (let i = 0; i < 5; i++) db.recordUpload(app.name, `0x${i}`, 60 * MB, 'r');
    const v = checkQuota(db, app, 'ci', 10 * MB, limitsFor(app, 'api-key'));
    expect(v.allowed).toBe(false);
    expect(v.appBudgetExhausted).toBe(true);
  });
});
