# Start here

**[بالعربية](START_HERE_AR.md)**

This page assumes you know nothing about cryptocurrency. If you already run a
node for another coin, skip to [Run a node](#3-run-a-node) — the commands are
what you expect, and the numbers you need are in the table at the end.

---

## 1. What is WAM, in plain words

WAM is money that no company issues and no bank holds.

There is a list of every payment ever made, and thousands of computers each
keep their own copy of that list. When you send WAM, your payment is announced
to all of them, they check it against their copies, and if it is valid they all
add it. Nobody can quietly change the list afterwards, because everyone else
still holds the version without your change.

That list is the *blockchain*. A computer keeping a copy is a *node*.

**Why anyone would bother:** nobody can freeze it, nobody needs your permission
to receive it, and nobody can print more than 22,000,000 of it — ever. That
number is not a promise. It is arithmetic every node checks on every block, and
a block that breaks it is thrown away by strangers who never heard of you.

**What makes WAM different from Bitcoin:** Bitcoin mining now needs specialised
machines that cost thousands. WAM uses an algorithm called *RandomX* that runs
best on the ordinary processor already in your laptop. The point is that
someone with one computer can take part, not only someone with a warehouse.

---

## 2. What you need

- A computer with Linux or Windows, 64-bit Intel or AMD — a laptop is fine
- About 2 GB of free memory and 5 GB of disk
- An internet connection

That is all. No graphics card, no special hardware, no money to start.

> **Windows.** Since **v0.1.8** there are signed Windows downloads — a `.zip`
> with the node and a second one with the miner — and they need no WSL and no
> Linux. [MINE.md → Windows](MINE.md#windows) is the shortest path: seven
> lines.
>
> Read the part of that page about **your antivirus** before you run the
> miner, not after. Windows Defender deleted it fourteen seconds into its
> first run on a real desktop and called it a trojan, because a program that
> connects to a network and then uses every core is behaviourally identical to
> the mining malware people get infected with. It is a false positive, we have
> no publisher certificate to prevent it, and the honest answer is to check
> the SHA256 and the signature yourself rather than to trust or distrust a
> guess.
>
> **WSL still works** and is a reasonable choice if you already have it: the
> release is built on Ubuntu 22.04 and `wsl --install` on Windows 11 gives you
> Ubuntu 22.04, so the system libraries the Linux binary was linked against
> are the ones it finds. The memory and disk above are what Linux needs inside
> WSL, not what Windows needs on top of it.
>
> **Mac — Apple Silicon only.** Since **v0.1.8** there is a signed download
> for Macs with an M-series chip: two `.tar.gz` archives, node and miner,
> built natively on macOS rather than cross-compiled, and covered by the same
> `SHA256SUMS` and signature as everything else.
>
> There is no `.dmg` and no installer. You unpack the archives and run the
> binaries from a terminal, exactly as on Linux. macOS will also refuse to
> run them on the first attempt, because they carry no Apple notarisation —
> that costs a paid developer account and this project does not have one.
> [MINE.md → macOS](MINE.md#macos) says what the message looks like and what
> to do about it.
>
> **An Intel Mac is not covered.** A binary for one architecture does not run
> on the other, and adding the second one to the build asks a free public
> repository for a second macOS runner per run, in a queue that already costs
> hours. Every Mac sold since 2020 is Apple Silicon; if yours is older, build
> it — [BUILD.md §9](BUILD.md#9-building-on-macos), about twenty minutes, and
> it takes boost from `depends/` rather than Homebrew for a reason that page
> gives. That run is also worth more to this project than another Apple
> Silicon one, because nobody has done it.
>
> **Do not run a Linux binary on an Apple chip through a container.** Our
> Linux download is x86_64 and that processor is ARM, so it would be emulated:
> readable, and useless for mining.
>
> **Building on Windows yourself** is also still there, if you prefer your own
> compiler to our signature: [BUILD.md §8](BUILD.md#8-building-for-windows),
> about forty minutes, and it needs Ubuntu 24.04 rather than 22.04 for a
> reason that page gives.


---

## 3. Run a node

A node is a program that keeps a copy of the list and checks every payment on
it. It runs quietly in the background. You do not need one to own WAM, but
running one means you verify the rules yourself instead of trusting somebody
else's answer.

### If you would rather have a window than a terminal

From v0.1.11 there is a wallet with a window, `wam-qt`, for Linux, Windows and
macOS. It syncs, creates and encrypts a wallet, and sends and receives, and
everything below can be done in it instead of at a prompt.

It is **the same node underneath**, so use it *instead of* `wamd` and not
beside it — never run both against one data directory at the same time.

    wam-qt-v0.1.11-x86_64-linux-gnu.tar.gz
    wam-qt-v0.1.11-x86_64-w64-mingw32.zip
    wam-qt-v0.1.11-arm64-apple-darwin.tar.gz

It is a separate download so that a node is not several times larger for the
people who never open a window. On Linux it needs your distribution's Qt 5
installed and the archive's README carries the one line for apt, dnf and
pacman; on Windows and macOS it needs nothing.

Said plainly, because it is four days old: it has been opened by hand on Linux
and Windows, and on macOS it has been built, started and synced from genesis by
the build machine, with no person yet sitting in front of it.

**If you already run `wamd` and want to move to the window, read
[the move, in docs/MINE.md](MINE.md#moving-from-the-terminal-node-to-the-graphical-wallet)
first.** Three things stop people on the way across and none of them says so
at the time: the wallet does not open the RPC port that `wamd` opens for
itself, so a solo miner stops without a message; an installation older than
v0.1.10 on Windows or macOS keeps its chain and wallet in a folder called
`Bitcoin`, so a wallet started without `-datadir` opens an empty one and a
wallet that is perfectly safe looks lost; and the *Receive* tab shows a new
address every time it is pressed, which is one wallet with many addresses
rather than a new wallet. The page has the whole move in five commands.

The rest of this page is the terminal. Everything in it still applies.

### Download it

```bash
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-coin-v0.1.13-x86_64-linux-gnu.tar.gz
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS
```

### Check that it is really our file

```bash
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl -LO https://wamcoin.org/verify_release.sh
curl -LO https://wamcoin.org/SIGNING-KEY.asc
bash verify_release.sh .
```

You should see `OK`. If you see `FAILED`, the download was corrupted or altered
— delete it and download again. **Do not skip this.** It costs one second and
it is the only thing standing between you and a file somebody else swapped in.

### Unpack and run

```bash
tar -xzf wam-coin-v0.1.13-x86_64-linux-gnu.tar.gz
cd wam-coin-v0.1.13/bin
./wamd -printtoconsole
```

**Or `-daemon` instead of `-printtoconsole`, if you would rather it ran in the
background.** `-printtoconsole` shows you the node working, which is how you
notice something is wrong before a check tells you — but it dies when you
close the terminal. `-daemon` survives that and shows you nothing. You can
have both: run `-daemon`, then `tail -f ~/.wam/debug.log` in any
terminal for the identical stream. The log file is written in all three cases.

This choice used to be a line at the end of a long note further down, and the
one tester who cared about it most read past it twice before saying so. That
is a placement fault, not his.

> **If it will not start, this is almost always why.** The download needs four
> things from your system, and nothing else:
>
> ```
> libevent-2.1.so.7   libevent_core-2.1.so.7   libevent_pthreads-2.1.so.7
> libsqlite3.so.0
> ```
>
> One command tells you whether you have them:
>
> ```bash
> ldd ./wamd | grep "not found"
> ```
>
> Silence means you are fine. If something prints, install it:
>
> | | |
> |---|---|
> | Ubuntu 24.04, Debian 13 | `sudo apt install libevent-2.1-7t64 libevent-pthreads-2.1-7t64 libsqlite3-0` |
> | Ubuntu 22.04, Debian 12 | `sudo apt install libevent-2.1-7 libevent-pthreads-2.1-7 libsqlite3-0` |
> | Fedora, RHEL | `sudo dnf install libevent sqlite-libs` |
> | Arch | `sudo pacman -S libevent sqlite` |
>
> **The `t64` is not a typo and the two lines are not interchangeable.**
> Ubuntu 24.04 renamed these packages during the 64-bit `time_t` transition,
> and `libevent-2.1-7` simply does not exist there — `apt` answers `Unable to
> locate package`, which reads as a broken instruction rather than the wrong
> release's instruction. Measured on both: 24.04 reports `Candidate: (none)`
> for the old name.
>
> **And `libevent-pthreads` is a separate package, on both.** `libevent-2.1-7`
> depends on `libc6` and nothing else; it does not bring pthreads with it.
> This page said it did until 11 September, and got away with it because most
> machines already carry that library for some other reason. A clean server
> does not — which is how it was found, installing a seed node on a fresh
> Ubuntu 24.04 and watching `wamd` fail on
> `libevent_pthreads-2.1.so.7: cannot open shared object file`.
>
> glibc is not something to worry about: the binary's highest requirement is
> `GLIBC_2.34` and glibc is backward compatible, so any newer distribution
> works. And **`wam-miner` needs none of this** — only libc and libstdc++ —
> so if the node has trouble on your distribution, mining still will not.

The window will fill with lines. That is the node introducing itself to other
nodes and asking them for the list. Leave it running.

> **The whole log is in a file, and you will want it before you want the
> screen.** `-printtoconsole` puts the log on your terminal, and a terminal
> keeps only the last few hundred lines — somebody trying to report a problem
> on 7 September lost the start of his because of that. The node also writes
> it, complete and from the first line, to
>
> ```
> ~/.wam/debug.log
> ```
>
> Quote from that file, never from the screen — in `-daemon` too, where the
> file is the only copy there is.

To watch it in another terminal:

```bash
./wam-cli getblockcount
```

That prints how many blocks you have. It should climb until it matches what
[explorer.wamcoin.org](https://explorer.wamcoin.org) shows.

> **The first minute looks like nothing is happening. It is not broken.**
>
> `getblockcount` can sit at **0** for up to a minute while the node builds
> the RandomX verification tables it needs before it can check a single block.
> Nothing is downloaded in that time and nothing is wrong. Then the count
> starts climbing and does not stop.
>
> **How long the whole thing takes depends on your processor, and the spread
> is wide.** Three cold starts measured on 7 September 2026, from empty
> directories:
>
> | | to the first block | whole chain |
> |---|---|---|
> | Linux release, ordinary desktop | 2 seconds | **2m 51s** (6,666 blocks) |
> | Linux release, loaded 6-core server | — | 12 blocks/second |
> | Windows build, Windows 11 laptop | 80 seconds | about 10 minutes |
>
> So: two or three minutes on a good machine, ten on a slower one, and the
> limit is the processor rather than the connection — RandomX verification is
> the whole cost. The first of those rows was measured by somebody outside
> this project, on his own hardware, which is why it is first.
>
> This paragraph exists because somebody started a node on 7 September, waited
> **three minutes and fifty-two seconds**, and left. Nothing had gone wrong:
> he had the first 4,000 block headers and was downloading blocks when he
> quit. He had no way of knowing that, because this page did not tell him.
>
> To see that it is working rather than guess, watch the **headers**:
>
> ```bash
> ./wam-cli getblockchaininfo | grep -E '"blocks"|"headers"'
> ```
>
> Measured on a cold start, 7 September: `headers` reached 6,000 within eight
> seconds of the node starting, while `blocks` was still 0 and stayed 0 until
> the 88th second. Headers are cheap and arrive at once; blocks are what
> RandomX has to verify, and that is what the wait is.
>
> So `headers` climbing to roughly what
> [explorer.wamcoin.org](https://explorer.wamcoin.org) shows means your node
> found the network and knows where the tip is. If `headers` is still 0 after
> a minute, that is the real problem, and it is a connection problem rather
> than a slow one.
>
> **Ignore `verificationprogress`.** Bitcoin Core reports it and every guide
> about other coins tells you to watch it. On WAM it reads `1` at every height
> including zero, because it is estimated from a transaction-rate figure this
> chain does not publish. It is not lying about your node; it is answering a
> question nobody gave it the data for. The block count is the only progress
> there is.
>
> **A restart looks the same, for the same reason.** Measured on somebody
> else's machine on 7 September, from his log: `nBestHeight = 6643` at
> startup — already fully synced — and then 109 seconds of nothing before
> the first new block was processed. The line that ends the wait names the
> cause: `RandomX: initialising verification context for seed …`. The tables
> are built when the first block needs checking, not when the node starts, so
> a node you restart is quiet for a minute or two exactly like a new one.

> **No flag?** Right. These commands are for the live chain, which has been
> running since 00:00 UTC on 15 September 2026. See
> [section 7](#7-two-things-you-must-know).

---

## 4. Make yourself an address

An address is where WAM is sent, like an account number. It is free, you can
make as many as you like, and you do not register it with anyone.

```bash
./wam-cli createwallet "mine"
./wam-cli -rpcwallet=mine getnewaddress
```

> **Back it up before you do anything else.** One command, now, while there is
> nothing in it to lose:
>
> ```
> ./wam-cli -rpcwallet=mine backupwallet ~/wam-wallet-backup.dat
> ```
>
> This page says the same thing again further down, and on 6 September that was
> a hundred lines too late: somebody following it created a wallet, tidied his
> directory an hour later, and deleted the only copy. On the test chain that cost
> nothing. The habit is what is being built here, and the person who builds it
> on 15 September has money in the file.

**If you restart the node and `wam-cli` answers `-18 Requested wallet does not
exist or is not loaded`,** the wallet is on disk and simply not open. Bitcoin
Core reopens the wallets it had open when it was last shut down cleanly; a
node stopped any other way, or started against a datadir that was cleared,
comes back with none.

```
./wam-cli listwallets           # what is open right now
ls ~/.wam/wallets/              # what exists on disk
./wam-cli loadwallet "mine"     # open it again
```

Nothing is lost either way — `createwallet` writes a file and deleting
`blocks`, `chainstate` or `peers.dat` does not touch it. This was found on
6 September by somebody following this page, restarting his node three times,
and being told his wallet did not exist.

**And if the machine itself is gone, this is how the backup goes back.** Put
it where the node looks, under the name the node expects:

```
mkdir -p ~/.wam/wallets/mine
cp /path/to/your/backup.dat ~/.wam/wallets/mine/wallet.dat
./wam-cli loadwallet "mine"
./wam-cli -rpcwallet=mine getbalance
```

The rename is the part that catches people: your backup may be called
anything, but the file inside the folder must be `wallet.dat`, and the folder
must carry the wallet's name. Get either wrong and the node reports a wallet
that does not exist rather than a file that is misnamed.

If the balance reads zero when you know it should not, the node has not looked
at the older blocks yet — `./wam-cli -rpcwallet=mine
rescanblockchain` reads the chain from the beginning, and `getwalletinfo`
reports a `scanning` object until it is finished. A node still syncing from
genesis, as a fresh install is, needs none of that: the blocks arrive with the
wallet already open.

This procedure is here because somebody reinstalled his operating system on
8 September 2026, restored his wallet with no instructions to follow, got it
right, and wrote down what he did. [MINE.md](MINE.md) carries the same steps
next to the backup command.

You will get something like `twam1q4syaj2akkysnsymxm8g85whanz23v3jn0jm6dd`.
That is yours. Anyone can send to it; only you can spend from it.

> **The one rule that matters.** The file `wallet.dat` inside the node's folder
> holds the keys to your money. Copy it somewhere safe. If you lose it, the
> coins are gone — there is no support line, no password reset, and no one who
> can help. That is the same freedom that means nobody can freeze your money,
> seen from the other side.

---

## 5. Mine

Mining is your computer competing to be the one that adds the next block to the
list. Whoever adds it is paid for the work: **50 WAM**, of which 47.5 goes to
the miners and 2.5 to the project treasury for the first 400,000 blocks.

A single computer wins rarely, so miners join a **pool**: everybody works
together and the reward is split by how much work each contributed. Small,
steady payments instead of a lottery.

### First, get the miner — it is a separate download

**The miner is not in the archive you already unpacked.** The node and the
miner ship as two files, and until 10 September this page told you to run
`./wam-miner` without ever telling you where to get it. Somebody mining under
WSL found that, after first trying `./wam-cli` inside the miner's folder and
being told there was no such file — which is the same confusion from the other
end.

| archive | what is in it |
|---|---|
| `wam-coin-v0.1.13-…` | `wamd`, `wam-cli` — the node |
| `wam-miner-v0.1.13-…` | `wam-miner` — the miner, and nothing else |
| `wam-qt-v0.1.11-…` | `wam-qt` — the wallet, with a window |

```bash
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-miner-v0.1.13-x86_64-linux-gnu.tar.gz
tar -xzf wam-miner-v0.1.13-x86_64-linux-gnu.tar.gz
cd wam-miner-v0.1.13
chmod +x wam-miner
```

`chmod` is there because a file unpacked onto a Windows drive — `/mnt/c/...`
under WSL — loses the executable bit, and `bash` then says `Permission
denied`, which reads as a broken download rather than a filesystem it passed
through.

### Point your miner at the pool

The address comes from step 4, and `wam-cli` lives in the *node* folder, not
this one — so run the two from their own directories.

```bash
./wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u YOUR_ADDRESS.rig1 -t 4
```

Replace `YOUR_ADDRESS` with the address from step 4. Keep the `.rig1` — it is
just a name for this machine, so you can tell your computers apart later.

**3333 is the port.** It has been the live pool since mainnet opened at
00:00 UTC on 15 September 2026. Before that the test pool used 13333, and
13333 answers nothing now — if you were mining there and it stopped, this is
why.

`-t 4` is how many processor cores to use. Leave one or two free if you want
the computer to stay usable.

### Which port

| Port | For | Meaning |
|---|---|---|
| **3333** | a laptop or desktop | start here |
| 3334 | a server | fewer, larger reports |
| 3335 | a farm of machines | |

If you are not sure, use 3333. The pool adjusts to your speed by itself.

### What you will see

```
stats    3.41 kH/s   accepted 20  rejected 0  blocks 1
```

- **kH/s** — thousands of guesses per second. Your speed.
- **accepted** — proofs of work the pool took. This number going up means it
  is working.
- **rejected** — should stay near zero. If it climbs, your clock may be wrong:
  `sudo timedatectl set-ntp true`.
- **blocks** — blocks your machine found. This will be zero for a long while
  and that is normal.

---

## 6. What to expect

| | |
|---|---|
| A new block every | about 2 minutes |
| Paid per block | 50 WAM (47.5 to miners) |
| Halves every | 200,000 blocks — roughly 15 months |
| Ever created, at most | 22,000,000 WAM |
| Rewards become spendable after | 100 blocks — about 3 hours |

That last row surprises people. A mining reward is frozen for 100 blocks before
it can be spent. Every coin that works this way does the same thing, for a
reason: it prevents money being spent out of a block that later turns out not
to belong on the list.

---

## 7. Two things you must know

**These are real coins.** Mainnet opened at 00:00 UTC on 15 September 2026
and everything above connects you to it. A block pays 50 WAM: 47.50 to whoever
found it, 2.50 to the treasury, by a rule every node checks.

**This project sets no price and runs no market.** What you mine may never be
worth anything. Mine because you want to hold the coin of a chain you can
verify yourself, not because you are expecting a market.

A test network still runs for people developing against it, and this page does
not cover it: until 19 September it taught the test chain and mentioned the
real one at the bottom, so readers made a `twam1` address, pointed it at the
live pool, and hashed for nothing.

---

## 8. When something goes wrong

**The node prints errors and stops.**
Read the last line before it stopped; it usually says exactly what it needs. If
it mentions an address already in use, another copy is already running.

**`getblockcount` says 0 and stays there.**
**For the first minute this is normal and means nothing is wrong.** The node
is building its RandomX verification tables and has not started on blocks yet;
`headers` in `getblockchaininfo` already reads the full chain height during
that time, and it is the field to watch: `verificationprogress` reads 1 on WAM at every height and tells you
nothing.

If it is still 0 after two or three minutes, your node found no one to talk
to. Check that your internet works — it retries by itself.

This entry used to name the second cause only, and sent a reader to check a
connection that was fine. Somebody left after three minutes and fifty-two
seconds on 7 September with a node that was working correctly.

**The miner says "cannot connect".**
Check the pool address for typing mistakes. Some networks block unusual ports;
try from a different connection.

**The miner runs but `accepted` stays at 0.**
Usually the wrong address format. It must start with `twam1` on the test
network — a mainnet address will be refused.

**Everything looks fine and I have never found a block.**
That is normal. One machine among many finds one rarely; that is what the pool
is for, and your share of what the pool finds is paid to your address anyway.

---

## 9. The numbers, for anyone who wants them

| | Mainnet | Testnet |
|---|---|---|
| Peer port | 9555 | 19555 |
| RPC port | 9554 | 19554 |
| Addresses start with | `W`, `w`, `wam1` | `T`, `t`, `twam1` |
| Genesis block | `d8d3debe…` | `ce81c20a…` |

Proof of work is RandomX over Bitcoin's 80-byte header. Everything else — the
transaction format, the script language, SegWit, PSBT — is Bitcoin Core v28.1,
because 250,000 lines that have been attacked for fifteen years are safer than
anything rewritten from scratch.

---

## Stay told about releases

Subscribe to releases on the repository:
**[gitlab.com/WAMCoin/wam-coin](https://gitlab.com/WAMCoin/wam-coin)**
→ **Watch ▾** → **Custom** → **Releases** ✓

This matters more than it sounds. WAM is pre-launch, and some releases change
a consensus rule — v0.1.5 moved the mainnet treasury address, and a node left
on v0.1.4 will reject every valid block on launch day and fork itself off the
network at height 1.

Your node does eventually notice. Core raises a warning once the chain it is
rejecting is about six blocks of work ahead — roughly twelve minutes, at
two-minute blocks — and says so:

```
Warning: We do not appear to fully agree with our peers!
You may need to upgrade, or other nodes may need to upgrade.
```

But that lives in the log and in `getnetworkinfo`, this release ships without
a graphical interface, and nobody watches a node that has been quietly working
for a week. A release notification arrives where you got the software, before
any of that happens.

You can also read it from the node itself at any time:

```
wam-cli getnetworkinfo | grep -A3 warnings
```

---

## Where to go next

- **[The whitepaper](../WHITEPAPER.md)** — why the money works the way it does
- **[Build it yourself](BUILD.md)** — compile from source rather than trusting
  a download
- **[Run a pool](POOL_OPERATOR.md)** — if you want to host one for others
- **[explorer.wamcoin.org](https://explorer.wamcoin.org)** — look at the chain
  without running anything

Questions: `wam.coin.official@proton.me`
