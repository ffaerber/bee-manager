# `/settings` — runtime configuration

Environment variables, editable from the dashboard, applied on the next poll
with no restart. Reached from **Settings** in the header.

## The rule that makes this safe

The dashboard may **lower** a spend cap freely, and **raise** one only as far as
the environment allows. The env value is a *ceiling*, not merely a default.

Without that the caps would be advisory: anything holding the admin token could
raise the per-action cap and then spend to it, and the guardrail that bounds an
automated refiller pointed at a live wallet would last exactly as long as nobody
clicked otherwise. Keeping the ceiling in the environment means widening it is a
reviewed commit in the homelab repo, not a click.

The protective floors invert the same rule — raisable, never lowerable — because
higher is the cautious direction.

| Setting | Bound | Why |
|---|---|---|
| Max per action | may only be lowered | the last stop between a mis-typed duration and the wallet |
| Max per 24h | may only be lowered | bounds a runaway loop, not a single action |
| Wallet floor | may only be raised | reserve that must survive |
| Gas floor | may only be raised | below it a transaction cannot land |
| Never auto-dilute past depth | may only be lowered | dilution is irreversible and doubles all future cost |
| Thresholds, dilute %, webhook | free | worst case is a badly tuned monitor, not a drained wallet |

A clamped value is **reported**, not silently applied: the page says "your 500
became 5" rather than storing a number that will not be honoured.

## Audit

Every change is written to the actions ledger as a `config` entry with the
before/after. Settings that alter what the service may spend belong in the same
trail as the spends themselves.

## Fixed at startup

`BEE_URL`, `POLL_INTERVAL_MS`, `DB_PATH`, `MAX_UPLOAD_BYTES` and the admin token
are structural and need a redeploy. They are listed read-only on the page so
their absence from the editable table is not a mystery.
