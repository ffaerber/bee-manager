# `/settings` — configuration

Everything the service can be tuned with, in one place. Changes apply on the
next poll; nothing needs a restart.

## The database is the source of truth

The environment **seeds** these values on first boot and is ignored from then
on. Editing the compose afterwards has no effect — that is the point. There is
one place a value lives and one number to read.

An earlier version layered dashboard overrides on top of the environment and
treated the env value as a hard ceiling for spend caps. Safer on paper; in
practice every setting showed three numbers — environment, override, in force —
and reading it meant working out which was real.

## Loosening a guard asks first

The ceiling is replaced by a confirmation. Raising a spend cap or lowering a
balance floor asks once and says what the guard is for:

> **Max per action**: 5 → 50
> Raising this is the last stop between a mis-typed duration and the wallet.

Tightening applies immediately. Friction in the cautious direction only teaches
people to click through warnings.

| Setting | Loosening is | Why it is guarded |
|---|---|---|
| Max per action | raising | the last stop between a mis-typed duration and the wallet |
| Max per 24 hours | raising | bounds a runaway loop rather than one action |
| Never auto-dilute past depth | raising | dilution cannot be undone and doubles every future top-up |
| Keep at least … xBZZ | lowering | the reserve that stops automation spending the wallet to nothing |
| Keep at least … xDAI | lowering | below it a transaction cannot land |

Coherence is enforced whatever you type: a top-up target at or below its
trigger would re-fire every cycle, and a per-action cap above the daily cap
could never be respected. Both are corrected rather than stored.

## Groups

| Group | What it covers |
|---|---|
| Automation | what the service does unasked — auto top-up, dry run, auto dilute |
| When to act | the TTL and utilisation thresholds that trigger it |
| Limits | what bounds a mistake |
| Alerts | runway warning, and the webhook everything is announced to |

## Fixed at startup

`BEE_URL`, `DB_PATH`, `POLL_INTERVAL_MS`, `MAX_UPLOAD_BYTES` and `ADMIN_TOKEN`
stay in the environment. Not a policy choice: the node URL and database path are
read before this table can be opened, and the admin token authenticates the page
that would edit them. They are listed read-only so their absence is not a
mystery.

## Audit

Every change is written to the actions ledger as a `config` entry, marked
`(loosened, confirmed)` when it weakened a guard. Settings decide what the
service may spend, so they belong in the same trail as the spends.
