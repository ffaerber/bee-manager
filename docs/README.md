# Dashboard structure

Two pages. Everything else is a modal on one of them.

| Page | File | What it answers |
|---|---|---|
| `/` | [index.md](index.md) | Is anything about to break, and what is this costing? |
| `/batch/<id>` | [batch-detail.md](batch-detail.md) | What is *in* this batch, and what should happen to it? |

```
/                                   overview
├─ Overview      runway, wallet, burn rate, price
├─ Batches       table → "Create batch" modal (the wizard)
│  └─ open →     /batch/<id>
└─ Recent actions

/batch/<id>                         one batch — the bucket map IS the page
├─ batch facts   label, life, depth, managed, flags, id
├─ policy        per-batch top-up and dilution settings (managed only)
└─ buckets       stats, legend, pressure
   ├─ Top up     more time, same size
   ├─ Dilute     more room, less time
   ├─ Upload
   └─ Uploaded with this batch
```

## Why the split

The overview renders **no map**. A map belongs to one batch, and having it on
the list made the page about a single metric rather than the fleet.

The batch page renders **no fleet numbers**. Runway and wallet are properties of
everything together, not of the batch you happen to be looking at.

Reaching a batch's data used to take a map click, a scroll, and a second toggle.
It is now one click on the row, at a URL you can bookmark.

## Conventions used throughout

- **xBZZ** for every on-chain amount — the node is on Gnosis, so its balance and
  costs are the bridged token, exactly as gas is xDAI. Plain **BZZ** appears
  only in the market quote. See the README's *xBZZ vs BZZ*.
- **Spending is always two-click.** Buy, top up and dilute all arm, then commit,
  and changing any input disarms them. Depth and immutability cannot be changed
  after purchase; dilution cannot be undone; top-ups cannot be withdrawn.
- **Fiat is decorative.** Never used in a calculation that spends.
- **Colour never carries meaning alone.** Every swatch is labelled, every status
  has text.
