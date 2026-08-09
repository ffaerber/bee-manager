# swarm-stamp-monitor

Keeps Swarm postage batches alive, and makes what they cost impossible to miss.

The Swarm dashboard can buy and top up batches but cannot do it automatically, so
a batch lapses silently — and when it does, the chunks it stamped are dropped from
storer reserves and the data is gone. This watches the batches, tops them up
within hard spend caps, and gives dapps an API to upload through so the Bee node
itself never has to face the internet.

## The thing worth understanding

A batch is charged for **reserved capacity, not stored data**. At depth `d` you
rent `2^d` chunks every block whether you use them or not, so an empty batch
expires exactly as fast as a full one. Depth does not change how long a batch
lives — it multiplies what that lifetime costs:

| depth | capacity | cost / 30 days* |
|---|---|---|
| 17 | 537 MB | 0.48 BZZ |
| 20 | 4.3 GB | 3.84 BZZ |
| 24 | 68.7 GB | 61.44 BZZ |

<sub>* at a chain price of 70,638 PLUR/chunk/block. Identical lifetime in every row.</sub>

Over-provisioning is therefore the usual reason stamps keep lapsing: the batch is
so expensive that the wallet only ever buys a couple of months. Depth can be
*increased* (dilute) but never reduced, so right-sizing means a new batch and a
re-upload. The wizard exists to make that trade visible before you commit to it.

## Sizing

Duration is `price x blocks`, priced from the chain. It cannot be derived from a
batch's own `amount / batchTTL` — `amount` is the **cumulative** per-chunk value
ever deposited, not the remaining balance, so that ratio overstates the burn rate
(by 1.687x on the batch this was built against). Block time is *measured* from
successive `chainstate.block` values rather than assumed.

All money is `bigint` end to end. A wallet balance like `2044839309272645597`
is not representable as a JS `Number` — it comes back as `…645632`.

## Safety

Nothing spends until **both** `AUTO_TOPUP_ENABLED=true` and `DRY_RUN=false`.
On top of that, every action is checked before submission against:

- a per-action BZZ cap,
- a rolling 24h BZZ cap,
- a minimum wallet balance floor,
- a minimum xDAI balance, so the transaction can actually land.

A blocked action raises an alert rather than passing silently — "I would have
topped up but the cap stopped me" is the message that must not be lost. Actions
are written to the ledger as `submitted` *before* the Bee call, so a crash
mid-transaction leaves evidence instead of a duplicate on the next poll.

## The upload API

Dapps POST to this service instead of to Bee, which is what lets the node come
off the public internet — `/wallet`, `/chequebook` and `/stake` stop being
reachable.

```
POST /api/apps/:app/upload    -> { reference }
GET  /api/apps/:app/stamp     -> { batchId, ttlDays, utilizationRatio, usable }
```

Auth is a per-app API key (pipelines, which can hold a secret) or an EIP-191
wallet signature over the content hash and a timestamp (browsers, which cannot).
**Signatures do not stop Sybil abuse** — addresses are free to mint. Quotas bound
the loss instead: per-request size, per-address bytes and count, and a per-app
daily byte budget that is the actual blast radius.

## Running

```sh
cp .env.example .env      # BEE_URL, caps, webhook
docker compose up -d      # joins the Bee node's network; dashboard on :3010
```

Put the dashboard behind basicauth — it has a Buy button, which makes it a
spending endpoint. Set `ADMIN_TOKEN` as well for defence in depth.

```sh
bun install && bun test   # 120 tests
bun src/dryrun.ts         # one read-only poll: state and intended actions
```

## Layout

| Path | |
|---|---|
| `src/math.ts` | BigInt PLUR/BZZ, durations, capacity, runway |
| `src/wizard.ts` | Sizing: quotes, depth ladder, recommendations, warnings |
| `src/evaluate.ts` | Top-up / dilute decisions and the spend caps. Pure — never calls Bee |
| `src/poller.ts` | The loop: measure, record, decide, act |
| `src/quota.ts` `src/auth.ts` | Public upload limits and authentication |
| `src/server.ts` | Admin API, public API, dashboard |
| `web/` | Dashboard |
