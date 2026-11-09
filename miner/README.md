# wam-miner

The reference CPU miner for WAM Coin. RandomX proof of work over a Bitcoin-style
80-byte header, spoken over ordinary stratum.

**No developer fee.** This binary mines to the address you give it and to no
other. There is no hidden second connection, no donation round, no "1% default".
Grep the source for a second address if you like — there isn't one.

---

## Why a new miner exists

WAM's proof of work is RandomX, but its block header is Bitcoin's. That
combination is deliberate:

* **RandomX** because it is the best CPU-favouring proof of work in production.
  It makes an ordinary laptop a real participant and makes ASICs uneconomic, so
  the coin is distributed by people rather than by whoever can afford a
  fabrication run.
* **Bitcoin's header and consensus code** because WAM is a fork of Bitcoin Core
  v28.1. Twenty years of reviewed code is not something a new chain should
  rewrite for the sake of novelty.

The cost of that combination is that no existing miner speaks it. `xmrig` hashes
Monero's blob layout, where the nonce sits at byte 39; WAM's nonce is at byte 76
of a Bitcoin header. `cpuminer` and every ASIC-era tool hash SHA-256. So WAM
ships its own.

It is deliberately small — about 2,000 lines, no dependencies beyond
`librandomx` and a C++17 compiler — because a miner asks strangers to run
unknown code on their own hardware, and the only honest answer to "why should I
trust this" is "here is all of it, it fits in an afternoon".

## Build

```bash
bash miner/build.sh
```

You need `g++`, and `librandomx.a` from RandomX 1.1.0 or newer. If you have
already built the WAM node, RandomX is at `build/randomx` and the script finds
it. Otherwise point it at yours:

```bash
RANDOMX_INCLUDE=/path/to/randomx/src RANDOMX_LIB=/path/to/librandomx.a bash miner/build.sh
```

The build ends by running the self-test, and refuses to hand you a binary that
fails it.

## Check it before you trust it

```bash
wam-miner --self-test
```

This verifies SHA-256 against the NIST vectors, verifies that hashing a real
Bitcoin block header reproduces that block's published hash, verifies the
stratum byte-order conversion, verifies target arithmetic at difficulty 1 and 2,
and verifies RandomX against the two official test vectors from the reference
implementation. If any line says FAIL, do not mine with that build.

```bash
wam-miner --benchmark 60
```

Measures your hashrate without connecting to anything.

## Mine

```bash
wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u <your WAM address>
```

Add a worker label if you run more than one machine:

```bash
wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u <your WAM address>.livingroom
```

Community pool: **VEIN Pool** (EU, Germany, PPLNS) — https://veinpool.fr/coin/wam

```
wam-miner -o stratum+tcp://veinpool.fr:3310 -u <your WAM address>.livingroom
```

(use port `3311` for servers: higher starting difficulty)

| Option | Meaning |
| --- | --- |
| `-o, --url` | pool host and port; `stratum+tcp://` is optional |
| `-u, --user` | the WAM address you want to be paid at, optionally `.worker` |
| `-p, --pass` | pool password; most pools ignore it |
| `-t, --threads` | mining threads (default: every core but one) |
| `--light` | 256 MiB instead of the 2 GiB dataset — about four times slower |
| `--large-pages` | ask for huge pages; worth roughly 5% where configured |
| `--benchmark [s]` | measure hashrate, no pool |
| `--self-test` | verify the build against known vectors |
| `--no-colour` | plain output for logs |

## Mine alone, with no pool at all

New in v0.1.10, on Linux, Windows and macOS.

```bash
wam-miner --solo -u <your WAM address> -t 4
```

That needs your own node running with `server=1` in `wam.conf`, and nothing
else — no pool, no account, no operator, no Redis. Work comes from
`getblocktemplate` instead of `mining.notify`, and a solution becomes a block
instead of a share. When you find one you keep the whole 47.5 WAM rather than
a portion, and you wait longer between them.

**Ask first whether it would even work:**

```bash
wam-miner --check -u <your WAM address>
```

That builds a real block from your node's current template and asks the node
whether it is valid. It hashes nothing, sends nothing, and answers in about a
second. If the node accepts it, everything except the proof of work is
correct: the coinbase, the BIP34 height, the treasury output, the witness
commitment, the merkle root and the transactions. Two bugs were caught by
this before a single hash was computed.

| Option | Meaning |
| --- | --- |
| `--solo` | mine against your own node |
| `--check` | build one block, ask the node, exit |
| `--network <net>` | `mainnet` (default), `testnet` or `regtest` |
| `--rpc <host:port>` | the node's RPC address. Left out, the port follows `--network`: 9554, 19554, 29554 |
| `--rpcuser`, `--rpcpassword` | credentials from `wam.conf`. Omit both and the node's `.cookie` is read |
| `--rpccookie <path>` | where that cookie is, if not the default |
| `--blocks <n>` | exit after n accepted blocks. For testing; a miner does not want it |

If the node is on another machine, say so — and remember its RPC has to be
reachable from this one:

```bash
wam-miner --solo -u <address> -t 4 --rpc 192.168.1.10:9554 \
          --rpcuser USER --rpcpassword PASSWORD
```

**Every block found this way is a separate finder in the chain's own
records**, where everyone in one pool counts as one however many people are
behind it. That is not an argument in this project's favour and it is
written here anyway.

### Memory

Full-memory mode allocates a 2 GiB RandomX dataset **once**, shared by every
thread — not 2 GiB per thread. On a machine with less than about 3 GiB free, use
`--light`.

### Your address must match the network

A mainnet WAM address starts with `W` or `wam1`. If you give a pool an address
from the wrong network it will refuse to authorize you. That refusal is the
system working: being paid into an address nobody holds the key to is the one
mistake that cannot be undone.

## What the miner does with a job

Worth understanding if you are auditing it, and it is all in `src/main.cpp`:

1. The pool sends `mining.notify` with the two halves of the coinbase, a merkle
   branch, and — a WAM extension in the tenth parameter — the RandomX key for
   that height.
2. The miner splices its own `extranonce2` between the coinbase halves, hashes
   the result, and folds it through the merkle branch to get the merkle root.
   Each thread uses a different `extranonce2`, so no two threads search the same
   space.
3. It assembles the 80-byte header and hashes it with RandomX, varying the nonce
   at bytes 76–79.
4. A digest below the share target is submitted; a digest below the *block*
   target is a solved block and is submitted immediately.

The RandomX key rotates every 2048 blocks, with a 64-block lag so that everyone
changes over at the same height. When it does, the miner rebuilds its dataset —
a few seconds — and says so. That pause is normal and happens across the whole
network at once.

## What this miner will not do

* **No GPU support.** RandomX is designed to run poorly on GPUs. Adding
  half-speed CUDA would only invite people to spend electricity for nothing.
* **No developer fee, no telemetry, no auto-update.** It connects to the pool
  you name and nowhere else.
* **No pretence about the treasury.** Blocks 1 to 400,000 pay 5% of the subsidy
  to WAM's treasury address. That is a consensus rule enforced by every node,
  visible in the coinbase of every block, and it ends at block 400,000. It is
  not something this miner adds or could remove — a block without it is rejected
  by the network.

## Licence

MIT, the same as the rest of WAM Coin. See `COPYING`.
