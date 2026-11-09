#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""Two plans in one sitting must not spend the same output.

WHAT THIS GUARDS

`--parts` keeps the parts of one payment disjoint, and treasury_spend.py
checks that it did before writing any file. Nothing kept two SEPARATE plans
disjoint, because a plan can only avoid what the mempool has already seen,
and the mempool sees nothing until a transaction is broadcast.

That did not matter while one person was paid at a time. On 9 November 2026
three people were owed in one sitting, and three plans cut from three scans
of an unchanged chain would have taken the same oldest outputs three times.
The failure arrives at broadcast, which is after the key has been used -- the
same place the 2 October fault arrived, by a different road.

This exercises drop_excluded() directly, with no node and no key, which is
the only way to test it before a ceremony rather than during one.
"""

import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import treasury_spend as T  # noqa: E402

GRN, RED, BLD, OFF = "\033[32m", "\033[31m", "\033[1m", "\033[0m"
passed, failed = 0, []


def check(name, ok):
    global passed
    if ok:
        passed += 1
        print(f"  {GRN}ok{OFF}    {name}")
    else:
        failed.append(name)
        print(f"  {RED}FAIL{OFF}  {name}")


def utxo(n):
    return {"txid": "%064x" % n, "vout": 0, "amount": 2.5, "height": 1000 + n}


def plan_file(tmp, name, utxos):
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"inputSet": [{"txid": u["txid"], "vout": u["vout"]}
                                for u in utxos]}, f)
    return path


def dies(fn):
    """die() calls sys.exit; a refusal is the behaviour under test."""
    try:
        fn()
    except SystemExit:
        return True
    except Exception:
        return False
    return False


def main():
    print(f"\n{BLD}  two plans in one sitting cannot take the same output{OFF}\n")
    tmp = tempfile.mkdtemp(prefix="wam-excl-")

    pool = [utxo(i) for i in range(10)]

    check("with nothing to exclude, the pool is untouched",
          T.drop_excluded(list(pool), None) == pool and
          T.drop_excluded(list(pool), []) == pool)

    first = plan_file(tmp, "a.json", pool[:4])
    left = T.drop_excluded(list(pool), [first])
    check("the four an earlier plan took are gone", len(left) == 6)
    check("and they are the right four",
          {u["txid"] for u in left} == {u["txid"] for u in pool[4:]})

    second = plan_file(tmp, "b.json", pool[4:7])
    left2 = T.drop_excluded(list(pool), [first, second])
    check("two earlier plans both count", len(left2) == 3)
    check("and what is left is disjoint from both",
          {u["txid"] for u in left2} == {u["txid"] for u in pool[7:]})

    # THE LOUD CASES. Each one is a way of excluding nothing while believing
    # something was excluded, which is the state this whole file exists to
    # make impossible.
    missing = os.path.join(tmp, "nope.json")
    check("a plan file that is not there stops everything",
          dies(lambda: T.drop_excluded(list(pool), [missing])))

    broken = os.path.join(tmp, "broken.json")
    with open(broken, "w", encoding="utf-8") as f:
        f.write("{not json")
    check("a file that is not JSON stops everything",
          dies(lambda: T.drop_excluded(list(pool), [broken])))

    empty = plan_file(tmp, "empty.json", [])
    check("a plan with no inputSet stops everything",
          dies(lambda: T.drop_excluded(list(pool), [empty])))

    shaped = os.path.join(tmp, "shaped.json")
    with open(shaped, "w", encoding="utf-8") as f:
        json.dump({"inputSet": [{"txid": "aa"}]}, f)
    check("an input missing its vout stops everything",
          dies(lambda: T.drop_excluded(list(pool), [shaped])))

    # The one that matters most: a plan for a DIFFERENT treasury, or one
    # whose inputs have already confirmed. It would remove nothing and the
    # operator would never know -- so it refuses instead.
    stranger = plan_file(tmp, "stranger.json", [utxo(99), utxo(98)])
    check("an --exclude that removes nothing is refused, not shrugged at",
          dies(lambda: T.drop_excluded(list(pool), [stranger])))

    print()
    if failed:
        print(f"{RED}{BLD}  {len(failed)} failed{OFF}, {passed} passed")
        for f_ in failed:
            print(f"    - {f_}")
        print()
        return 1
    print(f"{GRN}{BLD}  {passed} passed: a second plan cannot take the first one's coins{OFF}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
