# `/batch/<id>` — one batch

Everything about a single batch. The **bucket map is the page**, not something
inside it: it fills the viewport and the readings sit on top. `Hide panel`
(Escape to return) leaves the map alone on screen.

A real URL, so it can be bookmarked, shared, or pinned on a wall display.

```
 ← Batches   t4t-v3                                        [Hide panel]

┌─ vitals ──────────────────────────────────────────────────────────────┐
│ Remaining life                    Capacity used                       │
│ ▓▓▓▓▓▓▓░░░░░  56 d                ▓░░░░░░░░░░░  25.0%                 │
│ until 8 Oct 2026                  fullest bucket 1 of 4 · 471 KB      │
│                                                                       │
│ [Extend life]  [Add capacity]      ← disabled when unmanaged          │
└───────────────────────────────────────────────────────────────────────┘

     ░░▒░░░░▒░░░░░░░░▒░░░░  ← 65,536 buckets, one cell each, full viewport
     ░░░░░▒░░░░░░▒░░░░░░░░    hover any cell for its stamp count
┌─ batch facts ─────────────────────────────────────────────────────────┐
│ Label      Remaining life   Depth      Managed    Flags     Reported  │
│ [t4t-v3]   ▓▓▓▓ 56 d        18         [managed]  mutable   0.00%     │
│            until 8 Oct      1.07 GB    auto       a full    quantised │
│                             nominal    applies    bucket…             │
│ Batch ID  49aebf39…  (click to copy)                                  │
└───────────────────────────────────────────────────────────────────────┘
┌─ Policy for this batch ──────────────────── (managed batches only) ───┐
│ Top up below   Top up to   Dilute above   Never dilute past depth     │
│ [   ] def 2    [ 180 ]     [   ] def 0.9  [ 18 ]                      │
└───────────────────────────────────────────────────────────────────────┘
┌─ buckets ─────────────────────────────────────────────────────────────┐
│ Stored      Capacity   Buckets used   Fullest bucket                  │
│ 471 KB      1.07 GB    115 of 65,536  1 / 4                           │
│ 115 chunks                                                            │
│                                                                       │
│ ▪empty ▪lightly ▪half ▪mostly ▪nearly full 80%+ ▪at capacity          │
│ The fullest bucket is at 25% — plenty of headroom.                    │
└───────────────────────────────────────────────────────────────────────┘
┌─ Files ───────────────────────────────────────────────────────────────┐
│ [Upload a file]   up to 32 MB, 1.07 GB of batch space unused          │
│ Uploaded data is public and the stamps cannot be reclaimed.           │
│                                                                       │
│ File │ Size │ When │ Reference │ view · download                      │
└───────────────────────────────────────────────────────────────────────┘
```

## Vitals — the two numbers that matter

Life and room decide whether a batch is healthy: it dies when either runs out,
and everything else on the page is detail underneath. They sit above the fold,
each with a meter, and each with the action that moves it.

The capacity meter tracks the **fullest bucket**, not the average, because that
is what actually stops a write. Bytes stored appear underneath as context.

`Extend life` and `Add capacity` expand in place, so the meter stays on screen
while you decide. **Both work on an unmanaged batch.**

`managed` governs *automation* — whether the poller acts on its own — not
whether you may act. An earlier version blocked manual top-up and dilution on
unmanaged batches, which conflated the two and removed the case that most needs
them: keeping a superseded batch alive by hand while migrating off it. The
preview instead says the batch is unmanaged and will lapse once the time being
bought runs out, so it is a visible decision rather than a blocked one.

What actually bounds overspending is the caps, not this flag.

`Add capacity` works on immutable batches too — see Dilute below.

## The map

Each cell is one of the **65,536 buckets**. A chunk's address decides which
bucket its stamp must occupy — you do not choose — so buckets fill unevenly and
the batch starts refusing writes when the *first* bucket fills, not when the
average does.

Reflowed to the viewport's aspect rather than stretched or cropped: bucket order
is arbitrary, so reflowing loses no meaning, while stretching would make cells
non-square and cropping would hide buckets.

| Colour | Meaning |
|---|---|
| grey | empty |
| light → dark blue | fill level (sequential ramp, one hue) |
| **amber** | nearly full, 80%+ — same threshold as the written warning |
| **red** | at capacity: rejects writes (immutable) or recycles oldest (mutable) |

Green is deliberately absent — it sits ΔE 4.1 from critical red under
deuteranopia, which would merge "barely used" with "refusing writes".

## Batch facts

Label and the managed toggle are editable here — this is the page you are on
when you decide a batch needs renaming or retiring. Adds what only fits on a
page: the projected expiry date and the full copyable batch ID.

`Reported utilisation` is the coarse quantised figure. Shown anyway because it
is what the **dilute rule keys off** — hiding it would hide the input to a
decision the daemon makes on its own.

## Policy for this batch

Managed batches only; none of it applies otherwise. Empty means **inherit the
global**, shown as the placeholder — not a frozen copy, so changing the service
default still reaches this batch.

| Field | Effect |
|---|---|
| Top up when life falls below | days remaining that triggers a top-up |
| Top up to | the target — effectively the size of each top-up |
| Dilute when fullest bucket exceeds | 0–1; clamped to "one slot left" on shallow batches |
| Never auto-dilute past depth | ceiling. Set to the batch's own depth to pin it |

## Top up — more time, same size

Buys remaining life at the current depth. Capacity unchanged. Cost scales with
`2^depth`, so a deeper batch costs proportionally more per day.

Preview → Confirm. Subject to the **same caps as the automatic path**: being
deliberate does not make a spend safe to leave unbounded, so a block is reported
before the confirm, naming the cap.

## Dilute — more room, less time

Raises depth. **Doubles capacity and halves remaining life per step**, because
the amount already paid now covers twice as many chunk slots. It adds nothing;
it converts time into space.

Preview → Confirm, 1–3 steps. Irreversible — depth never decreases. The preview
leads with the TTL loss and what restoring it would cost.

**Immutable batches can be diluted**, contrary to what this page said earlier.
Verified in the Bee source (`DiluteBatch` checks only that depth increases) and
in the contract (`PostageStamp.increaseDepth` never reads `immutableFlag`). It
is in fact the *only* rescue for an immutable batch that has filled a bucket:
at that point the batch refuses every upload, and doubling bucket capacity is
what makes it usable again.

The real restriction is balance, not mutability. `increaseDepth` divides the
remaining per-chunk balance by 2^steps and reverts with `InsufficientBalance`
if the result falls below the contract minimum — so a nearly-expired batch must
be topped up *before* it can be diluted. The preview flags this rather than
letting the transaction revert.

## Files

Last on the page, and one card rather than two sections buried in the bucket
panel: putting a file somewhere and seeing what is already there are the same
task, and neither is why you open this page.

### Upload

Stamps a file with this batch and re-reads the buckets, so new cells appear at
once. The chunk delta is **measured, not derived** — Swarm adds Merkle-tree and
manifest chunks, so `bytes/4096` understates the real cost (100 chunks for a
326 KB image where the naive figure is 80).

Two irreversible consequences are stated at the button: the data becomes
**publicly fetchable** by anyone with the reference, and the stamps consumed
**cannot be reclaimed**.

Limit 32 MB — a memory bound, not policy: the body is buffered whole in a 512 MB
container. Checked in the browser before transferring.

### The list

| Column | Notes |
|---|---|
| File / Size / When | as recorded at upload |
| Reference | click to copy |
| view / download | fetched through the authenticated content proxy |
| Copy link | a **public** gateway URL — anyone who has it can fetch the file, no key needed |

A freshly uploaded file offers the same link immediately, which is when you
actually want to send it.

### The link

`https://download.gateway.ethswarm.org/bzz/<reference>/`, with the gateway base
configurable at `/settings` so a private or self-hosted one can be used instead.

Two details are load-bearing and neither is obvious:

- **The host.** `gateway.ethswarm.org/bzz/<ref>` serves the gateway's own web
  app and answers **200 with an HTML page** — a link built from it looks
  correct, returns 200, and downloads nothing. `download.gateway.ethswarm.org`
  serves the bytes.
- **The trailing slash.** Without it the gateway answers 308 to add one, and
  not every client follows that.

Verified against a real upload: 326,163 bytes, `image/png`, byte-identical to
the file sent.

Swarm **cannot list a batch's contents**. This is a local index of what this
dashboard uploaded — a reference not recorded here is unreachable, even though
the data is still stored and still being paid for. Anything uploaded by other
means will not appear.
