#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  check_wrapping.py -- does the text render the way it was written?
# ===========================================================================
#
#      python3 scripts/check_wrapping.py
#
#  WHY THIS EXISTS
#
#  On 2026-10-30 a correction was posted to a pool operator's #wam channel.
#  It had been written here, read before sending, and every fact in it was
#  right. It came out looking like this on a phone:
#
# wam:quote-begin
#      2. The network panel reads "0 peers". The same
#         page shows a block two
#      minutes old at height 31,202 and 545 KH/s, so that
#         field is reading
#      wrong, not the network.
# wam:quote-end
#
#  Nothing was wrong with the words. The text was hard-wrapped at 72 columns,
#  the way every file in this repository is, and Discord does NOT join those
#  lines the way standard markdown does: a single newline is a line break
#  there. So 72-column lines are emitted as 72-column lines, a phone wraps
#  them AGAIN at about 46, and the reader gets long line, short remainder,
#  long line. Inside a numbered item it is worse: the continuation renders at
#  a different indent from the marker's text, so the sentence visibly breaks
#  in half.
#
#  The founder saw it before this script did, in the channel, after sending.
#
#  WHAT IT ENFORCES
#
#  Prose in a text destined for a newline-preserving channel is not wrapped
#  by hand. One paragraph, one line; let the client wrap it to whatever width
#  the reader is holding.
#
#  Inside a ``` fence the opposite is true -- there the bytes are respected
#  and the wrap is the author's, so fences are skipped entirely. Commands,
#  link blocks and hashes keep their shape.
#
#  TWO RULES, BECAUSE THE CHANNELS DISAGREE WITH EACH OTHER
#
#  Discord, Telegram and X preserve a single newline, so a hand wrap survives
#  and the reader gets the ragged output above. Rule: do not hand-wrap.
#
#  Reddit does the OPPOSITE. Old Reddit, and the markdown source itself, JOIN
#  lines separated by one newline, the way standard markdown has always done,
#  so a hand wrap DISAPPEARS. New Reddit's rich editor keeps it. The same
#  bytes render two ways depending on where the reader happens to be, and
#  that is not ours to choose.
#
#  So Reddit's rule cannot be the inverse of the first one, because MOST of
#  what joins ought to join: a wrapped paragraph rejoining into a paragraph
#  is both correct markdown and the author's intent. Measured on 2026-10-30,
#  each reddit.txt here has about thirteen runs of lines that old Reddit
#  would join, and nearly all of them are paragraphs meant to be joined. A
#  check that reported thirteen would be the check nobody reads.
#
#  What is checked is the one shape that is never a paragraph and always
#  wrong: TWO OR MORE BARE URLS ON CONSECUTIVE LINES, with no list marker, no
#  blank line and no two trailing spaces. Measured the same day:
#
# wam:quote-begin
#      posts/bounty-address-validation/reddit.txt
#        62-64  -> gitlab.com/... github.com/... gitea.com/...   one line
#        66-67  -> wamcoin.org wamcoin.net                       one line
#      posts/v0.1.10/reddit.txt
#        none -- it put `* ` in front of each URL
# wam:quote-end
#
#  One of the two got it right and the other did not, so the author decides
#  this and not the format. And the block that collapses is the one block no
#  post of this project is allowed to leave out -- the three homes and the
#  two domains. The rule we never break is the one that renders wrong.
#
#  Any of three fixes keeps the lines apart in BOTH renderers: a list marker,
#  a blank line, or two spaces at the end of the line.
#
#  bitcointalk.txt is not checked. It is BBCode, read mostly on a desktop
#  where a 72-column block renders as the tidy block it looks like here. The
#  first fault here is a phone fault and the second is a markdown fault, and
#  BBCode has neither.
#
#  WHAT IT CANNOT CATCH, SAID PLAINLY
#
#  It reads the files in this repository. The text actually pasted into a
#  channel is whatever was in the clipboard, and nothing here can see that.
#  A post composed in the Discord box, or edited after being copied out, is
#  invisible to every script this project has.
#
#  Exit 0 all good, 1 something would render wrong, 2 the check could not run.
# ===========================================================================

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "lib"))
import quoted  # noqa: E402  -- needs the path above

GRN, RED, YLW, BLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"

# A single newline survives here, so a hand wrap reaches the reader.
NEWLINE_KEPT = ("discord.txt", "telegram.txt", "x.txt")

# A single newline is swallowed here, so lines that must stay apart merge.
NEWLINE_JOINED = ("reddit.txt",)

CHANNELS = NEWLINE_KEPT + NEWLINE_JOINED

# ALREADY SENT, AND THEREFORE NOT EDITABLE.
#
# Every text in these directories was published before this check existed.
# posts/ is an archive: those files are what this project actually told
# people, on the day it told them, and editing one so a check passes would
# make this repository disagree with what is on Discord, Telegram and X.
# check_channels.py carries the same rule for the same reason.
#
# So they are named here rather than fixed, and the list is not allowed to
# rot: a name in it that no longer exists FAILS this check, because a
# forgiveness nobody can see the subject of is just a hole.
#
# THAT RULE IS ALSO THE ONLY THING STOPPING posts/ FROM BEING EMPTIED.
#
# posts/v0.1.12 is here because its three drafts were deleted on 18 October
# by bc3ae27, which gave a reason -- a repository is code and the tools that
# keep it honest, and posts are neither. Five checks read this directory and
# none of them can read a file that is not there. The reason is argued with
# in posts/README.md; the mechanism is this tuple.
PUBLISHED = (
    "posts/preannounce",
    "posts/v0.1.8",
    "posts/v0.1.9",
    "posts/v0.1.10",
    "posts/v0.1.12",
    "posts/bounty-address-validation",
)

# A line is "wrapped" when it is long, stops mid-sentence, and has more text
# directly underneath it.
#
# The length floor is what keeps this quiet. A short line is a decision -- a
# URL on its own, a `Site        wamcoin.org` row, a heading -- and none of
# those come near the wrap column. Only a line that reaches it was put there
# by a margin rather than by a person.
MIN_WRAP = 64

# Ends a sentence, a clause or a block, so the break after it is intended.
# A comma, a dash or a bare word at the end is a margin talking.
ENDS = re.compile(r"[.!?:;؟؛)\]\"'`*>]\s*$")

LIST_MARK = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+")
BARE_URL = re.compile(r"^\s*\S+://\S+\s*$")

# A line that is nothing but a URL, with or without a scheme. `wamcoin.org`
# alone on a line is one too, and that is half of the block that collapses.
URL_ONLY = re.compile(r"^\s*(?:https?://)?[a-z0-9.-]+\.[a-z]{2,}(?:/\S*)?\s*$",
                      re.I)

# A list marker, a quote, an indented block and a fence all keep their line in
# both renderers -- and so do two trailing spaces, which is markdown's own
# hard break and the reason that is not treated as an accident here.
KEEPS_ITS_LINE = re.compile(r"^\s*(?:[-*+>]|\d+[.)])\s+|^\s{4,}\S|^\s*```")


def wrapped_lines(text):
    """[(line number, the line)] for every hand-wrapped prose line.

    Quoted regions are blanked first, with their line numbers kept. A post
    that SHOWS badly wrapped text -- which is how this fault was reported in
    the first place -- would otherwise be failed for the quotation and not
    for its own prose. check_mentions.py refused this script on its first
    sweep for exactly that, before any such post existed to prove it.
    """
    lines = quoted.strip_quoted(text).split("\n")
    out, fence = [], False
    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            fence = not fence
            continue
        if fence or not line.strip():
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if not nxt.strip() or nxt.strip().startswith("```"):
            continue
        if LIST_MARK.match(nxt) or BARE_URL.match(line):
            continue
        if len(line.rstrip()) < MIN_WRAP or ENDS.search(line):
            continue
        out.append((i + 1, line.rstrip()))
    return out


def joined_lines(text):
    """[(line number, the line)] for bare URLs Reddit would run together.

    Runs of two or more only. One URL alone under a sentence joins onto that
    sentence, which is ordinary markdown and ordinarily what was meant; three
    repository URLs becoming one line is neither.
    """
    lines = quoted.strip_quoted(text).split("\n")
    out, run, fence = [], [], False
    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            fence = not fence
            run = []
            continue
        if (not fence and URL_ONLY.match(line)
                and not KEEPS_ITS_LINE.match(line)
                and not line.endswith("  ")):
            run.append((i + 1, line.strip()))
            continue
        if len(run) > 1:
            out.extend(run)
        run = []
    if len(run) > 1:
        out.extend(run)
    return out


def tracked():
    out = subprocess.run(["git", "ls-files", "posts"], cwd=str(ROOT),
                         capture_output=True, text=True)
    if out.returncode != 0:
        return None
    return [p.replace("\\", "/") for p in out.stdout.split()
            if p.rsplit("/", 1)[-1] in CHANNELS]


def main():
    print(f"\n{BLD}does the text render the way it was written?{OFF}")

    files = tracked()
    if files is None:
        print(f"  {RED}FAIL{OFF}  git could not list posts/ -- this proves nothing")
        print()
        return 2
    if not files:
        print(f"  {RED}FAIL{OFF}  no channel text was found -- this proves nothing")
        print()
        return 2

    # The forgiveness list is checked before it is used.
    gone = [d for d in PUBLISHED if not (ROOT / d).is_dir()]
    if gone:
        print(f"  {RED}FAIL{OFF}  PUBLISHED names {len(gone)} director(y/ies) that "
              f"are not here")
        for d in gone:
            print(f"          {d}")
        print("        A text is exempt because it was already sent. If the")
        print("        directory is gone the exemption is forgiving nothing,")
        print("        and the next new post inherits a hole. Edit the list.")
        print()
        return 1

    bad, exempt, clean = {}, 0, 0
    for rel in files:
        if any(rel.startswith(d + "/") for d in PUBLISHED):
            exempt += 1
            continue
        try:
            text = (ROOT / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if rel.rsplit("/", 1)[-1] in NEWLINE_KEPT:
            hits, kind = wrapped_lines(text), "hand-wrapped"
        else:
            hits, kind = joined_lines(text), "runs together"
        if hits:
            bad[rel] = (kind, hits)
        else:
            clean += 1

    print(f"  {GRN}ok{OFF}    {len(PUBLISHED)} director(ies) of already-sent text "
          f"are exempt ({exempt} files)")

    if bad:
        total = sum(len(h) for _, h in bad.values())
        kinds = {k for k, _ in bad.values()}
        print(f"  {RED}FAIL{OFF}  {total} line(s) in {len(bad)} text(s) would not "
              f"reach the reader as written")
        for rel, (kind, hits) in sorted(bad.items()):
            print(f"          {rel}  --  {kind}")
            for n, line in hits[:3]:
                print(f"            :{n}  {line[:58]}...")
            if len(hits) > 3:
                print(f"            ... and {len(hits) - 3} more")
        print()
        if "hand-wrapped" in kinds:
            print("        Discord, Telegram and X keep a single newline, so these")
            print("        go out at this width and the phone wraps them again:")
            print("        long line, short remainder, long line.")
            print("        One paragraph, one line. Keep the wrap inside ``` only.")
            print()
        if "runs together" in kinds:
            print("        Reddit joins lines one newline apart, so these URLs")
            print("        arrive as a single line with the next one behind them.")
            print("        Put `* ` in front of each, or a blank line between, or")
            print("        two spaces at the end -- any of the three holds in both")
            print("        of Reddit's renderers.")
            print()
        return 1

    if clean == 0:
        print(f"  {YLW}!!{OFF}    every channel text here was already sent -- "
              f"nothing new to check")
        print()
        return 0

    print(f"  {GRN}ok{OFF}    {clean} unsent text(s) pass both rules")
    print()
    print(f"  {GRN}{BLD}what we wrote is what the reader will see{OFF}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
