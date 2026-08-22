import type { State } from './api';
import { TOKEN } from './api';

/**
 * Staking, which has nothing to do with the wallet.
 *
 * It lived as a tile in the wallet card, next to the spendable balance and the
 * gas, which put three unrelated things under one heading. xBZZ being the unit
 * is the only thing they share:
 *
 *   wallet      spendable — buys postage, so YOUR data gets stored
 *   chequebook  pays peers for BANDWIDTH, in either direction
 *   stake       collateral to be PAID for storing other people's data
 *
 * The distinction that actually matters: staking is not storing. The reserve on
 * disk is the storing, and it happens whether or not anything is staked — the
 * gateway node holds 18 GB and has never staked a token, so it serves the
 * network for free. The stake is what makes that work eligible for reward.
 */
export function Staking({ state }: { state: State | null }) {
  const s = state?.stake;
  const doubling = state?.reserveCapacityDoubling;
  // Deposited, as Bee reports it. The chain splits this into an effective part
  // and a withdrawable remainder, and those two are what move.
  const deposited = state?.wallet?.stakedBzz ?? null;

  if (!s && deposited == null) return null;

  const mismatch = s && doubling != null && s.height !== doubling;
  const staked = !!s && s.effectiveBzz > 0;
  /** 2^(22+height) chunks of 4 KB. Height 0 is ~17.2 GB, height 1 ~34.4 GB. */
  const reserveGb = doubling != null
    ? (Math.pow(2, 22 + doubling) * 4096) / 1e9
    : null;

  return (
    <div className="card">
      <div className="card-head">
        <div className="spread">
          <h2>Staking</h2>
          <span className={`status ${staked ? 'good' : 'warning'}`}>
            {staked ? 'earning eligible' : 'not staked'}
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Collateral that makes storing other people's data eligible for reward. Separate from the
          wallet, and separate from the chequebook — this one is not spent, it is locked.
        </p>
      </div>

      {/* The state worth interrupting for: storing without collateral. The node
          serves the network exactly as it would staked, and earns nothing,
          with no local signal that anything is wrong. */}
      {!staked && (
        <div className="banner warn" style={{ marginBottom: 18 }}>
          This node holds a reserve and serves it, but has nothing staked, so it cannot win a
          redistribution round. It is storing for the network for free.
        </div>
      )}

      {mismatch && (
        <div className="banner warn err" style={{ marginBottom: 18 }}>
          Staked height {s!.height} does not match reserve-capacity-doubling {doubling}. These are
          one setting in two places — the stake collateralises the reserve size.
        </div>
      )}

      <div className="tiles">
        <div>
          <div className="tile-label">Deposited</div>
          <div className="tile-value">
            {deposited != null ? deposited.toFixed(2) : '—'}<span className="tile-unit">{TOKEN}</span>
          </div>
          <div className="tile-sub">what was put in</div>
        </div>
        <div>
          <div className="tile-label">Effective</div>
          <div className="tile-value">
            {s ? s.effectiveBzz.toFixed(2) : '—'}<span className="tile-unit">{TOKEN}</span>
          </div>
          {/* Not a rounding of the deposit: the contract recomputes which part
              is genuinely collateralising, and it drifts on its own. */}
          <div className="tile-sub">the part actually collateralising</div>
        </div>
        <div>
          <div className="tile-label">Withdrawable</div>
          <div className="tile-value" style={{ fontSize: 18 }}>
            {s ? s.withdrawableBzz.toFixed(4) : '—'}<span className="tile-unit">{TOKEN}</span>
          </div>
          {/* A residual, not a dial. There is no "reduce my stake to X": you can
              only take whatever happens to be uncommitted, and that shrinks by
              itself as the effective portion grows. */}
          <div className="tile-sub">surplus, not a target</div>
        </div>
        <div>
          <div className="tile-label">Height</div>
          <div className="tile-value" style={{ fontSize: 18 }}>
            {s ? s.height : '—'}
            {doubling != null && (
              <span className="tile-unit" style={{ color: mismatch ? 'var(--critical)' : undefined }}>
                / doubling {doubling}
              </span>
            )}
          </div>
          <div className="tile-sub">
            {reserveGb != null ? `reserve ${reserveGb.toFixed(1)} GB` : 'must match the node config'}
          </div>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
        Height and reserve size are one decision: the contract takes it as an argument to the stake
        itself (<code>manageStake(nonce, amount, height)</code>), and the node must run with the
        matching <code>--reserve-capacity-doubling</code>. Only 0 and 1 are accepted by Bee 2.8,
        so the reserve is either ~17.2 GB or ~34.4 GB.
      </p>
    </div>
  );
}
