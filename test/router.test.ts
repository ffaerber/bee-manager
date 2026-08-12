/**
 * The batch route is matched against a strict 64-hex pattern rather than
 * anything after /batch/, because the same path space is shared with the Bee
 * passthrough: a loose match would route junk into the batch page, and the
 * server's own /batch/:id must not shadow node endpoints.
 */
import { describe, expect, it } from 'bun:test';
import { batchIdFrom } from '../web/src/router';

const ID = '49aebf397afc8b83306c15d459bf08ecfef9fb8304bcd6e01d4cbdd2fba7b3b2';

describe('batchIdFrom', () => {
  it('matches a batch path', () => {
    expect(batchIdFrom(`/batch/${ID}`)).toBe(ID);
  });

  it('tolerates a trailing slash', () => {
    expect(batchIdFrom(`/batch/${ID}/`)).toBe(ID);
  });

  it('normalises case, since batch ids are hex', () => {
    expect(batchIdFrom(`/batch/${ID.toUpperCase()}`)).toBe(ID);
  });

  it('is null for the overview', () => {
    expect(batchIdFrom('/')).toBeNull();
    expect(batchIdFrom('/index.html')).toBeNull();
  });

  it('rejects anything that is not a full batch id', () => {
    for (const p of [
      '/batch/',
      '/batch/abc',                    // too short
      `/batch/${ID}extra`,             // too long
      `/batch/${ID}/buckets`,          // a sub-path, not a page
      '/batch/../etc/passwd',
      `/batch/${ID.slice(0, 63)}g`,    // non-hex
    ]) {
      expect(batchIdFrom(p)).toBeNull();
    }
  });
});
