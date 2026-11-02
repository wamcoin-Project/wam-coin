# posts/ — what this project said in public, and what it is about to say

Every channel draft lives here: one directory per release, plus `replies/`
for messages sent to a named person, `listings/` for submissions to other
projects, and the one-off directories for a launch or a bounty.

A draft is written here, reviewed here, and sent from here. After it is sent
the file stays, unchanged.

## Why they are in the repository and not in somebody's notes

Because five checks read this directory, and none of them can read a file
that is not there.

| sweep row | what it asks of a draft |
|---|---|
| `no filename reads as a domain` | that nothing in it reads as a hostname on a registry we do not control |
| `the text renders as written` | that the platform it is addressed to will not join or break its lines |
| `the channel list names all of us` | that what we published names every home and no dead one |
| `treasury claims match the ledger` | that a number in a post is a number the chain has |
| `published claims match consensus` | that a promise on a page is one the code keeps |

Four of those read the per-release directories. The fifth reads the top
level. All five run on the laptop, before a word is sent, which is the only
moment any of it can still be fixed.

That is the whole argument. It is not about tidiness, and it does not depend
on anybody agreeing that a post is interesting.

## The counter-argument, and why it lost

`bc3ae27`, 18 October 2026, deleted the three v0.1.12 drafts and said:

> A repository is code and the tools that keep it honest; posts are neither,
> and sending one through a pull request reads as motion rather than work.

The first half is a real principle and the second is a real risk. Both were
written without noticing that five checks had already been built on this
directory, and the deletion blinded them for v0.1.12 without failing
anything — because a check that finds no file reports nothing, which is the
quietest way a guard can die.

Thirteen days later the four v0.1.13 drafts were written, and on 1 November
`ship.sh` refused to push anything at all while they sat in the working tree
untracked. In this repository a post is either committed or it is not on
disk. There is no third state where it waits in a working tree being useful.

The three v0.1.12 drafts were restored on 1 November 2026 and
`posts/v0.1.12` was added to the published list in
`scripts/check_wrapping.py`, where a directory that disappears fails the
sweep. That list is the mechanism. This file is the reason, so that the next
person to propose emptying this directory reads the argument before the
diff rather than after it.

## Already sent is not editable

A file in a directory named in that published list is a record, not a draft.
It is what this project told people, on the day it told them. Editing one so
a check passes would make the repository disagree with what is on Discord,
Telegram, X and BitcoinTalk, which is worse than the finding.

So those are exempted by name and fixed never. A draft that has not been
sent has no such protection and is not allowed any.

## What does not belong here

`TAG_MESSAGE.txt` is in each release directory but is not a post. The
release workflow reads it and the announcement check reads it; it is a build
input, and `bc3ae27` was right to keep it when it removed the rest.
