/**
 * The upload ceiling is a memory bound, not a policy: the request body is
 * buffered whole before being handed to Bee, inside a 512 MB container. These
 * pin the config so raising it stays a deliberate act, paired with the
 * container's memory limit.
 */
import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../src/config';

const base = { BEE_URL: 'http://bee:1633' };

describe('upload limits', () => {
  it('defaults to 32 MB', () => {
    expect(loadConfig(base as any).maxUploadBytes).toBe(32 * 1024 * 1024);
  });

  it('is overridable for a box with more memory', () => {
    expect(loadConfig({ ...base, MAX_UPLOAD_BYTES: String(64 * 1024 * 1024) } as any).maxUploadBytes)
      .toBe(64 * 1024 * 1024);
  });

  it('rejects a ceiling below one chunk', () => {
    // Anything under 4096 could not hold a single chunk, so it is certainly a
    // mistake rather than a deliberately tiny limit.
    expect(() => loadConfig({ ...base, MAX_UPLOAD_BYTES: '100' } as any)).toThrow();
  });

  it('gives uploads a timeout far above the read timeout', () => {
    const cfg = loadConfig(base as any);
    // The bug this guards: uploads shared the 15s read timeout, so any file
    // slow enough to exceed it failed regardless of size.
    expect(cfg.beeUploadTimeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(cfg.beeUploadTimeoutMs).toBeGreaterThan(cfg.beeTimeoutMs * 10);
  });
});
