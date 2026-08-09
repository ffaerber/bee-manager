import { describe, it, expect } from 'bun:test';
import { Wallet } from 'ethers';
import {
  authenticate, signingMessage, sha256Hex, hashApiKey, safeEqual, MAX_SIGNATURE_AGE_MS,
} from '../src/auth';

const wallet = Wallet.createRandom();
const APP = 'pinkchainsaw';
const body = new TextEncoder().encode('hello swarm');

async function signed(over: Record<string, any> = {}, now = Date.now()) {
  const contentSha256 = await sha256Hex(body);
  const timestamp = over.timestamp ?? now;
  const signature = over.signature ?? await wallet.signMessage(
    signingMessage(over.app ?? APP, over.contentSha256 ?? contentSha256, timestamp),
  );
  return {
    app: APP, contentSha256, address: wallet.address, signature, timestamp, ...over,
  };
}

describe('signature auth', () => {
  it('accepts a correctly signed request', async () => {
    const r = await authenticate(await signed(), null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.via).toBe('signature');
    expect(r.address).toBe(wallet.address.toLowerCase());
  });

  it('rejects a signature over different content — captured sigs cannot be reused', async () => {
    const req = await signed();
    req.contentSha256 = await sha256Hex(new TextEncoder().encode('different bytes'));
    const r = await authenticate(req, null);
    expect(r.ok).toBe(false);
  });

  it('rejects a signature for a different app', async () => {
    const req = await signed();
    req.app = 'freeemarket';
    expect((await authenticate(req, null)).ok).toBe(false);
  });

  it('rejects a stale timestamp, bounding the replay window', async () => {
    const now = Date.now();
    const req = await signed({}, now - MAX_SIGNATURE_AGE_MS - 1000);
    const r = await authenticate(req, null, now);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toContain('out of date');
  });

  it('rejects a future timestamp just as firmly', async () => {
    const now = Date.now();
    const req = await signed({}, now + MAX_SIGNATURE_AGE_MS + 1000);
    expect((await authenticate(req, null, now)).ok).toBe(false);
  });

  it('rejects a signature from a different wallet than claimed', async () => {
    const other = Wallet.createRandom();
    const req = await signed({ address: other.address });
    const r = await authenticate(req, null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toContain('does not match');
  });

  it('rejects malformed signatures without throwing', async () => {
    const req = await signed({ signature: '0xnotasignature' });
    const r = await authenticate(req, null);
    expect(r.ok).toBe(false);
  });

  it('requires all three signature fields', async () => {
    const r = await authenticate({ app: APP, contentSha256: 'x' }, null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toContain('API key');
  });
});

describe('api key auth', () => {
  it('accepts a correct key', async () => {
    const hash = await hashApiKey('s3cret');
    const r = await authenticate({ app: APP, contentSha256: 'x', apiKey: 's3cret' }, hash);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.via).toBe('api-key');
  });

  it('rejects a wrong key', async () => {
    const hash = await hashApiKey('s3cret');
    expect((await authenticate({ app: APP, contentSha256: 'x', apiKey: 'guess' }, hash)).ok).toBe(false);
  });

  it('rejects any key when the app has none configured', async () => {
    const r = await authenticate({ app: APP, contentSha256: 'x', apiKey: 'anything' }, null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toContain('no API key');
  });

  it('stores keys hashed, never in plaintext', async () => {
    const hash = await hashApiKey('s3cret');
    expect(hash).not.toContain('s3cret');
    expect(hash).toHaveLength(64);
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects differing ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('signingMessage', () => {
  it('is stable and includes every bound field', () => {
    const m = signingMessage('app', 'deadbeef', 1234);
    expect(m).toBe('swarm-stamp-monitor\napp:app\nsha256:deadbeef\nts:1234');
  });
});
