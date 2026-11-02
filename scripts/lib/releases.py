# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  releases.py -- which versions a stranger can actually download, and which
#                 of them is the newest
# ===========================================================================
#
#  Imported by scripts/check_docs_version.py, which asks whether the versions
#  our documents tell a reader to fetch still exist, and by
#  scripts/check_running_version.py, which asks whether our own machines are
#  running the version we tell him to fetch.
#
#  WHY IT IS A LIBRARY AND NOT A FUNCTION IN EACH
#
#  The two questions share one answer -- "what is the newest release" -- and
#  this repository has been bitten three times by the same shape: two copies
#  of one rule, written to agree and then maintained separately, which is not
#  agreement, it is coincidence with a deadline. docversion.py exists for
#  exactly that reason and says so in its own header.
#
#  So there is one definition of "newest". If it is ever wrong, it is wrong
#  in one place and both checks say the same wrong thing, which is a bug
#  somebody finds. Two definitions drifting apart is a bug nobody finds.
#
#  WHY THE DOWNLOAD DIRECTORY AND NOT A TAG, OR AN API
#
#  A git tag is what we decided. The download directory is what a stranger
#  receives. Those came apart on 2026-09-24, when a code-hosting account was
#  suspended and every install instruction this project had ever printed
#  became a 404 while every tag was still perfectly in place.
#
#  check_docs_version.py asked api.github.com until that day, and then
#  reported "the documented version still exists FAIL -- HTTP 404" about
#  documentation that was correct. It was asking the wrong question: what
#  matters is not whether a release exists on somebody's platform, but whether
#  the URL the instructions give a reader answers when he fetches it.
#
#  /releases/latest is deliberately NOT used either: release.yml marks every
#  v0.x as a pre-release by convention, so that URL 404s on a project that has
#  published fourteen of them.
# ===========================================================================

import re
import urllib.request

DOWNLOADS = "https://wamcoin.org/downloads/"

_UA = {"User-Agent": "wam-release-index"}


def published(timeout=25, base=DOWNLOADS):
    """({version: {"title", "has_binaries"}}, newest or None).

    The directory is served with autoindex, so its HTML lists one link per
    version. Parsing that is cruder than an API and has one large advantage:
    it sees exactly what a reader's browser would see.

    A version directory counts as real only if it holds a signed list. A
    folder with archives and no SHA256SUMS.asc is a download nobody can
    check, which this project says it will not publish -- so it is not
    something we may call the newest release either.
    """
    req = urllib.request.Request(base, headers=_UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        html = r.read().decode("utf-8", "replace")

    out = {}
    for tag in sorted(set(re.findall(r'href="v([0-9.]+)/"', html))):
        try:
            req2 = urllib.request.Request(base + "v" + tag + "/SHA256SUMS.asc",
                                          headers=_UA)
            with urllib.request.urlopen(req2, timeout=timeout) as r2:
                signed = bool(r2.read(1))
        except Exception:
            signed = False
        out[tag] = {"title": "v" + tag, "has_binaries": signed}

    newest = max(out, key=key) if out else None
    return out, newest


def key(version):
    """Sortable form of "0.1.13".

    As integers, so v0.1.13 is newer than v0.1.9. Sorted as text it is not,
    and that is not a theoretical ordering problem on this project: the two
    versions that differ this way are the two that were live on our own seeds
    on 2026-11-01.
    """
    return [int(x) for x in version.strip().lstrip("v").split(".")]
