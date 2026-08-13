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
│ Label │ Depth │ Remaining life │ Used of capacity │ Stored │ Managed │ Flags │      │
│ t4t   │  24   │ ▓▓▓▓░ 60 d     │ ▓░░░ 2.00%       │ ≤268MB │ managed │mutable│ open→│
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

| Column | Notes |
|---|---|
| Label | editable inline; renames the batch **on the Bee node**, so it survives this database |
| Depth | fixed at creation, only ever increases |
| Remaining life | meter + days, coloured against the batch's own top-up threshold |
| Used of capacity | `utilizationRatio` — the fullest bucket, not the average |
| Stored | prefixed `≤`: an upper bound quantised off the fullest bucket. It read 268 MB for a batch holding 0.47 MB. The exact figure is on the batch page |
| Managed | toggle. Unmanaged means never topped up and no alert on expiry |
| Flags | mutable / immutable, and unusable if so |
| `open →` | link to `/batch/<id>` |

Below the table: the planner's verdict per batch. The all-clear collapses to one
line; only batches needing something get their own.

## Create batch (modal)

Depth and duration sliders, live cost tiles, a recommended depth, and a cost-by-depth
bar chart. **Buy is arm-then-confirm** — the confirmation names depth, duration,
cost and label, and any slider move disarms it, because depth and immutability
cannot be changed after purchase.

## Recent actions

The ledger: every buy, top-up and dilution with its outcome, including
`blocked by caps` and `submitted` (an indeterminate write whose transaction may
still land).
