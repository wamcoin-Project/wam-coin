# Mine WAM

Nine lines, no explanation. If you want the explanation, read
[START_HERE.md](START_HERE.md).

This page exists because a tester on 5 September said his friends "want plain
jane, step by step, and shortest way to start mining", and he was right that
the guide is the wrong shape for that. It explains what a blockchain is,
which that reader either knows already or does not care about.

Linux, Windows, or a Mac with an Apple chip. About 2 GB of free memory.
Nothing else.

**Every command here is for the live chain.** Mainnet opened at 00:00 UTC on
15 September 2026 and these coins are real ones. This page taught the test
network until 19 September, with mainnet as an afterthought at the bottom --
so a reader who followed it from the top made a `twam1` address, pointed it
at the live pool, and hashed for nothing until he reached a paragraph
explaining why. The test network still exists for people developing against
it; it is not on this page, and it is not where you start.

The Linux commands are first because they are the ones strangers have been
running since August. [Windows](#windows) and [macOS](#macos) are below them
and both are new in v0.1.8 — including what each operating system will say
about the files when you first run them, which is explained there rather
than left to surprise you.

## Linux — nine lines

```
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-coin-v0.1.13-x86_64-linux-gnu.tar.gz
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-miner-v0.1.13-x86_64-linux-gnu.tar.gz
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl -LO https://wamcoin.org/verify_release.sh
curl -LO https://wamcoin.org/SIGNING-KEY.asc
bash verify_release.sh .
tar -xzf wam-coin-v0.1.13-x86_64-linux-gnu.tar.gz && tar -xzf wam-miner-v0.1.13-x86_64-linux-gnu.tar.gz
cd wam-coin-v0.1.13/bin
./wamd -daemon
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
> directory an hour later, and deleted the only copy. It cost him nothing then,
> because the chain he was on was a test one. There is money in the file now.

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

**Do not use `scripts/gen_founder_key.py` for a mining address.** It is in
the repository and it produces a valid address, so people find it and use it
— one miner did on launch night, and his address found a block. It is an
air-gapped ceremony tool: it prints a private key once, stores it nowhere,
and expects you to write it on paper. No wallet holds that key, so there is
no seed phrase, no backup file, and nothing for `backupwallet` to copy. Lose
the paper and everything mined to it is gone, with no error at any point
until the day you try to spend. The commands above are what you want.

Nothing is lost either way — `createwallet` writes a file and deleting
`blocks`, `chainstate` or `peers.dat` does not touch it. This was found on
6 September by somebody following this page, restarting his node three times,
and being told his wallet did not exist.

The last command prints your address; it starts with `wam1`. Then you choose
one of two ways to mine, and the first is the better one:

**Alone, against your own node.** Nothing between you and the chain, no
operator to trust, and the whole 47.5 WAM when you find a block:

```
./wam-miner --solo -u YOUR_ADDRESS -t 4
```

That needs the node you just started to be running, with `server=1` in
`wam.conf`. [Mining alone](#mining-alone-which-works-here) has the detail,
including `--check`, which asks your node whether your block would be valid
before you spend a second hashing.

**In a pool**, if you would rather be paid a little every few hours than the
whole reward rarely:

```
./wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u YOUR_ADDRESS -t 4
```

There is more than one pool. [Which pool](#which-pool) lists them. Each one
states its own fee and its own payout rules on its own page, ours included —
they are settings an operator can change, so this page does not carry numbers
it has no way of keeping true.

**COPY the address, do not retype it.** The checksum catches a single wrong
character, which is what it is for. If your miner's log says "bech32 checksum
failed" or "invalid address", the pool has refused it and you are hashing for
nothing until you fix it.

An address beginning `twam1` is a **test** address and will be refused. If you
have one, you followed an older version of this page or a testnet guide: make
a new address with the commands above. The pool is 3333-3336; 13333 was the
test pool before 15 September and answers nothing now.

`-t 4` is how many processor cores to use. Without it the miner takes every
core but one, which makes the rest of the machine unpleasant to use.

## Windows

Since v0.1.8 there are Windows binaries, node and miner, and they need no WSL
and no Linux. Open PowerShell and work in a folder you choose:

```
mkdir C:\wam ; cd C:\wam
curl.exe -LO https://wamcoin.org/downloads/v0.1.13/wam-coin-v0.1.13-x86_64-w64-mingw32.zip
curl.exe -LO https://wamcoin.org/downloads/v0.1.13/wam-miner-v0.1.13-x86_64-w64-mingw32.zip
curl.exe -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS
Expand-Archive wam-coin-v0.1.13-x86_64-w64-mingw32.zip -DestinationPath .
Expand-Archive wam-miner-v0.1.13-x86_64-w64-mingw32.zip -DestinationPath .
```

**Check it before you run it.** One command, and it is the only step here that
cannot be checked afterwards:

```
curl.exe -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl.exe -LO https://wamcoin.org/SIGNING-KEY.asc
curl.exe -LO https://wamcoin.org/verify_release.ps1
powershell -ExecutionPolicy Bypass -File verify_release.ps1
```

It should end with `this is the WAM release, unmodified since it was signed`.
Anything else, and it will say what is wrong and tell you not to run the
files.

This page used to tell you to run `certutil -hashfile` and compare
sixty-four hexadecimal characters against `SHA256SUMS` by eye. Nobody does
that: people check the first four characters and the last four, which is the
check an attacker would design for. The script compares every one of them,
and then does the part `certutil` cannot — it verifies that `SHA256SUMS`
itself is ours, by the fingerprint published in
[SECURITY.md](../SECURITY.md).

That last part needs GnuPG, which Windows does not ship. If you have
[Git for Windows](https://gitforwindows.org/) you already have one and the
script finds it; otherwise install [Gpg4win](https://gpg4win.org/). Without
it the script checks the hashes, tells you the signature was **not** checked,
and exits without saying the release is good — because a matching hash
against an unsigned list proves your download is not corrupt and proves
nothing about who wrote the list.

Then the node, with the directory named explicitly so you always know where
the wallet is:

```
cd wam-coin-v0.1.13\bin
.\wamd.exe -datadir=C:\wam\data
.\wam-cli.exe -datadir=C:\wam\data createwallet "mine"
.\wam-cli.exe -datadir=C:\wam\data -rpcwallet=mine backupwallet C:\wam\wallet-backup.dat
.\wam-cli.exe -datadir=C:\wam\data -rpcwallet=mine getnewaddress
```

**Two things Windows does differently, and both were wrong in this guide
until 2026-09-14 — a reader following it hit them before we did.**

**`-daemon` does not exist on Windows.** The node answers
`Error: -daemon is not supported on this operating system` and exits. So
`wamd.exe` runs in the window you started it in: leave that window open and
open a **second** PowerShell for the `wam-cli.exe` commands. If you would
rather it stayed out of the way:

```powershell
Start-Process -FilePath .\wamd.exe `
  -ArgumentList '-datadir=C:\wam\data' -WindowStyle Minimized
```

**`curl` in PowerShell is not curl.** It is an alias for
`Invoke-WebRequest`, which does not understand `-LO` and fails. The real
program is `C:\WINDOWS\system32\curl.exe`, which is why every download
above says `curl.exe` rather than `curl`.

### Moving from the terminal node to the graphical wallet

`wam-qt` is the same node with a window on it, so it replaces `wamd` rather
than running beside it. Three things stop people on the way across, and all
three were walked through with a miner on 16 October 2026 — every one of them
cost a step that nothing on this page had warned about.

**1. The wallet does not open the RPC port, and `wamd` does.** `bitcoind.cpp`
says it in a comment: *-server defaults to true for bitcoind but not for the
GUI*. So the moment you switch, your solo miner stops — and nothing explains
why, because from the wallet's side everything is working. Put this in your
`wam.conf`, in the data directory, before you start:

```
server=1
```

**2. If you installed before v0.1.10 on Windows or macOS, your chain and your
wallet are in a folder called `Bitcoin`.** Until v0.1.10 the rename that gave
Linux `~/.wam` changed one branch of `GetDefaultDataDir` and left the other
two alone. The new default is `WAM`, so a wallet started without `-datadir`
opens an empty directory and a wallet that is perfectly safe looks lost.

Stop the node first — `wam-cli.exe stop`, and wait for the window to close,
because copying a chain mid-write produces a copy that is not a chain — then:

```
robocopy %LOCALAPPDATA%\Bitcoin %LOCALAPPDATA%\WAM /E /R:1 /W:1
```

It ends with exit code 1, which means *files were copied*. Failure starts at
8. Nothing is deleted: the old folder stays as a third copy of your keys.

The node does warn about this by itself, but only when the old folder
contains a `wam.conf` — and a node that has always been started with
command-line flags has never written one. The warning did not fire for the
one person it was written for, which is why it is on this page as well.

**3. Pressing *Receive* shows a new address every time, and that is not a new
wallet.** One wallet holds thousands of addresses, all derived from one seed,
and a fresh one per payment is the point rather than an accident. Your mining
address is untouched and still yours — the dialog that shows the new address
names the wallet it came from, and it is the same one. Do not change what the
miner is pointed at.

A complete move, in order, with nothing left out:

```
wam-cli.exe listwallets                     # which wallet is open
wam-cli.exe -rpcwallet=NAME backupwallet C:\wam-backup.dat
wam-cli.exe stop                            # and wait for the window to close
robocopy %LOCALAPPDATA%\Bitcoin %LOCALAPPDATA%\WAM /E /R:1 /W:1
echo server=1> %LOCALAPPDATA%\WAM\wam.conf
```

Then start `wam-qt.exe`. It opens with no wallet loaded, because the node it
replaces had none loaded either; **File → Open Wallet → your wallet**, and do
not take the *Create a new wallet* button that is offered beside it. Then the
miner, unchanged except for the one word in its cookie path:

```
wam-miner.exe --solo -u YOUR_ADDRESS -t 4 --rpccookie "%LOCALAPPDATA%\WAM\.cookie"
```

and the miner, from the folder it unpacked into. Alone against your own node,
which is the better way — it needs `server=1` in `wam.conf` and the node
running:

```
.\wam-miner.exe --solo -u YOUR_ADDRESS -t 4
```

or in a pool, if you would rather be paid a little often than a lot rarely:

```
.\wam-miner.exe -o stratum+tcp://pool.wamcoin.org:3333 -u YOUR_ADDRESS -t 4
```

[Mining alone](#mining-alone-which-works-here) and
[which pool](#which-pool) are below.

### Windows will call the miner a virus, and it is wrong

This is the part nobody tells you, so it is written here before it happens to
you. On 12 September, the first time the Windows miner was run on a real
desktop, it passed every self-test, connected to the pool, took a job, and
started hashing. Fourteen seconds later Windows Defender killed the process
and deleted the file:

```
Trojan:Win32/Bearfoos.A!ml        Severity: Severe
```

`!ml` means a machine-learning guess, and `Bearfoos.A` is a generic label. The
reason is not subtle: a program that opens a network connection and then uses
every processor core is behaving exactly like the cryptojacking malware that
does this to people without asking. No scanner can tell them apart by
behaviour, because the behaviour is identical. The difference is consent — you
chose to run it, and it mines to the address on its own command line and
nowhere else.

The thing that removes the warning is a publisher certificate, which costs
money and a registered company, and this project has neither yet. So:

1. **Verify the file instead of trusting a verdict.** The SHA256 above and the
   signature on `SHA256SUMS` are evidence that these are the bytes we built.
   An antivirus verdict is an opinion about behaviour.
2. **If you want to mine, allow that one file**, by name — Windows Security →
   Virus & threat protection → Manage settings → Exclusions → Add → File, and
   pick `wam-miner.exe`. Not a folder. Not the whole machine. Turning your
   antivirus off to run a stranger's program is how people actually get
   robbed, and anyone telling you to do that is not us.
3. **Or do not mine, and run the node anyway.** `wamd.exe` is not a miner and
   is not normally flagged. A node that relays blocks and holds a wallet is a
   real contribution and costs you no CPU.

The node's own first run may show a blue SmartScreen box saying "Windows
protected your PC" — that is the unsigned-publisher notice, not a virus
report. `More info` → `Run anyway`, once you have checked the hash.

## macOS

Apple Silicon only — an M1, M2, M3 or M4. An Intel Mac cannot run these and
has to build its own; [BUILD.md §9](BUILD.md#9-building-on-macos) is twenty
minutes.

**And one thing you should know before you start, because we would want to
know it.** These binaries are built on an Apple machine — a macOS runner —
and on that machine they sync this chain from its genesis block before the
archive is allowed to be published. What has **not** happened is a person
sitting at a Mac they own, opening them, and using the wallet. Nobody on
this project owns a Mac.

So if you are that person: tell us what happened, whether it worked or not.
The security contact is in `SECURITY.md`, and the channels are on the
website. A first report from a platform we do not own is worth more to us
than anything we can measure ourselves.

```
mkdir -p ~/wam && cd ~/wam
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-coin-v0.1.13-arm64-apple-darwin.tar.gz
curl -LO https://wamcoin.org/downloads/v0.1.13/wam-miner-v0.1.13-arm64-apple-darwin.tar.gz
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl -LO https://wamcoin.org/SIGNING-KEY.asc
curl -LO https://wamcoin.org/verify_release.sh
bash verify_release.sh .
```

`verify_release.sh` needs GnuPG, which macOS does not ship: `brew install
gnupg` first, or the script will tell you the signature was **not** checked
and exit without calling the release good. It should end with `this is the
WAM release, unmodified since it was signed`.

Then:

```
tar -xzf wam-coin-v0.1.13-arm64-apple-darwin.tar.gz
tar -xzf wam-miner-v0.1.13-arm64-apple-darwin.tar.gz
cd wam-coin-v0.1.13/bin
./wamd -datadir=$HOME/wam/data -daemon
./wam-cli -datadir=$HOME/wam/data createwallet "mine"
./wam-cli -datadir=$HOME/wam/data -rpcwallet=mine backupwallet $HOME/wam/wallet-backup.dat
./wam-cli -datadir=$HOME/wam/data -rpcwallet=mine getnewaddress
```

and the miner, from where it unpacked. Alone against your own node, which is
the better way — it needs `server=1` in `wam.conf` and the node running:

```
./wam-miner --solo -u YOUR_ADDRESS -t 4
```

or in a pool, if you would rather be paid a little often than a lot rarely:

```
./wam-miner -o stratum+tcp://pool.wamcoin.org:3333 -u YOUR_ADDRESS -t 4
```

[Mining alone](#mining-alone-which-works-here) and
[which pool](#which-pool) are below.

### macOS will refuse to run them the first time

Not a virus warning and not the same thing Windows does. You will see

```
"wamd" cannot be opened because the developer cannot be verified.
```

or, from the terminal, `killed: 9`. These binaries are not **notarised** —
Apple's process where a developer uploads each build to Apple, pays for a
developer account, and receives a stapled approval. This project has no such
account, so nothing here is stapled, and macOS treats an unstapled binary
downloaded from the internet as untrusted by default.

The honest position is the same as on Windows: we cannot remove that message,
so we tell you about it. What to do, once you have run `verify_release.sh`
and seen it pass:

```
xattr -d com.apple.quarantine ./wamd ./wam-cli ./wam-miner
```

That removes the *downloaded-from-the-internet* mark from those three files
and nothing else. It is not "disable Gatekeeper", it is not `sudo`, and it
does not change a system setting. Do it only for files whose signature you
have just checked, and never because a stranger told you to.

## The one line that is not optional

```
curl -LO https://wamcoin.org/downloads/v0.1.13/SHA256SUMS.asc
curl -LO https://wamcoin.org/verify_release.sh
curl -LO https://wamcoin.org/SIGNING-KEY.asc
bash verify_release.sh .
```

It should print `OK`. It costs a second, and it is the whole difference
between running our file and running whatever arrived instead. Every other
step here can be skipped and retried later; this one cannot be checked
afterwards.

## What you are mining

Real coins on the live chain. Mainnet opened at 00:00 UTC on 15 September
2026. A block pays 50 WAM: 47.50 to whoever found it and 2.50 to the
treasury, by a consensus rule every node checks. This project sets no price
and runs no market, and what you mine may never be worth anything. Mine
because you want to hold the coin of a chain you can verify, not because you
expect a market.

Coins from a block cannot be spent for 100 blocks, about three hours. That is
consensus, not the pool.

## Which pool

There is more than one, and they are not run by us:

```
pool.wamcoin.org:3333             run by this project
stratum.cryptopickaxe.co.uk:6040
wampool.vslabs.co.in:3333
veinpool.fr:3310                  and :3311 for servers, a higher start
```

Ask their operators about their fees and their payout rules — those are
theirs to state, not ours to state for them. A check in this repository
dials every address on this page on every sweep, so if one stops answering
we find out rather than hearing it from a miner. If one does not answer for
you, try another.

**One is not answering, and it is listed here anyway so that nobody wonders
where it went.**

<!-- wam:quote-begin -->
    wam.ariabrain.com:3333
<!-- wam:quote-end -->

On 2026-10-08 it refused the connection, measured from this laptop and from
all three seeds, in three countries, so it was not a block on one address.
On 2026-10-18 it had become worse: the name does not resolve at all. Its
website is up and the pool is still listed there, which is why nobody
noticed — the page a reader sees is not the port a miner dials.

It is out of the block above rather than deleted from the page. The pool is
its operator's to run and the page is ours, and a stranger following our
instructions should not meet a dead address first. If it answers again it
goes back up, and that is the operator's call to tell us rather than ours to
keep testing forever.

**Ours charges what the others charge, on purpose.** It ran free while it was
the only pool in existence, and a pool charging nothing is not competing with
the others — nobody can offer less than nothing. Matching their rate means
you pick a pool for how it runs rather than for a number that cannot be
beaten. Whatever the rate is, it is taken after the chain's 5% treasury
output and swept to an address that receives nothing else, so what stays in
the pool wallet is miners' money.

**The rate itself is on <https://pool.wamcoin.org>, not here.** It is in the
header and in the reward split, beside the address it is swept to, and in
`/api/stats` under `config` — all three read out of the configuration the
pool is actually running. That page is also where the rest of the payout
policy is: the PPLNS window, the payout threshold, how often payments run,
and how long a block matures before any of it reaches you. Those are
settings, not consensus rules, and a number for any of them written here is a
number nothing keeps in step. The fee was carried at two different values in
two files for weeks — this page said one thing and `pool/config.mainnet.json`
said another — and the only reason anybody found out was that somebody went
looking. The pool always knew. Ask it.

## Mining alone, which works here

Most guides tell you to join a pool and stop there. At this network size you
do not have to, and the chain is better if some of you do not.

A pool smooths your income: you are paid for the work you submit, a little at
a time, whether or not your own machine finds anything. Alone, you are paid
nothing until you find a block and then the whole 47.50 at once.

How long that takes is arithmetic. If your machine is 1% of the network hash
rate and a block comes every two minutes, you find one about every three
hours. Measured on 2026-09-20 over the last 720 blocks, the network was near
328 kH/s -- over the last 120 it was 185 kH/s, so it moves with the hour:

| your machine | share | a block about every |
|---|---|---|
| 2,900 H/s (a typical laptop) | 0.9% | 4 hours |
| 3,900 H/s | 1.2% | 3 hours |
| 6,000 H/s | 1.8% | 2 hours |

Read the live figures yourself at explorer.wamcoin.org rather than trusting
this table, because the network moves and the table does not.

**And it helps the chain more than joining us does.** Every solo miner is a
separate finder; everybody in one pool is one finder, however many people are
behind it. That is not an argument in our favour, and it is written here
anyway.

### How, exactly

> **Use v0.1.11 or newer.** `--solo` and `--check` first appeared in v0.1.10,
> and the miner in that version could fail to SEND a block it had already
> solved — roughly two in three were lost. It was reported by a miner on
> 2026-09-26, found the same morning, and fixed in v0.1.11, which has been
> published since 2026-09-27. Mining alone on v0.1.10 still loses blocks;
> mining alone on v0.1.11 does not.
>
<!-- wam:quote-begin -->
> This paragraph said "the fix needs v0.1.11 to reach you, and until that is
> published, mining alone will lose blocks" for nine days after v0.1.11 was
> published — so this page spent those nine days telling people not to mine
> alone, which is the opposite of what it is for.
<!-- wam:quote-end -->

> **If you see "do not leave it running", read this first.**
>
> A line that looks like an emergency usually is not one:
>
>     1 block(s) found have NOT been accepted: 0 not sent, 1 refused by the
>     node. That is real money; do not leave it running.
>
> **If `not sent` is 0, nothing was lost.** Another miner reached that height
> a second before you did, the node took his block, and yours became a side
> branch. That is ordinary proof of work, and it happens to everybody with
> enough hash rate to win sometimes.
>
> The counts are cumulative for as long as the program runs, so one lost race
> an hour ago repeats that line every thirty seconds for ever. Restarting the
> miner clears it and costs nothing: the blocks you were paid for are on the
> chain, not in the counter.
>
> **Do not stop mining over it.** Stopping recovers nothing and loses every
> block you would have found afterwards. The line is wrong and it is ours: the
> miner counts a lost race and a block it could not send in the same warning,
> so the warning itself cannot tell you which one happened. The two numbers
> can, and `not sent` is the one to read.
>
> `not sent` above zero is the other case, and that one is worth stopping for:
> it means a block your machine solved never reached the node at all.

You need two things running: your own node, and the miner pointed at it.

**One.** Your node must be running, synced, and answering. Add one line to
`wam.conf` if it is not there already:

```
server=1
```

and restart the node. Nothing else -- no user, no password, no pool, no
Redis. The miner reads the same cookie file `wam-cli` reads.

**Two.** Ask whether it would work, before mining anything:

```
wam-miner --check -u YOUR_ADDRESS
```

That builds a real block from your node's current template and asks the node
whether it is valid. It hashes nothing and sends nothing, and it answers in
about a second. If it says the node accepts the block, everything except the
proof of work is correct: the coinbase, the treasury output, the witness
commitment, the merkle root and the transactions.

**Three.** Mine:

```
wam-miner --solo -u YOUR_ADDRESS -t 4
```

On Windows it is `wam-miner.exe`, and the rest is identical. `-t` is the
number of threads; leave it out and the miner keeps one core free so the
machine stays usable.

If your node is on another machine, or its data directory is not the default
one, say so:

```
wam-miner --solo -u YOUR_ADDRESS -t 4 --rpc 192.168.1.10:9554 --rpcuser USER --rpcpassword PASSWORD
```

**What it does.** It asks your node what to build, builds the block itself --
coinbase, treasury output, witness commitment, merkle root -- hashes it, and
hands it back to your node when it wins. The 47.50 is paid to the address you
passed, by your own block, with nobody in between. There are no shares and no
payouts because there is nobody to pay you: either you find a block or you do
not.

**Where your coins go.** Into the address you passed on the command line, and
nowhere else. Check it with `--check` before you start: if you paste an
address from another chain, or one character wrong, the miner refuses by name
rather than mining for hours into nothing.

**A found block is immature for 100 blocks** -- about three hours -- before
you can spend it. That is a consensus rule, not a delay we added, and it is
the same rule for our pool.

That is also what the miner in our Discord meant by "I'm running the pool
locally". He was doing it the hard way, before this existed.

## When it does not work

**`incorrect password attempt` in the log.** There is no password. The node
writes `<datadir>/.cookie` at startup and clients read it, so `wam-cli` needs
the same `-datadir=` as the daemon. A leftover `wam.conf` carrying
`rpcuser`/`rpcpassword` fights the cookie; delete those two lines.

**`accepted` stays at 0.** Usually the wrong address format — it must start
with `wam1`. An address beginning `twam1` belongs to the test chain and the
pool refuses it.

**No block ever found.** Normal. One machine among many finds one rarely,
which is what the pool is for; your share of what the pool finds is paid to
your address anyway.


## Your balance will say zero, and that is normal

Two things stand between your machine working and a number appearing in your
wallet, and the first of them is a consensus rule rather than anything a pool
decided.

**A block's reward cannot be spent for 100 confirmations.** That is coinbase
maturity, it lives in the chain and not in the pool, and it binds a solo
miner exactly as hard. The pool works out your share of a block the moment it
finds one, but holds that share against the block until it matures — so your
unpaid balance lags the work that earned it by about three and a half hours,
and then moves in steps rather than smoothly. The maturity queue is on the
pool page, counted beside the blocks found.

**Then there is a payout threshold and a payment round.** Both are settings,
so both are on the pool's own page rather than on this one. Below the
threshold your earnings sit in the pool's ledger and not in your wallet, so

```
./wam-cli -rpcwallet=mine getbalance
0.00000000
```

is what you will see for the first while, however hard the machine is
working. Nothing is missing and more threads is not the fix — it only raises
your share of each block the pool finds.

Watch the ledger instead of the wallet:

    https://pool.wamcoin.org
    https://pool.wamcoin.org/api/miner?address=YOUR_ADDRESS

And if you change your payout address, your share history starts again from
nothing. Whatever the old address had earned stays owed to that address.

Written down on 6 September, after somebody mined for an hour, read
`0.00000000`, and reasonably concluded something was broken.


### And `getbalance` will DROP when you send to yourself

Send one coin from your own wallet to another address in the same wallet and
the balance goes down, not sideways. Nothing was lost. `getbalance` reports
only what is confirmed and spendable, and your change output is sitting in
the mempool until a block carries it.

`getbalance` is one number. `getbalances` is the truth:

```
./wam-cli -rpcwallet=mine getbalances
{
  "mine": {
    "trusted": 6.99973355,            confirmed, spendable now
    "untrusted_pending": 11.15475873, sent or received, not yet in a block
    "immature": 0.00000000            mined, waiting out the 100 blocks
  }
}
```

Use `getbalances` whenever a number surprises you. The three add up; one of
them alone never does.

Written down on 6 September because a miner sent a coin to himself, watched
the balance fall, and another miner — walkjivefly — explained it in the
channel before this project did.

## Back up the wallet

```
./wam-cli -rpcwallet=mine backupwallet /path/you/choose/backup.dat
```

It prints nothing on success. Check the file exists and has a size — that is
the whole confirmation.

The live wallet is at `~/.wam/wallets/mine/wallet.dat`, and
`listdescriptors true` prints the same keys in portable form. Treat that
output like cash: never paste it anywhere, including to us.

## Restore it

A backup nobody has ever restored is a file you hope about. This page told you
how to make one in three separate places and never once said how to use one,
which was found on 8 September 2026 by the first person outside this project
to actually do it — onto a machine whose operating system he had reinstalled
that morning. These are his steps, not ours.

```
mkdir -p ~/.wam/wallets/mine
cp /path/to/your/backup.dat ~/.wam/wallets/mine/wallet.dat
./wam-cli loadwallet "mine"
./wam-cli -rpcwallet=mine getbalance
```

**The rename is the part that catches people.** Your backup may be called
anything you like, but the file inside the folder must be called `wallet.dat`,
and the folder must be named after the wallet you then pass to `loadwallet`.
Neither is guessable, and getting either wrong gives you an error about a
wallet that does not exist rather than one about a file that is misnamed.

His balance was simply there, with no rescan, because that node was syncing
from genesis: the blocks holding his coins arrived while the wallet was
already open. A node that finished syncing weeks ago is the other case, and
if the balance reads zero when you know it should not, ask the node to look
again:

```
./wam-cli -rpcwallet=mine rescanblockchain
```

It reads the chain from the beginning and takes as long as it takes.
`getwalletinfo` reports a `scanning` object while that is happening and
`false` when it is done, so you are never left guessing whether it is still
working.

---

[discord](https://discord.gg/Gxvmrjy9Qb) ·
[explorer](https://explorer.wamcoin.org) ·
[pool](https://pool.wamcoin.org)
