/**
 * Authentication for the public upload endpoint.
 *
 * Two callers, two mechanisms:
 *   - Deploy pipelines (Makefiles, CI) hold a real secret -> per-app API key.
 *   - Browser dapps cannot hold a secret -> the end user signs a message with
 *     the wallet they already use for contract calls.
 *
 * The signature binds the *content hash* and a timestamp, not just the app
 * name, so a captured signature cannot be replayed against different bytes or
 * days later. Note this authenticates but does not gate: addresses are free to
 * mint, so quotas do the actual limiting (see quota.ts).
 */

import { verifyMessage } from 'ethers';

/** How far a signed request's timestamp may drift before it is rejected. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

export type AuthResult =
  | { ok: true; address: string; via: 'signature' }
  | { ok: true; address: string; via: 'api-key' }
  | { ok: false; reason: string };

/** The exact string a client must sign. Keep in sync with any client SDK. */
export function signingMessage(app: string, contentSha256: string, timestamp: number): string {
  return [
    'swarm-stamp-monitor',
    `app:${app}`,
    `sha256:${contentSha256}`,
    `ts:${timestamp}`,
  ].join('\n');
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as any);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish comparison, to avoid leaking key material by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashApiKey(key: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(key));
}

export interface SignedRequest {
  app: string;
  contentSha256: string;
  address?: string;
  signature?: string;
  timestamp?: number;
  apiKey?: string;
}

export async function authenticate(
  req: SignedRequest,
  appApiKeyHash: string | null,
  now = Date.now(),
): Promise<AuthResult> {
  // API key path — for callers that can actually keep a secret.
  if (req.apiKey) {
    if (!appApiKeyHash) return { ok: false, reason: 'app has no API key configured' };
    const given = await hashApiKey(req.apiKey);
    if (!safeEqual(given, appApiKeyHash)) return { ok: false, reason: 'invalid API key' };
    return { ok: true, address: 'api-key', via: 'api-key' };
  }

  // Signature path — for browsers.
  if (!req.address || !req.signature || !req.timestamp) {
    return { ok: false, reason: 'provide either an API key, or address + signature + timestamp' };
  }
  const age = Math.abs(now - req.timestamp);
  if (age > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, reason: `signature timestamp is ${Math.round(age / 1000)}s out of date` };
  }

  let recovered: string;
  try {
    recovered = verifyMessage(signingMessage(req.app, req.contentSha256, req.timestamp), req.signature);
  } catch (e: any) {
    return { ok: false, reason: `signature could not be verified: ${e?.message ?? e}` };
  }
  if (recovered.toLowerCase() !== req.address.toLowerCase()) {
    return { ok: false, reason: 'signature does not match the given address' };
  }
  return { ok: true, address: recovered.toLowerCase(), via: 'signature' };
}
