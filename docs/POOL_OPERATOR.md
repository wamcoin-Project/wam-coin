# Running a WAM Coin mining pool

---

## Architecture

```
  miners ──stratum/TCP──▶ stratumServer ──▶ jobManager ──▶ daemon (wamd)
                               │                │              getblocktemplate
                               │                │              submitblock
                               │                └──▶ native/ (librandomx)
                               ▼                        share verification
                         shareProcessor ──▶ Redis
                               │                accounting, PPLNS window, balances
                               └──▶ apiServer ──▶ web dashboard
```

**jobManager** polls `getblocktemplate` every second, resolves the RandomX seed for the
height, and publishes a job. **stratumServer** fans it out. Every submitted share is
rebuilt from scratch — coinbase, merkle root, header — and hashed with RandomX on the libuv
threadpool. **shareProcessor** does the money.

---

## The two fees

These are constantly confused, so to be explicit:

| | Who sets it | How it is paid | Can the pool change it? |
|---|---|---|---|
| **5% treasury** | consensus rule WAM-1 | an output in the coinbase, created by the pool but *required* by the chain | **No.** A block without it is rejected. |
| **Pool fee** | you, in `config.json` | deducted from what the pool distributes | Yes, it is yours. |

The pool distributes `coinbasevalue − devfee.amount`. The treasury amount is read from the
`devfee` field that the patched daemon reports in `getblocktemplate` — the pool never
recomputes 5% itself, because that would mean duplicating the halving schedule in a second
language and being wrong about it at some future halving.

If `getblocktemplate` does not return `devfee`, the pool **refuses to build a template at
all**. An unpatched daemon would make it produce coinbases that consensus rejects with
`bad-cb-devfee-amount`, wasting every share submitted to it. Fix the daemon; never remove
this check.

`pool/test/rewards.test.js` includes a test that the reward calculator *throws* if handed
the raw coinbase value instead of the distributable value.

---

## Setup

```bash
cd pool
cp config.example.json config.json
$EDITOR config.json
npm ci                      # exact versions from package-lock.json
npm run build:native
npm test
node server.js
```

### The settings that matter

```jsonc
"poolAddress": "wam1...",  // or "W..." / "w...". Mainnet. Checked at startup.
"rewardMode": "pplns",     // or "prop"
"poolFeePercent": 1.0,     // YOUR fee. Separate from the chain's 5%.
"pplnsMultiplier": 2,      // window = 2 x network difficulty
"minimumPayoutWam": 1.0,
"paymentIntervalSec": 600
```

`poolAddress` takes any mainnet address: `wam1…` (bech32), `W…` (P2PKH) or `w…` (P2SH).
`wam-cli getnewaddress` gives you a `wam1…` one, and that is the usual answer — on this
pool 43 of the 45 addresses miners have ever used are bech32.

It is validated before anything else starts. A testnet address on a mainnet pool would
send every block reward into a void, so this check is deliberately fatal rather than a
warning.

---

## PPLNS vs PROP

**PROP** splits each block among the shares submitted since the previous block. Simple, and
easy to explain to miners — but it rewards pool hopping. A miner who mines only the early
part of each round earns above their fair share, and everyone else pays for it.

**PPLNS** splits each block among the last *N* units of difficulty submitted, ignoring round
boundaries. Leaving means forfeiting a share of every block found before your work ages out
of the window, so hopping stops being profitable. `N = pplnsMultiplier × network
difficulty`; 2 is the industry norm.

**The ordering rule that matters:** payouts are computed **at the moment the block is
found** and frozen into the pending-block record. They are *not* recomputed at maturity.
Recomputing 100 blocks later would use a share buffer that has completely turned over,
paying people who were not mining when the block was won. That is both unfair and, once
miners notice, fatal to a pool's reputation.

---

## Payment lifecycle

```
share ──▶ round hash + PPLNS list + hashrate ZSET
   │
block found ──▶ payouts computed and FROZEN ──▶ blocks:pending
   │
every 60s ──▶ getblock(hash)
   │              confirmations == -1  ──▶ blocks:orphaned, nobody is paid
   │              confirmations <  100 ──▶ stays pending
   │              confirmations >= 100 ──▶ balances credited, blocks:confirmed
   │
every 600s ──▶ balances >= minimumPayoutWam ──▶ sendmany ──▶ balances cleared
```

Balances are cleared **only after** `sendmany` returns a txid. Clearing them first would
lose every miner's money if the RPC failed.

A payment run is postponed entirely if the wallet cannot cover the full amount plus the fee
reserve. A partially failed batch is far harder to reconcile than a delayed one.

**A postponement is published, not only logged.** The pool writes
`<prefix>:payment:postponed` with the wallet balance, the amount due and the shortfall, and
clears it on any run that pays. `getPoolStats` carries it as `paymentPostponed`. Without
that, a postponement and a broken payout look identical from outside — owed climbs, the last
payment ages, nothing is sent — and `check_pool.py` reported the safe one as "payouts have
stopped", which is how an operator learns to ignore a red card.

**Credit at 101 confirmations, not 100.** `COINBASE_MATURITY` is 100 and Core's wallet asks
for `(COINBASE_MATURITY + 1) - depth`, so a coinbase is spendable at depth 101. Until
v0.1.10 the pool credited at 100 and then could not spend what it had just credited, so it
believed it held one block more than the node would let it move — 47.5 WAM standing
permanently between what was owed and what could be sent. Nothing was lost and nobody was
paid twice; it cost time, and payouts drifted from ten minutes to twenty or forty.

## Your fee, kept apart from miners' money

`poolFeePercent` is yours, and while it sits in the pool wallet nobody outside can tell it
from coin owed to miners. That matters because it makes the one question a miner actually
has — does this pool hold enough to pay me — unanswerable.

Set `poolFeeAddress` to an address **that receives nothing else and belongs to a wallet the
pool does not hold**, and sweep to it:

```bash
python3 scripts/sweep_pool_fee.py --node HOST            # plan only
python3 scripts/sweep_pool_fee.py --node HOST --send     # actually move it
```

It is the only tool in this repository that spends from the pool wallet, so it is built to
refuse: nothing moves without `--send`, it rejects a destination the node does not call
valid, rejects one the pool's own wallet owns, rejects a sweep that would leave the wallet
unable to cover what is owed — your fee is the last money out, never the first — rejects
dust below `--min`, and decrements the accrual only after a txid comes back.

Then whatever remains in the pool wallet is miners' money, and
`scripts/check_pool.py --node HOST` compares it against what the pool says it owes. The
page shows the address, so "1%" is something a miner can follow rather than a number he is
asked to believe.

---

## Difficulty

Vardiff targets one share every 15 seconds per connection, measured over a sliding window,
and only retargets when the observed rate leaves a ±30% band. Retargeting on every share
would chase Poisson noise forever.

RandomX hashrates span four orders of magnitude — a phone at 200 H/s and a 64-core server
at 30 kH/s can be on the same pool — so three ports with different starting difficulties
are provided. Miners that never submit are also rescued by an idle check every 30 seconds.

Share difficulty uses the **RandomX diff-1 convention** (`2^256 / 2^32`), not Bitcoin's.
Using Bitcoin's constant would inflate every hashrate figure by ~4.3 billion.

---

## The RandomX seed, for a pool that is not this one

Everything else in this document assumes you are deploying the pool in `pool/`,
which already implements this. If you are adding WAM to pool software of your
own, **this section is the part that will cost you a day**, and it is the only
part where WAM differs from a Monero-style RandomX chain in a way your code has
to know about.

The seed is the hash of a **past** block, not of the tip:

```
if height <= lag:  seed_height = 0
else:              seed_height = floor((height - lag) / epoch) * epoch

seed = the hash of the block at seed_height
```

That first line is not decoration. Without it the arithmetic goes negative for
the first `lag` blocks of a chain, and mainnet's first 64 blocks are exactly
where a launch-day pool starts.

| | epoch | lag |
|---|---|---|
| mainnet | 2048 blocks (~2.8 days) | 64 |
| testnet | 256 blocks (~8 hours) | 16 |
| regtest | 64 blocks | 4 |

**Epoch 0 is not a block hash.** Before the first rotation the key is the fixed
string `WAM/RandomX/epoch-0/2026`. A pool that starts from genesis and computes
a block hash for epoch 0 will reject every share on the chain's first 2048
blocks, and mainnet spends its first three days there.

The node will tell you what it expects, at any height, and this is the
authority — not this table:

```bash
wam-cli getrandomxinfo
```

```
height, seed_height, seed_hash, bootstrap, epoch_blocks, epoch_lag,
blocks_until_rotation, memory_bytes
```

`bootstrap: true` means epoch 0 — the string key. `blocks_until_rotation` is
what a pool schedules its next seed build against.

`pool/lib/randomxSeed.js` is the reference implementation, about eighty lines,
and `pool/test/` exercises it across rotations. Reading it is faster than
reading this section.

Announce the seed to miners over stratum as `mining.set_seedhash`, and when it
disagrees with `getrandomxinfo` you have found your bug rather than ours — see
Troubleshooting.

> **Test across a rotation before mainnet, not after.** Testnet rotates every
> 256 blocks, so a rotation arrives in about eight hours; mainnet takes 2.8
> days. A seed implementation that has never crossed a boundary is untested in
> the one respect that matters, and launch day is a bad time to find that out —
> every miner rebuilds at once and a pool that computes the new key wrongly
> rejects all of them.
>
> This section exists because a pool operator asked for it on 8 September and
> the page had nothing: it described how to *run* our pool through a rotation
> and never said how the seed is derived, because whoever it was written for
> already had our code.

---

## RandomX memory

| Mode | Memory | Use |
|---|---|---|
| light (`randomxFullMemory: false`) | ~256 MiB per live seed | **correct for a verifying pool** |
| full (`true`) | ~2.1 GiB per live seed | only if this process also mines |

Two seeds are kept alive at once. That is not a tuning knob: around an epoch boundary the
pool validates shares from the new epoch while stragglers from the old one are still
arriving, and holding exactly those two keeps memory bounded without thrashing.

Watch for the rotation warning in the log:

```
RandomX seed rotated: height 2048 -> 4096. Miners will rebuild their datasets;
expect a brief hashrate dip.
```

This is normal, happens every ~2.8 days, and lasts as long as your miners take to rebuild
2 GiB. The dashboard shows a countdown so it is never a surprise.

---

## Security

- **Never expose RPC port 9554.** `getblocktemplate` requires an unlocked node; anyone who
  reaches that port reaches the wallet.
- **Put the dashboard behind TLS** if it is public. It is read-only and accepts no bodies,
  but miner addresses are still visible.
- Keep the pool wallet separate from anything personal, holding only working balance.
- Set `exposeMinerIps: false` (the default). Miner IPs are not yours to publish.
- Back up `wallet.dat` and the Redis dump. Losing Redis means losing every unpaid balance;
  the chain has no record of who was owed what.
- The stratum port faces the open internet: sockets are capped in buffer size (16 KiB per
  line), message rate (240 per 10 s), and time-to-authorize (30 s). Connections producing
  persistent garbage are banned for 10 minutes.

---

## Monitoring

```bash
curl -s localhost:8080/api/health | jq
```

```json
{ "ok": true, "problems": [], "templateAgeSec": 3, "connections": 42, "uptimeSec": 84210 }
```

Alert on `ok: false`. The three conditions it reports are: no block template, a template
older than 120 seconds (the daemon is wedged or unreachable), and zero connected miners.

**Every** endpoint truncates payout addresses (`twam1qtekd…a7ljs.server`),
because an address on a public chain reveals everything it has ever received,
and a list of them is a list of who mines here and what each one earned. A
miner reads his own figures by giving his own address to
`/api/miner?address=…`: knowing an address finds its row.

**That is not the same as the addresses being secret, and this page said it
was.** It read "nothing enumerates the others" until 2026-11-13. The
enumeration is the chain. `/api/payments` returns the txid of every payment
this pool has made, those transactions name every recipient, and then
`/api/miner` will answer about each one. Truncation stops the API handing out
a ready-made list; it does not and cannot make a public ledger private, and a
sentence saying otherwise is the kind this project has been wrong with before.

What the pool can do, and now does, is stop that walk being free:
`apiLookupsPerMinute` caps `/api/miner` per caller — 30 a minute by default,
against `apiRequestsPerMinute` 240 for everything else, so a dashboard on a
timer is untouched. Behind a reverse proxy, set `apiTrustProxy` and have the
proxy send `X-Forwarded-For`, or every request arrives from the proxy and one
caller's budget is everybody's. If that header is missing the pool says so in
its log once and applies no limit, because a limit that cannot tell callers
apart would punish every miner for one.

`apiCorsOrigin` is empty by default, which means same origin only. It was `*`
until 2026-11-13: the dashboard this server also serves never needed it, and
the wildcard let any page a miner or an operator visits read this API through
their browser, from their address — including, on a pool bound to a LAN
address, a machine the page could not otherwise reach.

**That sentence was not true until 2026-09-13, and an outsider is the reason
it is.** `/api/miners` truncated. `/api/hashrate`, `/api/blocks` and
`/api/payments` did not: the first keys its workers map by
`<address>.<rig label>`, the second names the finding address of every block,
the third returns full addresses beside their txids. The API port is not open
from outside — and did not need to be, because `pool.wamcoin.org` fronts it,
so one unauthenticated GET returned the founder's own testnet address and the
name he had given his machine. It was found by static review of the published
repository, reported privately to the address in `SECURITY.md` with no reward
expected, and this page was already claiming the opposite while it was true.

The fix is where he said to put it: redaction now happens **where the response
leaves the process**, before the cache, rather than in each handler — so a
fifth endpoint cannot forget it. `pool/test/api-redaction.test.js` asks the
question of every shape a response can take, and `preflight.sh` runs it.

Other endpoints: `/api/stats`, `/api/blocks`, `/api/miners`, `/api/hashrate`,
`/api/payments`, `/api/miner?address=W...`, `/api/network`.

---

## Troubleshooting

**`getblocktemplate did not return a 'devfee' field`**
The daemon is not a patched `wamd`. Re-run `scripts/fetch-upstream.sh` and rebuild.

**`The WAM RandomX native addon is not built`**
`npm run build:native`, with `RANDOMX_INCLUDE` and `RANDOMX_LIB` pointing at
`build/randomx/src` and `build/randomx/build/librandomx.a`.

**Every share is rejected as low-difficulty**
Almost always a seed mismatch: the pool and the miner disagree about the RandomX key.
Compare `wam-cli getrandomxinfo` with the `mining.set_seedhash` value in the pool log.

**`payment run postponed: wallet holds ... but ... is due`**
Normal while blocks are maturing. Investigate only if it persists past 100 blocks after a
find.

**`config says network='mainnet' but wamd reports chain='test'`**
Exactly what it says. The pool refuses to start rather than mine to the wrong chain.
