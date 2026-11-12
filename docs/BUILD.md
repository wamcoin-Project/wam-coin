# Building WAM Coin from source

`./install.sh` does everything below automatically on Ubuntu 22.04 and 24.04. This document is for
other distributions, for CI, and for anyone who wants to know what the installer is doing.

---

## 1. Dependencies

### Ubuntu 22.04 / 24.04 / Debian 12

```bash
sudo apt-get install -y \
    build-essential libtool autotools-dev automake pkg-config bsdmainutils \
    cmake curl git python3 \
    libevent-dev libboost-dev libsqlite3-dev
```

### Fedora / RHEL 9

```bash
sudo dnf install -y \
    gcc-c++ libtool make autoconf automake cmake git python3 \
    libevent-devel boost-devel sqlite-devel
```

### Arch

```bash
sudo pacman -S base-devel cmake git python libevent boost sqlite
```

> **OpenSSL and ZMQ came off all three lists on 7 September.** OpenSSL because
> Bitcoin Core v28 does not use it at all. ZMQ because the build disables it —
> and that one was worse than clutter: with the development package installed,
> `configure` finds ZMQ and links it unless `--disable-zmq` is passed, and §4
> did not say to pass it. Measured on somebody's Fedora build with the old
> line: four extra shared libraries, libzmq and three of Kerberos. Rebuilt
> with the corrected line, none.
>
> Fedora's list was corrected first and Ubuntu's and Arch's were left carrying
> the same fault for an hour — repairing the instance in front of you instead
> of every instance, which is the mistake this project keeps making and the
> reason so many checks here enumerate rather than name.

For the pool, additionally: **Node.js ≥ 18** and **Redis**.

Then run the installer with `--skip-deps`.

---

## 2. Verify before you compile

There is no point building a binary whose arithmetic does not hold:

```bash
python3 scripts/verify_supply.py            # the 22,000,000 cap
python3 scripts/gen_founder_key.py --selftest   # address prefix table
python3 genesis/test_serialization.py       # genesis serializer vs. Bitcoin's real genesis
```

All three must pass. `install.sh` runs them before invoking the compiler.

---

## 3. Fetch upstream and apply the WAM changes

```bash
./scripts/fetch-upstream.sh
```

This:

1. clones **tevador/RandomX v1.2.1** into `build/randomx` and builds `librandomx.a`,
2. clones **bitcoin/bitcoin v28.1** (shallow) into `build/wam-core`,
3. runs `scripts/patch_upstream.py`, which applies nine anchored transformations,
4. writes `build/wam-core/.wam-patched` recording the exact upstream commit.

The upstream tag is **pinned**. Never track a branch — a consensus layer that changes
underneath you between two builds is not a consensus layer.

To see exactly what will be changed before anything is written:

```bash
python3 scripts/patch_upstream.py --list
python3 scripts/patch_upstream.py --tree build/wam-core --repo . --check
```

### If the patcher aborts

You will see something like:

```
src/validation.cpp: anchor for 'delegate the subsidy to wam::GetBlockSubsidy' not found.
```

This means upstream moved the code. **Do not loosen the anchor to make it apply.** Open the
current source, confirm the change still belongs where you think it does, and update the
anchor in `scripts/patch_upstream.py`. A consensus edit landing in the wrong function is
exactly the failure mode this design exists to prevent.

The patcher is idempotent and aborts before writing anything on the first problem, so a
failed run leaves the tree usable.

---

## 4. Compile

```bash
cd build/wam-core
./autogen.sh
./configure --without-gui \
    --disable-zmq \
    --disable-tests-fuzz-binary \
    CPPFLAGS="-I$PWD/../randomx/src" \
    LIBS="$PWD/../randomx/build/librandomx.a -lpthread"
make -j"$(nproc)"
```

**`--disable-zmq` is not a size optimisation, and leaving it out is how this
page was wrong until 7 September.** ZMQ is a notification interface nothing in
this project uses — no reference in `src/wam`, the pool, the explorer or the
bot — and linking it drags in twelve shared libraries, including the whole of
Kerberos, that whoever runs the binary must then already have. A node built
with it, copied to a clean machine, dies with

```
error while loading shared libraries: libevent_pthreads-2.1.so.7
```

which no user can read as "install one package". `install.sh` has passed the
flag since August; this page did not, so anybody following it got a heavier
binary than the release — and on a distribution whose package list here
installed `zeromq-devel`, configure found ZMQ and linked it without a word.

That last sentence is measured, not predicted. On 7 September somebody
followed this page on Fedora 44 with the old line, and his binary was asked
what it links:

    ldd build/wam-core/src/wamd | grep -cE 'zmq|krb5|gssapi'
    4

libzmq and three Kerberos libraries, none of which the release depends on. It
built with no errors and runs perfectly on his machine, because Fedora has
them — which is the whole failure mode: it works for whoever built it and dies
for whoever receives it.

Expect 10–40 minutes. Peak memory is roughly 1.5 GB per compile job — on a machine with
4 GB, use `make -j2` rather than `-j$(nproc)`.

---

## 5. Test

```bash
./src/test/test_bitcoin --run_test='wam_*'
```

`wam_monetary_tests` covers the emission schedule, epoch boundaries, the hard cap, and the
subsidy/treasury split across all 33 epochs.

`wam_devfee_tests` covers consensus rule WAM-1, including the cases that matter: omitting
the treasury output, underpaying it by a single base unit, and paying the correct amount to
the *wrong* script.

`wam_vesting_tests` puts the founder reserve's time locks to the script interpreter: before
each unlock date the spend fails with `SCRIPT_ERR_UNSATISFIED_LOCKTIME`, on the date it
succeeds, and the two known ways to defeat CLTV — a final input sequence, and mixing
height-based with time-based locktimes — are both rejected.

Use `wam_*`, not a list of suite names. The build and install gates do, and a suite added
later is then run without anyone remembering to edit four files.

The full upstream suite is also worth running once:

```bash
make check
```

---

## 6. Install

```bash
sudo make install
sudo ln -sf /usr/local/bin/bitcoind    /usr/local/bin/wamd
sudo ln -sf /usr/local/bin/bitcoin-cli /usr/local/bin/wam-cli
```

---

## 7. Build the pool's native addon

```bash
cd pool
npm install
cd native
RANDOMX_INCLUDE="$PWD/../../build/randomx/src" \
RANDOMX_LIB="$PWD/../../build/randomx/build/librandomx.a" \
    npx node-gyp rebuild
```

There is deliberately **no pure-JavaScript fallback**. A pool that silently degraded to a
fake hash function would accept every share and pay out on work nobody did.

---

## 8. Building for Windows

There is no `.exe` in any release yet. This is how one is made, and anybody
who runs it is doing something useful: a Windows binary this project has not
verified on a second machine is a binary verified on one.

**Ubuntu 24.04, not 22.04.** 22.04 ships mingw with GCC 10.3, Bitcoin Core v28
requires C++20, and upstream's own `doc/dependencies.md` puts the floor at GCC
11.1. On 22.04 the build spends forty minutes cross-compiling boost, bdb,
libevent and sqlite and *then* configure refuses. `scripts/build_windows.sh`
checks the compiler in its first second so that cannot happen again.

On Windows, WSL is enough — in PowerShell as administrator:

```
wsl --install -d Ubuntu-24.04
```

Then inside it:

```bash
sudo apt update && sudo apt install -y build-essential libtool autotools-dev   automake pkg-config bsdmainutils cmake curl git python3 file   g++-mingw-w64-x86-64-posix
sudo update-alternatives --set x86_64-w64-mingw32-g++ /usr/bin/x86_64-w64-mingw32-g++-posix
sudo update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix

git clone https://gitlab.com/WAMCoin/wam-coin.git ~/wam-coin
cd ~/wam-coin
bash scripts/fetch-upstream.sh
bash scripts/build_windows.sh
```

The `-posix` package is not a preference. The win32-threads runtime has no
`std::thread` at all and Core uses it everywhere, so the wrong alternative
produces several hundred lines of `'thread' is not a member of 'std'`, which
reads like a broken source tree and is a one-line toolchain setting.

About forty minutes, most of it boost. Five executables land in
`out/windows/`, unstripped and large; `x86_64-w64-mingw32-strip` takes `wamd`
from 418 MB to 15 MB.

### Then prove it agrees with the chain

Compiling proves the toolchain. It does not prove the binary computes the same
proof-of-work or enforces the same rules, and a node that gets either wrong
does not fail loudly — it forks itself off and its owner mines onto a history
nobody else has. Copy the two binaries to the Windows side and, from Git Bash
**on Windows**:

```bash
bash scripts/test/test_platform_consensus.sh /c/where-you-put-them
```

It syncs the test chain from genesis over the real peer-to-peer protocol and
then compares four blocks the Linux nodes have held since August: genesis,
block 1 where the treasury rule is first enforced, 5000 and 6000. Anything
other than four matches is a finding, and it matters more than a pass.

It picks its own RPC port, because the default is not free on a machine that
already runs a node — which is every machine anybody would test a build on.

---

## 9. Building on macOS

There is no `.dmg` either. This one is a native build, not a cross-compile, so
it must run on the Mac itself — `scripts/build_macos.sh` checks `uname -s` and
stops immediately anywhere else rather than failing forty minutes later.

Xcode's command line tools, and five things from Homebrew:

```bash
xcode-select --install
brew install cmake autoconf automake libtool pkg-config

git clone https://gitlab.com/WAMCoin/wam-coin.git ~/wam-coin
cd ~/wam-coin
bash scripts/fetch-upstream.sh
bash scripts/build_macos.sh
```

**Boost, libevent and sqlite deliberately do not come from Homebrew.** The
first version of this used them and it failed: Homebrew installs the *newest*
boost, and Bitcoin Core v28 does not build against it. Worse than failing, it
would have made the result depend on whatever Homebrew shipped that week, so
two people building the same commit on the same day could get different
binaries. They come from `depends/`, which is upstream's own answer and
already how the Windows build here works:

```
make -C depends HOST=$(uname -m)-apple-darwin NO_QT=1 NO_ZMQ=1 NO_UPNP=1 NO_NATPMP=1 NO_USDT=1
```

The script does this for you. No SDK question arises — `depends/README.md`
lists the macOS SDK under *cross*-compiling, and this is not that.

On an Intel Mac RandomX is configured with `-DARCH=x86-64`; on Apple Silicon
that flag is not passed at all. It must never be `native`, on any platform:
a binary tuned to the machine that built it computes proof-of-work that
machine agrees with and can disagree with everyone else's.

About twenty minutes on Apple Silicon — CI measured 739 seconds for the build
and 279 more to sync the test chain. The binaries land in
`out/macos-$(uname -m)/`, and each is checked with `file -bL` to be genuinely
Mach-O before it is kept.

**Two test suites run before anything is kept**, and a failure in either
deletes nothing but refuses to leave you a binary: RandomX's own reference
vectors, then every `wam_*` suite — monetary, devfee and vesting. The
monetary schedule, the 5% treasury rule and the vesting locks are precisely
what a different compiler on a different architecture could get quietly
wrong, and a node that gets any of them wrong does not crash — it forks
itself off at block 1.

Then the same proof the Windows section ends with, and for the same reason:

```bash
bash scripts/test/test_platform_consensus.sh out/macos-$(uname -m)
```

**Apple Silicon is the one that has been proven.** An Intel Mac has not been
built or synced by anyone yet, so if you have one, that run is worth more to
this project than a second arm64 one.

---

## Troubleshooting

**`randomx.h: No such file or directory`**
`CPPFLAGS` is not pointing at `build/randomx/src`. That directory is the include root, not
`build/randomx`.

**`undefined reference to randomx_calculate_hash`**
`librandomx.a` is missing from `LIBS`, or it appears *before* the objects that use it.
Static archives must come after their consumers on the link line.

**`assert(consensus.hashGenesisBlock == uint256S("0x0000..."))` fails at startup**
The genesis block has not been mined yet, or `chainparams.cpp` was edited after mining.
Re-run `genesis/genesis_generator.py --patch`.

**`the founder address is not a valid base58check address`**
`WAM_FOUNDER_ADDRESS_MAINNET` is still the placeholder. This is intentional — see
§"Launching a real chain" in the README.

**`randomx_alloc_dataset failed`**
Full-dataset mode needs ~2.1 GiB free, and only two programs here ask for it: the
miner and the genesis generator. Pass `--light` to either and both use the 256 MiB
cache instead. The node never allocates a dataset — it verifies in light mode and has
no option to do anything else. This entry used to say `randomxmining=0`, which is not
an option the node has.

**The build OOMs**
Lower the job count. `make -j2` on 4 GB, `-j4` on 8 GB.
