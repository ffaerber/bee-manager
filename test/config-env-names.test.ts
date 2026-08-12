/**
 * The environment variable names are a contract with the deployment, not
 * display text.
 *
 * This exists because a search-and-replace normalising the ticker from "BZZ" to
 * "xBZZ" across string literals also rewrote `MIN_WALLET_BZZ` to
 * `MIN_WALLET_xBZZ`. Nothing would have failed loudly: the live compose sets
 * MIN_WALLET_BZZ=20, the renamed lookup would have missed it, and the wallet
 * floor would have silently reverted to the 5 default — a spend guard quietly
 * loosened by a cosmetic edit.
 *
 * Pinning the names makes that class of accident a red test instead of a
 * surprise discovered from a balance.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Exactly the names the deployment sets. Changing one here means changing it
 *  in the homelab compose in the same commit — that is the point. */
const REQUIRED = [
  'BEE_URL',
  'DB_PATH',
  'AUTO_TOPUP_ENABLED',
  'DRY_RUN',
  'TOPUP_WHEN_TTL_BELOW_DAYS',
  'TOPUP_TARGET_TTL_DAYS',
  'MAX_TOPUP_BZZ_PER_BATCH',
  'MAX_TOPUP_BZZ_PER_DAY',
  'MIN_WALLET_BZZ',
  'MIN_WALLET_XDAI',
  'WALLET_LOW_RUNWAY_DAYS',
];

describe('config env var names', () => {
  const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');

  for (const name of REQUIRED) {
    it(`still reads ${name}`, () => {
      expect(src).toContain(`'${name}'`);
    });
  }

  it('has no ticker-renamed variants', () => {
    // The specific corruption that motivated this file, plus its siblings.
    for (const bad of ['MIN_WALLET_xBZZ', 'MAX_TOPUP_xBZZ_PER_BATCH', 'MAX_TOPUP_xBZZ_PER_DAY']) {
      expect(src).not.toContain(bad);
    }
  });
});
