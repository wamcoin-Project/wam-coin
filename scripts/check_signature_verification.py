#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
===============================================================================
 check_signature_verification.py -- `gpg --verify` alone proves nothing
===============================================================================

     python3 scripts/check_signature_verification.py

 WHY THIS EXISTS

 `gpg --verify` exits 0 for a signature made by ANY key in the keyring it is
 given. It answers "was this signed by the key I was handed", and the question
 anybody actually has is "was this signed by WAM Coin". Those are the same
 question only when the keyring cannot be chosen by whoever supplied the file.

 scripts/solo_gate.sh downloaded SIGNING-KEY.asc from the same website as the
 release, imported it into a fresh keyring, ran `gpg --batch --verify`, and
 then unpacked and EXECUTED the binaries -- as root, daily, on a host running
 a mainnet node and a solo miner. An attacker who could replace the tarballs
 could replace the key beside them, sign his own SHA256SUMS with it, and the
 gate said yes. The comment above that line claimed the signature was checked
 "against the published key"; nothing in the file knew what the published key
 was.

 scripts/install_release.sh had already written down why, in as many words:
 "verify_release.sh is called rather than reimplemented. Two verifiers drift."
 They drifted, in the one place that ran as root.

 Reported by Martam, 13 November 2026, with the gate's own commands replayed
 against an attacker key -- and reproduced here: a throwaway key carrying our
 own name and email signs a SHA256SUMS, and verify_release.sh refuses it on
 the fingerprint while plain `gpg --verify` accepts it.

 WHAT THIS CHECKS

 Any file that runs `gpg ... --verify` must do ONE of:

   * compare the signer against the published fingerprint
     (4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4, via VALIDSIG), or
   * call scripts/verify_release.sh, which does, or
   * verify against a keyring the caller controls rather than one the file
     being checked came with -- declared here by name, with its reason.

 It is a text check and says so: it cannot tell whether a fingerprint
 comparison is reached on every path. What it can do is refuse the shape that
 has no comparison at all, which is the shape that shipped.
===============================================================================
"""

from __future__ import annotations

import pathlib
import re
import sys

import pathlib as _pathlib
import sys as _sys
_sys.path.insert(0, str(_pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

RED = "\033[31m"; GRN = "\033[32m"; YEL = "\033[33m"; BLD = "\033[1m"; OFF = "\033[0m"

# wam:quote-begin
FINGERPRINT = "4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4"
# wam:quote-end

VERIFIES = re.compile(r"gpg\b[^\n|;&]*--verify\b")

# A file that compares the signer itself.
ENFORCES = re.compile(r"VALIDSIG|" + FINGERPRINT)

# A file that hands the question to the one verifier that does.
DELEGATES = re.compile(r"verify_release\.sh")

# VERIFYING WITH A KEYRING THE OTHER SIDE DID NOT CHOOSE.
#
# Signing our own files and reading them back is not the same act: the key is
# ours, in our own keyring, and nothing downloaded chooses it. Each of these
# is named rather than matched by a pattern, because "it looked like one of
# ours" is how an exemption list stops meaning anything.
OWN_KEYRING = {
    "scripts/sign_release.sh":
        "signs with our own key and reads the signature back as a self-check",
    "scripts/sign_file.sh": "the same, for one file",
    "scripts/sign_channels.sh": "the same, for CHANNELS.txt",
    "scripts/backup_signing_key.sh":
        "proves a backup of our own secret key still signs",
    "scripts/package_release.sh": "verifies what it has just signed",
    "scripts/package_platform.sh": "the same, per platform",
    "scripts/check_release_ready.sh":
        "asks whether the files we are about to publish carry our signature",
}


def main() -> int:
    files = sorted(
        # *.ps1 BELONGS HERE, AND WAS NOT HERE.
        #
        # verify_release.ps1 is the verification this project publishes for
        # Windows -- the audience its own header calls "the entire audience
        # the Windows build was added for" -- and this gate never globbed it.
        # So when verify_release.sh gained the present-but-unlisted check in
        # v0.1.15 and the .ps1 did not, nothing noticed: the same directory
        # passed one verifier and failed the other, and the gate that exists
        # to compare them read 175 scripts without opening either .ps1.
        #
        # Reported by Warung Bunda Kanse Bunda on 2026-11-22 (the missing
        # check) and by Radenlingga on 2026-11-26, who named this glob as the
        # reason it could go unnoticed.
        p for pat in ("*.sh", "*.py", "*.ps1",
                      "**/*.sh", "**/*.py", "**/*.ps1")
        for p in (ROOT / "scripts").glob(pat)
    ) + [ROOT / "install.sh"]
    seen, checked = set(), []
    for p in files:
        if not p.is_file() or p in seen:
            continue
        seen.add(p)
        checked.append(p)

    if not checked:
        print(f"\n  {RED}FAIL{OFF}  no script was read -- this proves nothing\n")
        return 2

    verifiers, fails, exempt = [], [], []
    for p in checked:
        rel = p.relative_to(ROOT).as_posix()
        if rel == "scripts/check_signature_verification.py":
            continue                      # this file talks about the shape
        try:
            text = quoted.strip_quoted(p.read_text(encoding="utf-8",
                                                   errors="replace"))
        except OSError:
            continue
        # A GUARD ABOUT WHAT THE CODE DOES MUST NOT READ WHAT THE COMMENTS SAY.
        #
        # The first version of this reddened scripts/deploy.sh and
        # scripts/sweep.sh, both of which merely QUOTE the instruction we give
        # readers -- "the file tells its reader to run gpg --verify" -- in a
        # paragraph explaining why an unsigned CHANNELS.txt is worse than no
        # signature. Neither verifies anything. Caught on this file's first
        # run, which is the same disease it was written about: a check that
        # cannot tell use from mention.
        code = "\n".join("" if l.lstrip().startswith("#") else l
                         for l in text.splitlines())
        if not VERIFIES.search(code):
            continue
        verifiers.append(rel)

        if rel == "scripts/verify_release.sh":
            if not ENFORCES.search(code):
                fails.append(f"{rel} IS the verifier and no longer compares the "
                             f"signer against {FINGERPRINT}")
            continue
        if rel in OWN_KEYRING:
            exempt.append((rel, OWN_KEYRING[rel]))
            continue
        if ENFORCES.search(code) or DELEGATES.search(code):
            continue

        line = next((i for i, l in enumerate(code.splitlines(), 1)
                     if VERIFIES.search(l)), 0)
        fails.append(
            f"{rel}:{line} runs `gpg --verify` and never compares the signer. "
            f"That exits 0 for any key in the keyring it was given -- and if "
            f"the keyring is built from a file that came with the thing being "
            f"checked, it cannot fail. Call scripts/verify_release.sh, or "
            f"compare VALIDSIG against the published fingerprint as it does.")

    print()
    print(f"{BLD}`gpg --verify` alone proves nothing{OFF}")
    print(f"  scripts read     : {len(checked)}")
    print(f"  that verify      : {len(verifiers)}")
    print(f"  own-keyring      : {len(exempt)}, each named with its reason")
    print()
    for rel, why in exempt:
        print(f"  {YEL}--{OFF}    {rel}: {why}")
    if exempt:
        print()
    for m in fails:
        print(f"  {RED}FAIL{OFF}  {m}")
        print()
    if fails:
        print(f"  {RED}{len(fails)} verification(s) that cannot fail{OFF}\n")
        return 1
    print(f"  {GRN}{BLD}every signature check either compares the fingerprint "
          f"or asks the one that does{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
