# The pre-launch announcement, 4 September 2026

Four drafts for four places, eleven days before mainnet. Nobody has posted
them yet; the founder posts by hand.

| File | Where | Format |
|---|---|---|
| `bitcointalk.txt` | [Altcoin Announcements](https://bitcointalk.org/index.php?board=159.0) | BBCode, one post |
| `telegram.txt` | [t.me/wam_coin_updates](https://t.me/wam_coin_updates) | English then Arabic |
| `discord.txt` | [discord.gg/Gxvmrjy9Qb](https://discord.gg/Gxvmrjy9Qb) | two messages, under the 2000 cap |
| `x.txt` | [x.com/WAMCoinCore](https://x.com/WAMCoinCore) | a thread of 9, plus an Arabic post |

Order matters a little: BitcoinTalk first, because it is the one that gets
replies and the one worth linking to from the others.

## What they claim, and where each number came from

Nothing in them is aspirational. Every figure was read out of the running
system on 4 September, not out of a document:

```
testnet height 5,136       wam-cli -testnet getblockchaininfo
independent nodes: 1       getpeerinfo, minus our own two seeds and the
                           founder's own line
premine 5 x 400,000        wam-params.h, WAM_PREMINE_UNLOCK_TIMES
unlocks 2027..2031         the same array, as calendar dates
fingerprint                SECURITY.md, and scripts/verify_release.sh
SLIP-44 5718349            satoshilabs/slips PR #2051, merged 2026-08-26
release assets             the GitHub API, not the packaging script
```

**One node, not two.** A second operator ran a node for several days and
left; the Germany node still retries the address every ten minutes, which
reads like a live peer in the logs and is not one — `lastseen=116.5hrs` at
the time of writing. The drafts say one because one is true.

**No countries, no addresses, no operator names.** One operator per country
means naming a country names the person to anyone who can watch the network,
and none of them agreed to be mentioned. A count is the most that can be
published.

## What writing them found

The verify command was going to be published broken.

`scripts/verify_release.sh` resolved its own location with `dirname "$0"`
*after* `cd`-ing into the download directory. `$0` is a relative path for
anybody who is not standing in the repo, so `SIGNING-KEY.asc` beside the
script was never found, the fallback to the reader's own keyring was taken,
and a reader who had imported nothing was told:

```
FAIL  the signature over SHA256SUMS is NOT valid
```

about a release that is perfectly good. That is the worst thing this script
can do — accuse an honest release, at the moment a stranger is deciding
whether to trust us, and do it to every first-time reader.

It was invisible because every test ran from inside the repo, where the
relative path happens to resolve. Found by running the published command as
a stranger would: clean directory, empty keyring, nothing cloned but what
the announcement says to clone.

Fixed by resolving the script's own directory to an absolute path before the
`cd`, and proved on a clean machine: the failing case now exits 0, the
in-repo case still exits 0, and the keyring was confirmed empty so no key
was quietly borrowed from a previous run.

## Which of these files is a record, and which is a draft

`bitcointalk.txt` and `discord.txt` are **records**. Those posts are live and
carry the text in these files, including "Eleven days out", which was true on
the day and is dated by the post itself. Editing them here would make the
repository disagree with what people can read.

`telegram.txt` is a **draft** again: both messages were deleted before anyone
saw them, so it is text that will be posted, not text that was. It has been
brought up to date — and stripped of anything that ages.

`x.txt` never carried a countdown.

## Nothing in a post may age on its own

The Telegram messages opened "mainnet in 11 days". That was true for exactly
one day. The date says the same thing and stays true, so the countdown is
gone.

The same applies to every measured figure. The chain height moves every two
minutes, and the drafts said 5,136 when the chain was at 5,227. A number in
an announcement is a number somebody checks, and one that is quietly a day
old is the easiest kind of wrong to catch us in. The header of `telegram.txt`
carries the date its figures were measured and the two commands that
re-measure them.

This is the same failure as "four accounts that link to each other" in
CHANNELS.txt, which was written when there were four and was wrong at five.
Anything counted in prose goes stale; write what does not move.

## Never write a bare filename that ends in a TLD

The posts said "check the fingerprint against SECURITY.md on GitHub".
Telegram and X do not see a filename there. They see a hostname on
Moldova's `.md` registry, and they turn it into a link to a site nobody
here controls.

The founder found it by pressing it, in the message he had just sent to his
own channel. `security.md` is a live Moldovan shop selling video intercoms
and CCTV, shopping cart and all — so the sentence telling a reader where to
go and confirm our signing fingerprint linked them to a stranger's
storefront. That is exactly the attack the paragraph exists to prevent, and
it was in the paragraph.

A check run from the Germany node said `security.md` did not resolve. It was
wrong; the phone had already loaded the page. The measurement said no, the
man looking at it said yes, and the man looking at it was right.

Every reference is a full `https://` URL now. The rule for anything written
for a chat client, a forum or a timeline:

```
SECURITY.md          becomes a link, to somebody else
docs/REHEARSALS.md   safe -- the path prefix stops it being read as a host
CHANNELS.txt         safe -- .txt is not a TLD
```

The safe-looking two are safe by accident, not by design. Write the URL.

## What is still missing from the release page

`SIGNING-KEY.asc` and `verify_release.sh` are not release assets — only the
tarballs, `SHA256SUMS` and `SHA256SUMS.asc` are. The drafts work around it
by telling the reader to clone, which is arguably better anyway: the key
then comes from a different place than the binary it vouches for.

Worth deciding before launch whether the launch-day release should attach
them as well.

Note also that `v0.1.6` is marked **pre-release**, so GitHub's
`/releases/latest` skips it silently. Every draft links the tag directly.
