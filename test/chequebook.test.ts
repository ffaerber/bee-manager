/**
 * Chequebook spend rate and runway.
 *
 * The rate comes from cumulative settlements rather than from the balance,
 * because the balance also moves for reasons that are not spending. These pin
 * that distinction, since getting it wrong reports "infinite runway" at exactly
 * the moment someone funds a chequebook that is about to run dry.
 */

import { describe, expect, it } from 'bun:test';
import { chequebookRunwayDays, chequebookSpendPer30Days } from '../src/math';

const H = 3_600_000, D = 86_400_000;
const xbzz = (n: number) => BigInt(Math.round(n * 1e16));

describe('chequebookSpendPer30Days', () => {
  it('scales the window up to 30 days', () => {
    // 0.001 xBZZ in an hour -> 0.72 xBZZ per 30 days.
    expect(chequebookSpendPer30Days(xbzz(0.001), 0n, H)).toBe(xbzz(0.72));
  });

  it('measures only what was sent in the window', () => {
    expect(chequebookSpendPer30Days(xbzz(5), xbzz(4), 30 * D)).toBe(xbzz(1));
  });

  it('is zero when nothing was sent', () => {
    expect(chequebookSpendPer30Days(xbzz(4), xbzz(4), 30 * D)).toBe(0n);
  });

  it('refuses a backwards counter rather than reporting negative spend', () => {
    // A redeployed node or a wiped DB, not a refund.
    expect(chequebookSpendPer30Days(xbzz(1), xbzz(9), 30 * D)).toBeNull();
  });

  it('refuses a zero or negative window', () => {
    expect(chequebookSpendPer30Days(xbzz(5), xbzz(4), 0)).toBeNull();
    expect(chequebookSpendPer30Days(xbzz(5), xbzz(4), -1)).toBeNull();
  });
});

describe('chequebookRunwayDays', () => {
  it('divides the balance by the rate', () => {
    // 10 xBZZ available, 1 xBZZ per 30 days -> 300 days.
    expect(chequebookRunwayDays(xbzz(10), xbzz(1))).toBeCloseTo(300, 3);
  });

  it('is null, not Infinity, when nothing is being spent', () => {
    // Infinity does not survive JSON.stringify -- it arrives as null anyway,
    // so the absence is explicit here rather than discovered on the client.
    expect(chequebookRunwayDays(xbzz(10), 0n)).toBeNull();
    expect(chequebookRunwayDays(xbzz(10), null)).toBeNull();
  });

  it('reports zero when the chequebook is empty and still spending', () => {
    expect(chequebookRunwayDays(0n, xbzz(1))).toBe(0);
  });

  it('survives the real figures from the node', () => {
    // Live readings: 9.93 xBZZ available, 0.0715 xBZZ sent over the node's
    // whole life. At that lifetime rate the chequebook lasts a very long time,
    // which is the honest answer -- this node barely settles.
    const spend = chequebookSpendPer30Days(71_494_400_000_4400n, 0n, 90 * D);
    expect(spend).not.toBeNull();
    expect(chequebookRunwayDays(99_285_055_999_995_600n, spend)!).toBeGreaterThan(1000);
  });
});
