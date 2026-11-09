#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""The Android miner is the miner, plus two lines that are named here.

WHY THIS EXISTS
---------------
contrib/wam-miner-android carries its own copy of the miner's C++ sources,
because an Android build needs them inside the Gradle project. A copy with
nothing watching it is a copy that stops being one.

On 8 November 2026 two faults in the miner's JSON handling were reported,
paid and fixed in miner/src. Nobody asked whether those files existed
anywhere else. They did. The Android tree kept the unfixed json.h and
solo_template.h for a day, with their bare int64_t(double) casts and no
guard on a negative height -- so the hang that had just been fixed and
announced was still sitting in the shipped sources of the phone app, and
the announcement was true of one tree out of two.

It was found by an outsider reading the fix: Radenlingga
(@stokraden45506), 9 November 2026. He measured the Android copy spinning
on a template height of -5 with memory climbing from 36 MB to 463 MB in
three and a half seconds, against a desktop copy that refuses it
immediately.

Diffing the two trees by hand finds that. Nothing was diffing them.

HOW IT DECIDES
--------------
Not "are they similar". The Android tree must BE the desktop tree with the
substitutions below applied -- byte for byte, after them. Every real
difference is therefore written down here, in one place, where changing it
is a decision somebody makes on purpose rather than a file that quietly
fell behind.

Adding a legitimate Android difference means adding it to ANDROID_EDITS.
That is the point: it costs one edit here and it is then visible forever.
"""

import difflib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESKTOP = ROOT / "miner" / "src"
ANDROID = ROOT / "contrib" / "wam-miner-android" / "app" / "src" / "main" / "cpp" / "src"

GRN, RED, YLW, BLD, OFF = "\033[32m", "\033[31m", "\033[33m", "\033[1m", "\033[0m"

# (file, desktop text, android text, why)
#
# Each entry is applied to the desktop file before comparing. A desktop text
# that no longer appears is itself a failure: the edit is stale, and a stale
# exemption forgives something nobody can see any more.
ANDROID_EDITS = [
    (
        "stratum.h",
        "void BuildHeader(const StratumJob& job, const Bytes& extranonce2, uint8_t header[80])",
        "inline void BuildHeader(const StratumJob& job, const Bytes& extranonce2, uint8_t header[80])",
        "the Gradle build includes this header from more than one translation "
        "unit, so the definition has to be inline or the link fails",
    ),
    (
        "stratum.h",
        'kUserAgent = "wam-miner/1.0.0"',
        'kUserAgent = "wam-miner-android/1.0.0"',
        "pools see which build connected, which is worth knowing and costs "
        "nothing",
    ),
]


def main() -> int:
    print(f"\n{BLD}  is the Android miner the miner?{OFF}")

    if not ANDROID.is_dir():
        print(f"  {YLW}!!{OFF}    no Android source tree at {ANDROID.relative_to(ROOT)}, "
              f"so nothing was compared")
        return 2

    desktop_files = {p.name for p in DESKTOP.iterdir() if p.is_file()}
    android_files = {p.name for p in ANDROID.iterdir() if p.is_file()}

    bad = []

    missing = sorted(android_files - desktop_files)
    for name in missing:
        bad.append((name, "exists only in the Android tree, so nothing "
                          "upstream can keep it right"))

    # A desktop file the Android tree does not carry is not a fault: the app
    # does not build every tool. It is only a fault when it is there and
    # different.
    shared = sorted(android_files & desktop_files)

    for name in shared:
        want = (DESKTOP / name).read_text(encoding="utf-8")
        for f, src, dst, _why in ANDROID_EDITS:
            if f != name:
                continue
            if src not in want:
                bad.append((name, f"the recorded Android edit no longer "
                                  f"matches anything in miner/src/{name}: "
                                  f"{src[:50]}..."))
                continue
            want = want.replace(src, dst, 1)
        got = (ANDROID / name).read_text(encoding="utf-8")
        if got != want:
            # A real diff, not a line-by-line zip: one inserted line makes
            # every line after it compare unequal, and a count that says 294
            # for a 33-line change is a number that misleads the person
            # reading the failure.
            lines = sum(1 for d in difflib.ndiff(want.splitlines(),
                                                 got.splitlines())
                        if d[:1] in "+-")
            bad.append((name, f"differs from miner/src/{name} in a way that is "
                              f"not in ANDROID_EDITS ({lines} line(s))"))

    print(f"  {GRN}ok{OFF}    {len(shared)} shared file(s), "
          f"{len(ANDROID_EDITS)} recorded Android difference(s)")

    if bad:
        print(f"  {RED}FAIL{OFF}  {len(bad)} file(s) have drifted")
        for name, why in bad:
            print(f"          {name}  --  {why}")
        print()
        print("        Fix:  cp miner/src/<file> "
              "contrib/wam-miner-android/app/src/main/cpp/src/<file>")
        print("        and re-apply the edits in ANDROID_EDITS, or add the new")
        print("        difference to that list if it is deliberate.")
        print()
        print("        A fix applied to one of two copies is a fix that was")
        print("        announced and not made.")
        print()
        return 1

    print(f"\n{GRN}{BLD}  the phone runs the same miner{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
