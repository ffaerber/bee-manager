/**
 * SWAP settlement — the money that pays for bandwidth.
 *
 * A separate card from the wallet because it fails differently. When the
 * wallet empties, batches stop being topped up and eventually expire, which
 * this service already watches for and shouts about. When the CHEQUEBOOK
 * empties nothing expires: the node simply stops being able to pay peers, and
 * uploads and retrievals degrade quietly. That is the harder failure to
 * notice, which is exactly why it is worth a card and an alert.
 *
 * Two things here are measured rather than reported, because Bee gives a
 * balance and nothing about its velocity — there is no chequebook equivalent
 * of batchTTL. The spend rate comes from comparing cumulative settlements
 * against a snapshot at least an hour old, and the runway from dividing the
 * spendable balance by that. Both read "measuring" until the history exists,
 * rather than dividing by a few seconds and printing noise.
 *
 * The rate is taken from settlements sent, not from the balance, on purpose:
 * the balance also moves when the chequebook is funded or a peer cashes a
 * cheque, so a deposit would read as negative spend and put the runway at
 * infinity at the exact moment someone topped up a chequebook about to run dry.
 */

import type { Chequebook as ChequebookData, State } from './api';
import { usdOf } from './App';
import { fmtDays } from './format';

/** Sub-xBZZ settlement figures need more places than a balance does. */
const fine = (n: number) => (n === 0 ? '0' : n < 0.01 ? n.toExponential(2) : n.toFixed(4));

export function Chequebook({ state }: { state: State }) {
  const c: ChequebookData | null = state.chequebook;
  // Absent on a node with the chequebook disabled, or when the endpoints could
  // not be read. Saying nothing beats inventing zeros.
  if (!c) return null;

  const fiat = (bzz: number) => {
    const usd = usdOf(bzz, state.fiat);
    return usd == null ? null : `≈ $${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
  };

  const hours = c.windowMs / 3_600_000;

  return (
    <div className="card">
      <div className="spread">
        <h2>Chequebook</h2>
        <span className={`status ${c.low ? 'warning' : 'good'}`}>
          {c.low ? 'below floor' : 'funded'}
        </span>
      </div>

      <div className="tiles">
        <div>
          <div className="tile-label">Spendable on bandwidth</div>
          <div className="tile-value">{c.availableBzz.toFixed(2)}<span className="tile-unit">xBZZ</span></div>
          <div className="tile-sub">{fiat(c.availableBzz) ?? 'outstanding cheques already deducted'}</div>
        </div>
        <div>
          <div className="tile-label">Total in the contract</div>
          <div className="tile-value">{c.totalBzz.toFixed(2)}<span className="tile-unit">xBZZ</span></div>
          <div className="tile-sub">including cheques written but not cashed</div>
        </div>
        <div>
          <div className="tile-label">Bandwidth per 30 days</div>
          <div className="tile-value">
            {c.spendPer30DaysBzz == null ? '—' : fine(c.spendPer30DaysBzz)}
            {c.spendPer30DaysBzz != null && <span className="tile-unit">xBZZ</span>}
          </div>
          <div className="tile-sub">
            {c.spendPer30DaysBzz == null
              ? 'measuring — needs an hour of history'
              : `measured over ${hours < 2 ? `${Math.round(c.windowMs / 60_000)} min` : `${hours.toFixed(0)} h`}`}
          </div>
        </div>
        <div>
          <div className="tile-label">Chequebook runway</div>
          {/* Three states, not two. "Not measured yet" is not the same claim as
              "never runs out", and rendering both as ∞ would assert the second
              while meaning the first — on a chequebook that might be minutes
              from empty. Unknown gets an em dash. */}
          <div className="tile-value">
            {c.spendPer30DaysBzz == null ? '—' : c.runwayDays == null ? '∞' : fmtDays(c.runwayDays)}
          </div>
          <div className="tile-sub">
            {c.spendPer30DaysBzz == null
              ? 'unknown until the rate is measured'
              : c.runwayDays == null ? 'nothing is being spent' : 'at the measured rate'}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--grid)', gap: 24 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          Lifetime paid out <strong className="mono">{fine(c.sentBzz)}</strong> xBZZ ·
          received <strong className="mono">{fine(c.receivedBzz)}</strong> xBZZ ·
          {' '}{c.peers} peer{c.peers === 1 ? '' : 's'} settled
          {c.peersOwingUs > 0 && ` · ${c.peersOwingUs} owe this node`}
        </span>
      </div>

      {c.low && (
        <div className="warn">
          The chequebook is below the floor set in settings. Nothing expires because of this — but the
          node pays peers from here for every upload and retrieval, so when it empties those degrade
          without anything failing outright. Funding it is a deposit to the chequebook contract, not
          to the wallet.
        </div>
      )}

      {/* Downloads are paid by the RETRIEVING node, which is why a publisher's
          chequebook barely moves and a heavy reader's drains. Worth stating:
          the asymmetry is the single most surprising thing about Swarm's
          bandwidth economics. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        Bandwidth is paid for by the node doing the retrieving, so serving your own uploads to
        others costs you nothing here — this drains when <em>this</em> node fetches or pushes data.
      </p>
    </div>
  );
}
