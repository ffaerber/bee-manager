# `/` — overview

The list view. Answers "is anything about to break, and what is this costing".
Deliberately shows **no bucket map**: that belongs to a single batch, and having
it here made the page about one metric instead of the fleet.

```
Swarm stamp monitor          [node reachable] [auto top-up on] [Poll now] [Sign out]

┌─ banner ──────────────────────────────────────────────────────────────┐
│ only when auto top-up is OFF — the exceptional state, not the normal   │
└───────────────────────────────────────────────────────────────────────┘

┌─ Overview ────────────────────────────────────────────────────────────┐
│ Runway at the current burn rate                                       │
│ 61 days                                            ● comfortable      │
│                                                                       │
│ Wallet          Gas         Burn rate per 30 days   Batches           │
│ 135.64 xBZZ     4.71 xDAI   66.43 xBZZ              5                 │
│ ≈ $5.68                     ≈ $2.76                 block time 5.00s  │
│                                                                       │
│ BZZ $0.0416 · €0.0360 ▼2.2% 24h · CoinGecko · display only            │
└───────────────────────────────────────────────────────────────────────┘

┌─ Batches ─────────────────────────────────────────── [Create batch] ──┐
│ Batch                    │ Remaining life  │ Capacity used            │
│ t4t                      │ ▓▓▓▓░░ 60 d     │ ▓░░░░░ 2.0%              │
│ depth 24 · 68.7 GB ·     │                 │                          │
│ unmanaged                │                 │                          │
│ …                                                                     │
│                                                                       │
│ No action needed for 2 managed batches — all above the threshold.     │
└───────────────────────────────────────────────────────────────────────┘

┌─ Recent actions ──────────────────────────────────────────────────────┐
│ When │ Kind │ Status │ Cost │ Reason                                  │
└───────────────────────────────────────────────────────────────────────┘
```

## Header

| Element | Notes |
|---|---|
| `node reachable` / `node unreachable` | last poll's result |
| `auto top-up on` | **only when armed.** A permanent red "ARMED" banner trained you to ignore banners; the exceptional state gets the banner instead |
| `Poll now` | forces a poll cycle |
| `Sign out` | forgets the admin token held in this browser |

## Banner

Rendered **only when auto top-up is off** (`AUTO_TOPUP_ENABLED=false` or
`DRY_RUN=true`). That is the state in which a batch expires unnoticed — the
thing this service exists to prevent — so it is the one worth interrupting for.

## Overview card

**Hero: runway in days.** Exactly one hero per view. Runway is the hero because
it is the number that actually explains why stamps lapse — not the balance, not
the utilisation.

| Tile | Unit | Fiat |
|---|---|---|
| Wallet | xBZZ | yes |
| Gas | xDAI | — |
| Burn rate per 30 days | xBZZ | yes |
| Batches | count | — |

Fiat is display-only and never enters a spending decision (`src/price.ts`). The
period is stated once, in the label — never repeated in the unit and the fiat
line.

## Batches table

Three columns. This is a list for spotting the batch that needs attention, not
for reading its detail — everything you can only act on once you are there lives
on the batch page.

| Column | Notes |
|---|---|
| Batch | name, linking to `/batch/<id>`. Underneath: depth, capacity, and only the flags that change how it behaves — `unmanaged`, `immutable`, `unusable` |
| Remaining life | meter + days, coloured against the batch's own top-up threshold |
| Capacity used | `utilizationRatio` — the **fullest bucket**, not the average, because that is what stops a write |

Moved to the batch page: renaming, the managed toggle, exact stored bytes, and
the mutable/usable flags when they are the unremarkable case. The `Stored`
column is gone entirely — it was an upper bound that read 268 MB for a batch
holding 0.47 MB, and the exact figure was always one click away.

Below the table: the planner's verdict per batch. The all-clear collapses to one
line; only batches needing something get their own.

## Create batch (modal)

Depth and duration sliders, live cost tiles, a recommended depth, and a cost-by-depth
bar chart.

### Mutable or immutable

Asked explicitly, defaulting to **immutable**. Still asked rather than assumed:
this wizard once inherited Bee's default without showing it, which is how two
batches were bought immutable by accident. The choice is fixed at creation.

The default was mutable for a while, on the belief that immutable batches could
not be topped up. They can, and they can be diluted too. With that gone, the
difference is only which way the batch fails when a bucket fills — and immutable
fails loudly where mutable fails silently.

| | When a bucket fills | Use for |
|---|---|---|
| **Mutable** | recycles the oldest chunk in that bucket | a site you redeploy, anything rewritten often — superseded chunks make way. Cost: old data can be silently dropped, so a reference to a previous version may stop resolving |
| **Immutable** | the *whole batch* refuses further uploads | write-once data — images, documents, an archive that must keep resolving. Nothing is ever evicted. Cost: one full bucket stops all writes until the batch is diluted |

Note immutable does **not** prevent topping up, and does not prevent dilution
either — see [batch-detail.md](batch-detail.md).

**Buy is arm-then-confirm** — the confirmation names mutability, depth, duration,
cost and label, and changing any of them disarms it, because depth and
immutability cannot be changed after purchase.

## Recent actions

The ledger: every buy, top-up and dilution with its outcome, including
`blocked by caps` and `submitted` (an indeterminate write whose transaction may
still land).
