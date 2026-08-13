# `/batch/<id>` — one batch

Everything about a single batch. The **bucket map is the page**, not something
inside it: it fills the viewport and the readings sit on top. `Hide panel`
(Escape to return) leaves the map alone on screen.

A real URL, so it can be bookmarked, shared, or pinned on a wall display.

```
 ← Batches   t4t-v3                                        [Hide panel]

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
│                                                                       │
│ ── Top up ──                                                          │
│ ── Dilute ──                                                          │
│ ── Upload a file ──                                                   │
│ ── Uploaded with this batch ──                                        │
└───────────────────────────────────────────────────────────────────────┘
```

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
leads with the TTL loss and what restoring it would cost. Refused on immutable
batches: Bee will not dilute one, and it would not help.

## Upload a file

Stamps a file with this batch and re-reads the buckets, so new cells appear at
once. The chunk delta is **measured, not derived** — Swarm adds Merkle-tree and
manifest chunks, so `bytes/4096` understates the real cost (100 chunks for a
326 KB image where the naive figure is 80).

Two irreversible consequences are stated at the button: the data becomes
**publicly fetchable** by anyone with the reference, and the stamps consumed
**cannot be reclaimed**.

Limit 32 MB — a memory bound, not policy: the body is buffered whole in a 512 MB
container. Checked in the browser before transferring.

## Uploaded with this batch

| Column | Notes |
|---|---|
| File / Size / When | as recorded at upload |
| Reference | click to copy |
| view / download | fetched through the authenticated content proxy |

Swarm **cannot list a batch's contents**. This is a local index of what this
dashboard uploaded — a reference not recorded here is unreachable, even though
the data is still stored and still being paid for. Anything uploaded by other
means will not appear.
