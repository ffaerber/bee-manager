import { shortAddr } from './format';
/**
 * The node's wallet, and how to put money into it.
 *
 * This service started as a stamp monitor and has become closer to a node
 * manager, so the wallet stopped being a single tile's worth of information.
 *
 * The point it exists to make: xBZZ lives in three places and only one of them
 * can buy postage.
 *
 *   wallet      spendable — this is what the WALLET runway is computed from
 *               (the hero's total runway adds the batches' prepaid value)
 *   chequebook  bandwidth settlement with other nodes — its own card below,
 *               because it is monitored rather than merely held
 *   stake       collateral for storing OTHER people's data — its own card,
 *               because it is not wallet money in any useful sense: it is not
 *               spendable, not spent, and not related to buying postage
 *
 * Showing only the wallet made the balance look smaller than it is; showing all
 * three without saying which is spendable would be worse. So each is labelled
 * with what it can actually do, and the two that are not the wallet have moved
 * out of this card entirely.
 *
 * Deliberately absent: a token contract address. Getting one wrong sends funds
 * nowhere recoverable, and there is no way to read it from the Bee API to
 * confirm — so the page links to the explorer, where the real token can be seen
 * against this address, rather than printing a constant that looks
 * authoritative because it is on screen.
 */

import { useState } from 'react';
import type { State } from './api';
import { usdOf } from './App';

/** Gnosis. Anything else and the deposit instructions would be wrong. */
const GNOSIS_CHAIN_ID = 100;

export function Wallet({ state }: { state: State }) {
  const w = state.wallet;
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  if (!w) return null;

  const onGnosis = w.chainId === GNOSIS_CHAIN_ID;
  const explorer = (addr: string) => `https://gnosisscan.io/address/${addr}`;

  function copy(what: string, value: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(what); setTimeout(() => setCopied(null), 1500);
    }).catch(() => { /* clipboard blocked; the address is visible anyway */ });
  }

  const fiat = (bzz: number | null | undefined) => {
    const usd = usdOf(bzz ?? undefined, state.fiat);
    return usd == null ? null : ` ≈ $${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
  };

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2>Bee wallet</h2>
        <button onClick={() => setShow(!show)}>{show ? 'Hide deposit details' : 'Add funds'}</button>
      </div>

      <div className="tiles">
        <div>
          <div className="tile-label">Spendable on postage</div>
          <div className="tile-value">{w.bzz.toFixed(2)}<span className="tile-unit">xBZZ</span></div>
          <div className="tile-sub">{fiat(w.bzz) ?? 'the wallet balance'}</div>
        </div>
        <div>
          <div className="tile-label">Gas</div>
          <div className="tile-value">{w.xdai.toFixed(2)}<span className="tile-unit">xDAI</span></div>
          <div className="tile-sub">every purchase needs some</div>
        </div>
      </div>

      {/* The market quote sits with the balances it prices. It was under the
          batch tiles, which is where the SPEND is, not where the holding is —
          and the number it converts is the wallet balance directly above. */}
      {state?.fiat && <PriceNote fiat={state.fiat} />}

      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <span className="tile-label">Address</span>
        <button className="reflink" title={w.address} onClick={() => copy('address', w.address)}>
          {copied === 'address' ? 'copied' : shortAddr(w.address)}
        </button>
        <a className="backlink" href={explorer(w.address)} target="_blank" rel="noopener noreferrer">
          explorer ↗
        </a>
      </div>

      {show && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <h2 style={{ marginBottom: 8 }}>Adding funds</h2>

          {!onGnosis && (
            <div className="warn err">
              This node reports chain ID {w.chainId}, not Gnosis ({GNOSIS_CHAIN_ID}). The instructions
              below assume Gnosis — check before sending anything.
            </div>
          )}

          <p className="secondary" style={{ fontSize: 13 }}>
            Send to the address above <strong>on Gnosis Chain</strong>. Two different things are
            needed and they are not interchangeable:
          </p>
          <ul className="secondary" style={{ fontSize: 13, paddingLeft: 18, marginTop: 6 }}>
            <li><strong>xBZZ</strong> — buys and extends postage batches. This is what runs out.</li>
            <li><strong>xDAI</strong> — pays gas. A purchase fails without it however much xBZZ is held.</li>
          </ul>

          {/* A wrong token address sends funds somewhere unrecoverable, and the
              Bee API does not expose the one it uses, so there is nothing to
              check a hardcoded constant against. The explorer shows the real
              token held by this exact address. */}
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Confirm the xBZZ token from the explorer link above rather than from a contract address
            typed anywhere — including here. The token this node actually holds is the one listed
            against its address.
          </p>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Bridging from Ethereum mainnet BZZ produces xBZZ on Gnosis; sending mainnet BZZ to this
            address on the wrong network does not arrive.
          </p>

          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <span className="tile-label">Chequebook</span>
            <button className="reflink" title={w.chequebookAddress}
              onClick={() => copy('cheque', w.chequebookAddress)}>
              {copied === 'cheque' ? 'copied' : w.chequebookAddress}
            </button>
            <a className="backlink" href={explorer(w.chequebookAddress)} target="_blank" rel="noopener noreferrer">
              explorer ↗
            </a>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            A separate contract the node uses to settle bandwidth. Funding it does not help postage —
            send to the wallet address for that.
          </p>
        </div>
      )}
    </div>
  );
}

function PriceNote({ fiat }: { fiat: NonNullable<State['fiat']> }) {
  const mins = Math.round((Date.now() - fiat.fetchedAt) / 60_000);
  const chg = fiat.usd24hChange;
  return (
    <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
      BZZ ${fiat.usd.toFixed(4)} · €{fiat.eur.toFixed(4)}
      {chg !== 0 && (
        <span style={{ color: chg > 0 ? 'var(--good)' : 'var(--critical)' }}>
          {' '}{chg > 0 ? '▲' : '▼'}{Math.abs(chg).toFixed(1)}% 24h
        </span>
      )}
      {' '}· CoinGecko, {mins < 1 ? 'just now' : `${mins}m ago`} · display only; amounts above are xBZZ, bridged 1:1
    </p>
  );
}
