# Launch day — the order things happen in

**2026-09-15 00:00 UTC.**

**This is a record of that day, written before it and kept as it was. Present
tense in it means 15 September 2026 and not today** — where it says "both
servers" or "the two nodes", there were two at the time of writing; the third
seed arrived on 11 September. Nothing here is edited to agree with what came
afterwards, because a document rewritten to stay current stops being evidence
of what was decided and when.

`LAUNCH_CHECKLIST.md` is the list of things that must be *true*. This is the
list of things that must be *done*, in the order they must be done in, by
someone who has not slept and should not be deciding anything at midnight.

Read it now, not then. Print it if you can.

---

## The one sentence that matters

**Everything is recoverable until block 1 exists. Nothing is recoverable
afterwards.**

Genesis on its own commits you to nothing: it is data in a binary, and if
something is wrong you stop, fix it, and start again with nobody harmed.
The moment a block is mined on top of it and one other node has seen it, the
chain is real and its rules are fixed forever.

Everything below is arranged around that line. Phases A to C sit before it.
Phase D crosses it.

---

## Before the day — not on it

None of this is done at midnight.

| | |
|---|---|
| The third seed exists | three hostnames on **three providers**, not three names on two machines |
| Every machine already runs the release | `install_release.sh` has been run and the binaries are in place, unstarted on mainnet |
| Mainnet configs written | `wam.conf`, pool config, ElectrumX config — written, services **not** enabled |
| The pool's mainnet payout address is set | **done 2026-08-30** — `wam1qrulaxxlqf65madsmhqrevf467r6qmgdrxhf9yw`, wallet created through the gate's override and proved to survive the wipe. See Phase D |
| Backups verified | `wam-backup.sh --verify` on every host, within the day |
| The clock is right on every machine | `timedatectl` — genesis validation is absolute time, not relative |
| The paper matches the binary | the founder and treasury addresses in the release equal the ones on paper |
| **All three hosts measured against this table** | **done 12 Sep** — seven items on each, and the third seed failed two of them: it had no `wamd-mainnet.service` and no `/root/.wam-mainnet/wam.conf`. It joined on the 11th, its testnet side was set up, and its mainnet side never was. Phase C would have stopped there at 00:30 UTC. Both are in place now, disabled, and `genesis_gate.sh` was run by hand on that host to watch it refuse |
| **Windows is downloadable and signed** | **done 12 Sep** in v0.1.8 — node and miner, and the Windows archives are named in `SHA256SUMS` *before* it was signed. `docs/RELEASING.md` §3b is the step that is easy to skip; if it were skipped the `.zip` files on the release page would carry no signed proof at all, on the platform most people are on |
| **v0.1.8 builds the right genesis** | **done 12 Sep** on all three hosts, in a sandbox datadir: `d8d3debea987b62a…`, height 0, chain `main`, the second start refused as a block from the future, `genesis_gate.sh` declining with exit 78. The 7 September rehearsal was on v0.1.6, and the build that creates mainnet is the one that has to be asked |
| **No mainnet datadir holds a stale chain** | **done 12 Sep** — no `blocks/` or `chainstate/` on any of the three. Singapore held a `txindex` from 28 August for a chain that does not exist yet; it is now outside the datadir. An index older than its chain is not a thing to meet at 00:05 UTC |
| **Every published archive carries this network** | **done 12 Sep** — `check_release_matches.sh` had been examining the first asset alphabetically, which became the arm64 Mac build the moment macOS joined the release. It walks all three now: right genesis, right addresses, and zero AVX-512 in the Linux binaries |

The last one is worth the minute it takes. A binary built from a checkout
that was not what you think it was is the failure that no later step catches.

```bash
wamd -version
strings $(command -v wamd) | grep -E '^W[a-zA-Z0-9]{25,34}$' | sort -u
```

---

## Phase A — before 00:00 UTC

Nothing here touches mainnet. All of it can be done hours early.

1. **Confirm the release is published and matches.**

   ```bash
   bash scripts/check_release_matches.sh
   ```

2. **Confirm every machine is on it and on `origin/main`.**

   ```bash
   bash scripts/check_deployed_code.sh <host1> <host2> <host3>
   ```

3. **Run the sweep, and read the SKIPPED lines.**

   ```bash
   bash scripts/sweep.sh --nodes "<host1> <host2> <host3>"
   ```

4. **Stop nothing.** Testnet keeps running through all of this. It is the
   only working system you have while mainnet is unproven.

---

## Phase B — the first mainnet node

Do this **after 00:00 UTC**. Not before, and the reason is sharper than it
looks.

### Why a mainnet node cannot be started early — rehearsed 2026-08-28

The obvious reason is that block 1's timestamp must be later than genesis,
so nothing can be mined until the date arrives. `MAX_FUTURE_BLOCK_TIME` is
two hours, and a block dated 15 September mined in August is rejected by
every node including your own.

The reason that is not obvious was found by trying it. A mainnet node
started before 15 September works **once**, from an empty datadir, and then
cannot start again:

```
The block database contains a block which appears to be from the future.
Please restart with -reindex or -reindex-chainstate to recover.
[error] Aborted block database rebuild. Exiting.
```

The block from the future is genesis. On a fresh datadir it is constructed
in memory and accepted; on every start afterwards it is read from disk and
the startup verification refuses a stored block dated ahead of now. Both
halves of this were tested on 28 August: empty datadir starts and reports
height 0, restart fails, every time.

So a mainnet node left running "ready" before launch is not ready. One
reboot and it is a crash-looping service with `Restart=always` hammering it,
and the operator finds out on the morning it mattered.

**The units exist on both hosts and are deliberately disabled.** On the day
they are started, not installed.

Deliberately disabled was not enough. On 29 August I started the mainnet node
myself, on purpose, to test ElectrumX against it — and left a datadir behind
that could never start again. Knowing the rule did not help; nothing stopped
me. So `wamd-mainnet.service` now runs `scripts/genesis_gate.sh` as an
**`ExecCondition`**, which declines the start before 15 September and passes
silently after it. Both hosts have it, and on both the refusal was tested
rather than assumed: one refusal in the journal, unit inactive, no retry.

**Before 15 September, `systemctl start wamd-mainnet` returns success and
leaves the node not running.** That is how `ExecCondition` works — a
condition that is not met is not a failure — and the alternatives were worse:
as an `ExecStartPre` the refusal *is* a failure, and `Restart=always`
restarts a unit whose `ExecStartPre` failed, so every refusal became a loop.
The reason is written into the journal each time. After 15 September the
condition passes and the question stops existing.

A deliberate rehearsal passes `WAM_ALLOW_PRELAUNCH_START=1`, and is told in
the journal to empty the block database afterwards.

### Both hosts are on UTC — settled 2026-08-29

Germany ran `Europe/Berlin` and Singapore `Etc/UTC`, so at 00:00 UTC on 15
September one journal would have said 02:00 while the other said 00:00.
Nothing the chain does was affected — genesis, `MAX_FUTURE_BLOCK_TIME` and
every block timestamp are absolute — but a person reading two logs side by
side at two in the morning is, and that is exactly when an hour disappears.

It was found by a check of mine reporting a crash loop that was not
happening: it wrote a UTC mark and `journalctl --since` read it as local
time. Germany is now `Etc/UTC`. The calendar timers were re-checked after the
change rather than assumed — `wam-backup.timer` fired once on the way past,
succeeded, and its next run is 03:20 UTC, because a backup that quietly
stopped being nightly is a failure this project has already had.

What *was* proved by rehearsing, and does not need repeating on the night:
genesis validates from nothing and its hash matches the assertion; the
supply is 2,000,000 with all five tranches locked; the DNS seeds answer with
the mainnet nodes; and the two nodes find each other without help.

**The firewalls, re-verified 2026-08-30 by a method that cannot be wrong.**
A closed port means one of two different things — the provider drops it, or
nothing is listening — and before launch nothing listens on any mainnet
port, so an ordinary probe says "shut" and proves nothing at all. Each port
was given a temporary listener and knocked on from the other host:

**Re-measured 2026-09-13, and one row of this table was wrong.**

| Port | Germany | Singapore | US-east | |
|---|---|---|---|---|
| 9555 | open | open | open | mainnet P2P |
| 50001 / 50002 / 50004 | open | open | open | mainnet Electrum, as published |
| 51001 / 51002 / 51004 | open | open | open | testnet Electrum |

Twelve host-and-port pairs, each given a temporary listener and knocked on
from the founder's laptop — outside every one of our networks, which is
where a stranger stands.

The old row said the three testnet Electrum ports were **blocked at both
providers**, and used that as evidence: a port with a daemon behind it that
still cannot be reached is being dropped upstream. That was true on
30 August. The panels have been used repeatedly since — for 13333–13336 on
the 11th, among others — and the ports are open now. The conclusion the row
supported still holds and is now measured directly rather than inferred:
**nothing mainnet needs is waiting on a firewall.**

5. **Start one node on mainnet.** One, not three.

   ```bash
   systemctl start wamd-mainnet
   journalctl -u wamd-mainnet -f
   ```

   **Read the unit name twice.** On all three hosts `wamd.service` is the
   **testnet** node — it is running now, it stays running, and starting it
   again does nothing at all while looking like success. There is no
   `wamd-testnet.service`. Until 13 September this step said
   `systemctl start wamd`, and following it at 00:00 UTC would have left
   mainnet unstarted with a healthy testnet journal scrolling past as proof
   that everything was fine.

### Every command below carries the mainnet flags, and here is why

`/root/.wam/wam.conf` contains `testnet=1`. So a bare `wam-cli` on any of
these machines talks to **testnet** — it answers every question in this
document, in the right format, about the wrong chain. Define this once, at
the top of the night, and use it for everything:

```bash
M='wam-cli -chain=main -datadir=/root/.wam-mainnet'
$M getblockchaininfo        # must say  "chain": "main"
```

Measured, not assumed: those flags reach 127.0.0.1:**9554**, which is
`WAM_MAINNET_RPC_PORT`. A bare `wam-cli` reaches 19554 and reports
`"chain": "test"`.

6. **Genesis must be the hash you published.** This is the check the whole
   day rests on:

   ```bash
   $M getblockhash 0
   # must equal the assertion in src/wam/chainparams.cpp:
   # d8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9
   ```

   Without the flags this prints the **testnet** genesis, it will not match,
   and the instruction below will stop a launch that had nothing wrong with
   it.

   If it does not match, **stop here**. Nothing has been mined. The chain
   does not exist yet and you have lost nothing but an hour.

7. **The money must be where you said it would be.**

   ```bash
   $M getsupplyinfo
   # circulating              2,000,000
   # founder_vesting.unlocked 0
   # founder_vesting.locked   2,000,000
   ```

8. **The five premine outputs must exist and must be locked.**

   ```bash
   $M getblock $($M getblockhash 0) 2
   # five outputs, every one a 32-byte scriptPubKey, none spendable today
   ```

**This is the last completely safe point.** Everything so far can be
abandoned with no consequence to anyone.

---

## Phase C — the other nodes

9. **Start node 2, then node 3.** Confirm each one finds the others and
   agrees on genesis before starting the next.

   ```bash
   $M getconnectioncount
   $M getblockhash 0        # on every host, the same hash
   ```

10. **Confirm the seeds answer with mainnet nodes.**

    ```bash
    bash scripts/check_dns_seeds.sh
    dig +short x9.seed1.wamcoin.org
    ```

11. **Confirm a stranger can sync from genesis**, from outside your
    machines:

    ```bash
    bash scripts/check_fresh_sync.sh --network mainnet --peer <host1>
    ```

---

## Phase D — the point of no return

Read the sentence at the top again before this step.

### The pool's wallet — done on 2026-08-30, not on the night

The pool pays miners from a wallet it can spend from, so that key is hot by
necessity and lives on the machine. It is **not** the founder wallet and
must never be: `WWWEvpC98mfzjRMZHtaRaucMjopqH2viQz` and
`WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE` are compiled into consensus, their keys
came out of the ceremony and are in cold backup, and putting either on an
internet-facing machine running a public service is how coins are lost.

This section said the wallet could not exist before the day, because an
address needs a running node and the node cannot run before 15 September.
Both halves were true and the conclusion was wrong.

**The node can run once, deliberately** — that is what the gate's override
is for, and it was written for exactly this. `wamd` runs, RPC works fully
while it does, and the three directories that must be emptied afterwards are
`blocks`, `chainstate` and `indexes`. **A wallet is not in any of them.**

So it is done:

```
wallet    /root/.wam-mainnet/pool/wallet.dat
address   wam1qrulaxxlqf65madsmhqrevf467r6qmgdrxhf9yw
config    config-mainnet.json, on the pool host beside the live config
          (0600, written and verified). It is NOT in this repository and
          must not be: it carries the mainnet RPC password.
backup    /root/backups/mainnet-pool-wallet-20260830.dat
```

And proved rather than assumed: with `blocks`, `chainstate` and `indexes`
removed — the exact state the datadir is in now, and will be in on the night
— the node was started fresh, **loaded the `pool` wallet by itself**
(`load_on_startup=true`), and still reported `ismine: true` for that
address. Then it was stopped and cleared again.

Two things were learned doing it, and both are corrections to this document:

- **`WAM_ALLOW_PRELAUNCH_START=1 systemctl start wamd-mainnet` does
  nothing.** systemd does not inherit the caller's environment, so the gate
  never sees the variable and refuses exactly as it would have anyway. The
  deliberate path is to run `wamd` directly — which touches no unit and sets
  no global variable that could linger and quietly disable the gate for
  everything. `systemctl set-environment` would work and is worse: it stays
  set.
- **Wallets live in the datadir root here, not in `wallets/`.** Bitcoin Core
  uses `<datadir>/wallets` only if that directory already exists. It did
  not, so the wallet is at `/root/.wam-mainnet/pool/`. A first check of mine
  looked in `wallets/`, found nothing, and reported the wallet destroyed
  when it was sitting one directory up.

On the night, the pool therefore needs no wallet work and no JSON editing:

```bash
cp /opt/wam/pool/config-mainnet.json /opt/wam/pool/config.json
systemctl restart wam-pool
```

**What that command does to testnet, said plainly.** There is one
`wam-pool.service`, so copying the mainnet config over `config.json` and
restarting **converts** the pool rather than adding one: the testnet pool
stops serving 13333-13336 at that moment, and the founder's own miner —
most of the testnet hash rate — has nowhere to point. Phase A says stop
nothing; this is the one thing that does stop. Running both at once needs a
second unit, which is a change and not a step, and it is not made on the
night.

**And the accounting collision that was found reading this line on
13 September.** Both pool configs carried `redisPrefix: "wam"` and
`redis.db: 0`, and `lib/shareProcessor.js` builds every key as
`prefix:part:part` with **no network in it**. So the copy above would have
started the mainnet pool on a Redis database holding testnet shares, rounds
and balances — real coins owed against test work, on the first payout
cycle. The mainnet config now uses `redisPrefix: "wam-main"`, `redis.db: 1`
and `apiPort: 8081`; the testnet one is untouched on `wam`, db 0, 8080.
Nothing here is shared any more, which is also what would make two
simultaneous pools possible.

The four values that differ are already in that file — `network`,
`poolAddress`, and `daemons[0].port` and credentials. It is `daemons[0]`, an
array, not `daemon`: a rehearsal edited the wrong key, the pool connected to
the testnet node, and said so rather than mining to the wrong chain:

```
config says network='regtest' but wamd reports chain='test'. Refusing to start.
```

**Turn on the mainnet backup, once the node is up.** One command:

```bash
systemctl enable --now wam-backup@mainnet.timer
```

**And the reorg watch, on all three hosts.** This step was missing from this
file until 13 September: the runbook turned on the mainnet backup and the
mainnet Electrum and never turned on the one watcher whose subject is the
chain itself. Testnet has had it running since August. Mainnet would have
launched with nobody watching for a reorganisation — on the night when a
split between our own three nodes is the most consequential thing that can
happen and the least visible.

```bash
systemctl enable --now wam-reorg-watch@mainnet.timer
```

`check_reorg.py --local --network mainnet` is what it runs, and the template
is installed on all three hosts already. Each carries
`OnFailure=wam-alert@%n.service`, so the watcher's own death is alarmed too.

The copy above was taken by hand with the node stopped, which is safe, but
it is one file from one day. From here the wallet that pays miners is in
the nightly archive like everything else.

It has to come after the node starts, not before: the script takes the
wallet through `backupwallet` over RPC, and copying a live wallet file
yields something that opens corrupt. The unit is already installed on both
hosts and deliberately left disabled, so this is an enable and not an
install. Confirm it took:

```bash
systemctl start wam-backup@mainnet.service && ls -1t /root/backups/wam-backup-mainnet-*.gpg | head -1
```

12. **Start mining.** The pool, or a single miner — it does not matter
    which, only that a block is produced.

13. **Block 1 must pay the treasury.** If it does not, the rule is not
    being enforced and you have just created a chain that does not do what
    the whitepaper says:

    ```bash
    $M getdevfeeinfo "$($M getblockhash 1)"
    ```

14. **Blocks 1 to 30, every one of them.** Not a sample.

    ```bash
    for h in $(seq 1 30); do
        $M getdevfeeinfo "$($M getblockhash $h)"
    done
    ```

15. **Confirm at least one other node has block 1.** A block only you have
    seen is not yet a chain.

---

## Phase E — the services people use

None of these can start before there is a chain for them to read.

### Rehearsed 2026-08-29, so it does not have to be discovered on the night

The installer used to write one env file, one database and one service name
for every network. Running it for mainnet would have overwritten the testnet
configuration in place — pointing a mainnet server at a database indexed for
another chain and taking the testnet servers down in the same move.

It is now one instance per network: `wam-electrumx@mainnet` and
`wam-electrumx@testnet`, each with its own `/etc/wam/electrumx-<net>.env`,
its own `/var/lib/electrumx-wam-<net>`, and its own ports.

Three things were found by doing it rather than reading it:

- **The mainnet node had no fixed RPC credentials.** It authenticated by
  cookie, and the cookie is rewritten at every node start, so an ElectrumX
  configured against it would have worked once and failed silently at the
  node's first restart. Both hosts now have a fixed pair, added while their
  mainnet nodes were stopped. The installer refuses a cookie-only node.

- **ElectrumX does not index the genesis block.** The node has all five
  premine outputs in its UTXO set — verified, `gettxoutsetinfo` reports
  2,000,000 WAM at height 0 — but a light wallet asking Electrum about those
  scripts is told zero. Ordinary blocks index correctly; the testnet
  instance returns real balances at 3,468 blocks deep. So anyone checking
  the founder reserve must ask a node, not a wallet, and that is worth
  saying before someone reports it as a missing premine.

- **The ports collide.** Testnet's ElectrumX holds 50001/50002/50004, and
  those are the mainnet numbers published in the Komodo entry and the
  listing sheet. Mainnet cannot take them while testnet is on them.

16. **Electrum: one command per host.**

    The handover was done on 2026-08-29, deliberately not on the night.
    Testnet's ElectrumX now lives on 51001/51002/51004 with its index
    carried across rather than rebuilt, and 50001/50002/50004 have been held
    empty since — so nothing answers on a mainnet port with a testnet chain,
    which is the state a listing reviewer would have found a defect in.

    **Two hosts, and not the third — changed 2026-09-13.**
    `electrum.wamcoin.org` is Germany and `electrum2.wamcoin.org` is now
    **US-east**, not Singapore. Wallet queries are the half of the load that
    grows with adoption, and Singapore has 1914 MB against US-east's 7941;
    it is a seed node and nothing else now. The command runs on those two:

    ```bash
    systemctl enable --now wam-electrumx@mainnet     # Germany and US-east
    ```

    On Singapore the instance is installed and **disabled**, so an absent
    step is not a missing capability — it is a decision, and the unit is
    there if the decision changes.

    Then, from somewhere else entirely:

    ```bash
    python3 scripts/check_electrum.py --node <host1> --network mainnet \
        electrum.wamcoin.org electrum2.wamcoin.org
    ```

### The pool's ports collide — found 2026-09-04, closed 2026-09-11

`pool/config.json` (testnet) and `pool/config-mainnet.json` both claim **3333,
3334, 3335 and 3336**. They cannot both run. On the night, starting the
mainnet pool either fails to bind or takes the testnet pool down — and 3333 is
the port [START_HERE](START_HERE.md) tells every newcomer to point a miner at,
so it must be mainnet's.

This is the same collision found in ElectrumX on 29 August and it has the same
answer: move testnet aside, hold the published ports empty. Testnet goes to
**13333–13336**, following the prefix this project already uses for 9555/19555
and 9554/19554.

It was done and reverted on 4 September, because Contabo drops those four
ports upstream. Measured rather than assumed: `tcpdump` on the server while
Singapore knocked showed SYNs arriving on 3333 and **nothing at all** on
13333, while `iptables -S` carried an explicit ACCEPT for it. A network fault
does not distinguish two ports on one address; a firewall rule does.

Their control panel was returning *"Your VPS/VDS could not be loaded"* at the
time, so the rule could not be added. The testnet pool was put back on
3333–3336 rather than leave the founder's laptop — most of the testnet
hashrate — unable to reach a pool for hours over a change that is eleven days
early.

**To finish it, in this order:**

1. Contabo panel → Firewall → allow TCP **13333, 13334, 13335, 13336**
2. `bash scripts/move_testnet_pool.sh` — moves the config, repoints our miner,
   opens ufw, restarts, and verifies from outside that 3333–3336 are empty and
   13333–13336 answer
3. Repoint the laptop miner at `pool.wamcoin.org:13333`

**Done on 11 September.** All three steps ran: the ports were opened in the
Contabo panel, `move_testnet_pool.sh` moved the config and verified from
outside that 3333-3336 answer nothing and 13333-13336 do, and the published
mining commands were changed to 13333.

So launch night no longer has the step that must not be forgotten. It used
to read: stop `wam-pool` before starting the mainnet one. There is nothing
on 3333-3336 to stop.

17. **The pool.** Its payout address is mainnet and it must be checked
    before a single share is credited:

    ```bash
    python3 scripts/check_pool.py --node <host1> --network mainnet
    ```

### Rehearsed against a real mainnet node, 2026-09-04

A mainnet node was started deliberately on Germany, ElectrumX and the explorer
were run against it, every check in this phase was run, and the whole thing was
torn down — blocks, chainstate and indexes emptied, the pool wallet verified
byte-identical afterwards by checksum, and the testnet untouched throughout.

What it proved:

- The mainnet node comes up correctly. `chain=main`, height 0, genesis
  `d8d3debea987b62a…` matching the hash asserted in `chainparams.cpp`,
  circulating 2,000,000 — the premine present in the UTXO set — and 9555
  listening.
- ElectrumX serves the **published** ports 50001/50002/50004 and answers.
- The explorer reads a mainnet node with no configuration beyond
  `WAM_CONF=/root/.wam-mainnet/wam.conf`, and publishes the treasury address,
  the 400,000 end height, the 120-second spacing and **2,000,000 WAM locked
  across five tranches, 0 unlocked**.

What it found, none of which reading would have shown:

- **Six checks silently read the wrong chain.** `check_bots`, `check_electrum`,
  `check_explorer`, `check_peer_versions`, `check_pool` and `check_visitors`
  all mapped `mainnet` to an EMPTY `wam-cli` flag — which means the default
  datadir, which on both servers is the **testnet** node. Asked about mainnet
  they answered about testnet, confidently. Among them the check that says
  "everyone can follow mainnet" and the one this runbook requires before a
  single share is credited. Now `scripts/wamcli.py`, one place, and mainnet
  carries `-chain=main -conf=… -datadir=…` as it always needed to.
- **The gate printed an override that does nothing.** Its refusal told the
  operator to run `WAM_ALLOW_PRELAUNCH_START=1 systemctl start <unit>`;
  systemd does not pass the caller's environment to a unit, so the gate never
  saw it and refused anyway. It looked like a broken override on the one night
  it would be needed. It now prints the direct `wamd` command, which works.
- **The explorer ignores `PORT`.** Its port is a `--port` flag. Two instances
  cannot run side by side without it, which is exactly what the night needs:
  the mainnet one starting while the testnet one is still up.
- **`check_explorer` called a height-0 chain a fault.** It reported the
  treasury rule "inactive" — which is correct at genesis, since the rule
  starts at height 1 — and counted it towards the failures. Above height 0 an
  inactive treasury is still a real failure and now reads as one.

18. **The explorer**: point it at mainnet, then confirm it publishes what
    consensus enforces.

    `explorer.wamcoin.org` keeps its URL. There is no second address, and
    nothing about it changes by itself at midnight: nginx sends that name to
    127.0.0.1:8081, which is `wam-dashboard.service`, which reads whatever
    `WAM_CONF` points at -- and that is the TESTNET conf until somebody
    changes it. Without this step the explorer goes on publishing testnet
    after mainnet is live, under the name everyone was told to watch.

    The drop-in is written and waiting on the pool host; the night moves it
    into place:

    ```bash
    mv /etc/systemd/system/wam-dashboard.service.d/mainnet.conf.ready \
       /etc/systemd/system/wam-dashboard.service.d/mainnet.conf
    systemctl daemon-reload
    systemctl restart wam-dashboard
    systemctl show wam-dashboard -p Environment     # WAM_CONF=/root/.wam-mainnet/wam.conf
    ```

    Then the check, which must be run AFTER the switch or it measures the
    old chain:

    ```bash
    python3 scripts/check_explorer.py --node <host1> --network mainnet
    ```

    **And the port the pool must not take.** 8081 is the explorer's. The
    mainnet pool config carried `apiPort: 8081` from 13 September until this
    was read on the 15th: the config swap in Phase D would have had the pool
    fail to bind a port the explorer already held, while `pool.wamcoin.org`
    -- which nginx sends to 8080 -- pointed at the port the testnet pool had
    just vacated. Both pool configs are on 8080 now, one at a time, which is
    what the single `wam-pool.service` allows anyway.

---

## Phase F — telling people

Not before Phase D has passed. An announcement that precedes a verified
chain is a promise, and this project does not make those.

19. **Publish the facts anyone can check**: genesis hash, merkle root,
    treasury address, the height at which the treasury rule ends.

20. **Point the bot at mainnet first.** This step exists because a dry run
    on 29 August produced the launch announcement headed:

    ```
    🧪 TESTNET — coins here have no value
    ```

    The bot asks whichever node its config names which chain it is on, and
    labels the message accordingly — which is right, and is why nothing it
    sends can be mistaken for the wrong network. But `/etc/wam/announce.json`
    names port 19554, and nothing in this document had ever said to move it.
    The message would have been correct and the banner would have been
    correct, and the two together would have announced the birth of the chain
    over a line saying its coins are worthless.

    So: edit `/etc/wam/announce.json` to the mainnet RPC port (9554) and
    credentials, then restart `wam-announce`.

21. **Announce.** `--expect main` is not optional. It asks the node what
    chain it is on and refuses to send anything if the answer is not the one
    you named — because a note in a document does not stop a mistake at two
    in the morning, and this does.

    ```bash
    node bots/say.js --file posts/launch.txt --expect main --dry-run   # read it
    node bots/say.js --file posts/launch.txt --expect main
    ```

    The text is written and lives at `posts/launch.txt`. Read it once in
    daylight before the night, not for the first time at 02:00.

22. **The release for mainnet** — if a new version is cut for the day, its
    tag message is the release note and `scripts/consensus_floor.py` decides
    whether it needs a `MANDATORY:` line. The workflow refuses to publish a
    consensus change without one.

---

## If blocks slow right down, and nobody attacked you

Measured on 12 September, and the most likely disruption of launch week.

Somebody rents RandomX by the hour, finds a coin whose difficulty is low,
mines it, and leaves. No malice is required. The difficulty they caused stays
behind, and the chain crawls until DGW walks it back down.

**This has happened to us once already, deliberately.** On 5 September the
founder and Sparks60 pointed three machines at the testnet — about 7× the
network. Difficulty rose to 6.26× the minimum, the block after they stopped
took 35 minutes, and the chain was back to normal 79 minutes later with nobody
touching anything. Heights 5248 to 5618 carry it, and `docs/REHEARSALS.md` has
the measurements.

`scripts/dgw_model.py` extends that to multiples we cannot rent. The numbers
are multiples of whatever the network's hash rate is at the time, so they
carry over from testnet:

| the visitor | slowest block after they go | back to 2-minute blocks |
|---|---|---|
| 20× for 1 hour | 23 min | ~2 hours |
| 100× for 1 hour | 24 min | ~2 hours |
| 20× for 6 hours | 42 min | ~3 hours |
| 100× for 6 hours | 3 h 29 min | ~14 hours |

**Duration is the danger, not size.** An hour of anything is survivable
because only about thirty blocks fit in the 24-block window and one retarget
cannot move more than 3×. Six hours lets difficulty climb the whole way.

Those numbers assume **our own** miners keep running when the visitor leaves.
If ours stop at the same moment, the slowest block stretches by whatever
fraction we lost — which is precisely why 5 September left a 35-minute block
where the model said twelve. On launch night the miners are other people's,
so that is less likely than it was in the test; if the pool is also quiet,
expect the longer figure.

**What to do, in order:**

1. **Confirm that is what it is, and the difficulty tells you.** A slow chain
   with difficulty well above the minimum is this, and it passes. A slow chain
   sitting AT the minimum is our own miners stopping, and that is the outage
   this network has actually had, every time: the ten longest gaps in the
   testnet chain are 203, 170, 120, 118, 113, 105, 103 and 96 minutes, and
   **every one of them happened at the minimum difficulty.** Meanwhile the
   longest gap ever recorded while difficulty was elevated is 35 minutes. At
   the minimum there is nothing to wait out — difficulty cannot fall further,
   so something of ours is off.

2. **Do not change consensus.** Not the window, not an emergency-difficulty
   rule, not the clamp. A consensus rule invented at three in the morning is
   worse than a slow chain, and it splits the network between whoever updated
   and whoever did not. This is a known property of DGW and it ends by itself.

3. **Add what hash rate we have.** The founder's machine and any seed with
   spare cores, pointed at the pool. It shortens the recovery in proportion
   and nothing else does.

4. **Say what is happening, in the channel, while it happens.** A chain that
   explains a 40-minute block looks like a project with operators. A chain
   that goes quiet for three hours looks abandoned, and that impression is
   harder to undo than the delay itself.

5. **Do not restart nodes.** Nothing is wrong with them. A restart adds an
   outage to a delay and loses the `debug=net` record of who was mining.

---

## What to do when something fails

| When | What it costs |
|---|---|
| Anything in Phase A or B | nothing. Stop, fix, start again. |
| Phase C — a node will not connect | nothing yet. The chain is one node deep and can still be abandoned. |
| **Phase D onwards** | the chain exists. Consensus cannot be changed. A defect here is lived with, not fixed. |

The temptation at 02:00 will be to push through a step that half worked.
The whole reason the irreversible line is drawn at Phase D is so that the
answer before it is always *stop*.

---

## Two decisions to make before the day, not on it

**Does testnet keep running?** It costs a machine and it is where every
future change gets tested before it reaches people's money. Two independent
operators are on it. Stopping it loses them and loses the rehearsal ground.
Keeping it means running two chains. Decide in advance and write the answer
here.

The expensive half of this was settled on 29 August, before the day, so the
decision no longer costs anything on the night: testnet's ElectrumX already
moved to 51001/51002/51004, and mainnet's ports are already free. Whichever
way the answer goes, launch night is one `systemctl enable --now` per host.

**The answer, decided 12 September: Singapore runs mainnet only.** Stop
testnet there on the night. There are three seeds now, and testnet keeps
running on the two that have room for it -- Germany and the US seed -- so
nothing is lost: the rehearsal ground stays, and the two independent
operators keep a chain to be on.

This is a memory decision and the number behind it is not a tuning knob.
A WAM node holds **512 MiB for RandomX alone** -- two verification contexts
at 256 MiB each, which is what lets it check proof-of-work at all. The node's
own RPC says so:

```
wam-cli getrandomxinfo   ->   "memory_bytes": 536870912
```

and `wamd` on Singapore has an RSS of 537 MB against a `dbcache` of 100 and a
19 MB chain. Practically all of the node's memory is RandomX, and the mainnet
node will want the same 512 MiB beside it.

Singapore has 1914 MB. Two nodes plus two ElectrumX plus the system is about
1.3 GB of it, which fits only by leaning on swap -- and a node validating
blocks out of swap is the slowest thing it can be on the night it matters
most. Stopping testnet there frees 512 MiB in one command and costs nothing.

The alternative was priced before being dismissed: rescaling that machine
from 2 GB to 4 GB is $31/month against $18, in a region where Hetzner
charges Asian rates. A hundred and fifty-six dollars a year for memory that
one `systemctl stop` releases.

**And whatever any of these machines is ever rescaled to, it must stay
x86_64.** Hetzner offers Arm64 (Ampere) beside x86 in its cheaper tiers, a
few dollars less, one radio button away from the price. Every binary this
project ships is `x86_64-linux-gnu`, and the only ARM target in the
repository is macOS on Apple Silicon -- there is no Linux ARM build.

An Arm64 server cannot run `wamd` at all. Not slowly, not with less memory:
as a file the loader refuses. The panel would show a healthy server with no
node on it, which is the shape of failure that takes longest to find.

**That was outstanding and is not any more.** 51001/51002/51004 were added
in both panels at some point and nobody wrote it down; measured from outside
both hosts on 11 September, all three answer. The worry was real while it
lasted — Contabo and Hetzner each drop inbound TCP to any port not on a
panel allow-list, and a dropped packet is silent, so a server looks perfect
from the inside while nothing reaches it.

Mainnet's 50001/50002/50004 correctly answer nothing yet: ElectrumX for
mainnet is not running. That is the difference between a closed port and a
blocked one, and it is why this is checked from outside rather than with
`ufw status`.

**Who is awake?** Every step above assumes one person doing them in order.
If that person is asleep at 04:00 the chain does not stop, but nobody is
watching it either. Decide what is checked in the morning rather than
watched all night.
