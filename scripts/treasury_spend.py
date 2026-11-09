#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
"""
Spend from the treasury without the key ever touching a networked machine.

    ONLINE   python3 scripts/treasury_spend.py plan --to <addr> --amount 500
    OFFLINE  python3 scripts/treasury_spend.py sign --in plan.json
    ONLINE   python3 scripts/treasury_spend.py broadcast --in signed.json

WHY THIS EXISTS

The treasury is one key until the 2-of-3 arrangement exists, and it holds
every coin WAM-1 has ever paid it -- 12,322 WAM at height 4,929, rising by
1,800 a day. Importing that key into a wallet on a machine with a network
interface, to move 500 WAM, risks the whole balance to save an afternoon.

So the transaction is built where the chain is, signed where the key is, and
broadcast back where the chain is. Three files cross between them and none of
them contains a key.

WHAT IT REFUSES TO DO

It does not read, store, log or transmit the private key. `sign` prompts for
it, holds it in memory for one call, and never writes it anywhere -- not to
the plan, not to the signed file, not to a log.

It does not trust the file it is given. `broadcast` decodes the signed
transaction and compares its outputs against the plan before sending: the
destination, the amount, the change address and the fee. A file altered
between the two machines is refused with the difference named, not sent.

It does not guess the fee. The plan states it, `broadcast` recomputes it from
the decoded transaction, and a disagreement stops everything.

THE SHAPE OF A TREASURY SPEND

WAM-1 pays the treasury once per block: 2.5 WAM, one output, every block
since height 1 and never spent. So 500 WAM is not one input, it is 201 of
them, and the transaction is about 30 KB. That is well inside the 100 KB
standard limit but it is not something a person can assemble by hand, which
is the other reason this file exists.

Coinbase outputs need 100 confirmations before they can move. Outputs younger
than that are excluded, and the reason is printed rather than assumed.
"""

import argparse
import base64
import decimal
import getpass
import hashlib
import json
import os
import subprocess
import sys
import urllib.request

TREASURY = "WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE"
COINBASE_MATURITY = 100
# 0.0002 WAM/kvB is what the node estimates and 20,000 sat/kvB is the wallet's
# own fallback; a 30 KB transaction pays well under a hundredth of a coin
# either way. Stated here rather than estimated so the two machines agree.
FEERATE_PER_KVB = 0.0002


def die(msg):
    sys.stderr.write("error: %s\n" % msg)
    raise SystemExit(1)


class Rpc:
    """Talks to a node over HTTP, reading credentials from its wam.conf."""

    def __init__(self, conf, host="127.0.0.1", port=9554):
        creds = {}
        try:
            for line in open(conf, encoding="utf-8"):
                if "=" in line and not line.lstrip().startswith("#"):
                    k, v = line.split("=", 1)
                    creds[k.strip()] = v.strip()
        except OSError as e:
            die("cannot read %s: %s" % (conf, e))
        if "rpcuser" not in creds or "rpcpassword" not in creds:
            die("%s has no rpcuser/rpcpassword" % conf)
        self.auth = base64.b64encode(
            ("%s:%s" % (creds["rpcuser"], creds["rpcpassword"])).encode()).decode()
        self.url = "http://%s:%d/" % (host, port)

    def call(self, method, params=None):
        body = json.dumps({"jsonrpc": "1.0", "id": "treasury",
                           "method": method, "params": params or []})
        req = urllib.request.Request(
            self.url, data=body.encode(),
            headers={"Authorization": "Basic " + self.auth,
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                out = json.load(r)
        except Exception as e:
            die("%s: %s" % (method, e))
        if out.get("error"):
            die("%s: %s" % (method, out["error"].get("message", out["error"])))
        return out["result"]


def wam(x):
    """Coins, printed the way the node prints them."""
    return "%.8f" % x


# ---------------------------------------------------------------------------
#  Reading a transaction, in whole numbers
# ---------------------------------------------------------------------------
#
#  Everything below compares a decoded transaction against a plan, and a
#  comparison is only worth making if it is exact. Coins are decimal and
#  binary floating point is not, so every value crossing one of these checks
#  is converted to atoms -- whole numbers -- through Decimal, and compared as
#  integers. 0.1 + 0.2 is a famous example; the one that matters here is that
#  two values printed identically can differ.
#
#  The construction arithmetic in cmd_plan is still float, and is left that
#  way deliberately for now: rewriting what COMPUTES the amounts at the same
#  time as adding the checks that verify them would mean neither is watching
#  the other. These checks are exact, so float drift in the plan is caught
#  here rather than carried through.

COIN = decimal.Decimal(100000000)


def _atoms(value, what="amount"):
    """A coin value as whole atoms, or death. Never silently rounded."""
    try:
        d = decimal.Decimal(str(value)) * COIN
    except (decimal.InvalidOperation, ValueError, TypeError):
        die("%s is not a number: %r" % (what, value))
    if not d.is_finite() or d != d.to_integral_value() or d < 0:
        die("%s must be positive with at most 8 decimals: %r" % (what, value))
    return int(d)


def _outpoints(vins, where):
    """The exact inputs, in order, refusing anything ambiguous."""
    points = []
    for v in vins:
        if not isinstance(v, dict) or "txid" not in v or "vout" not in v:
            die("an input in %s cannot be read" % where)
        if "coinbase" in v:
            die("%s spends a coinbase directly, which this never does" % where)
        points.append((str(v["txid"]), int(v["vout"])))
    if len(set(points)) != len(points):
        die("%s spends the same output twice" % where)
    return points


def _outputs(tx, where):
    """(address, atoms) for every output, refusing one we cannot name.

    An output whose scriptPubKey carries no single address used to be skipped
    -- `if addr:` -- so a payment to a raw script was invisible to the check
    that looks for unexpected recipients. Invisible is the one thing an output
    in a treasury transaction may not be.
    """
    out = []
    for o in tx.get("vout", []):
        spk = o.get("scriptPubKey")
        if not isinstance(spk, dict):
            die("an output in %s cannot be read" % where)
        addr = spk.get("address")
        if not isinstance(addr, str) or not addr:
            die("%s has an output that pays no single address -- refusing to "
                "judge a transaction whose recipients cannot all be named" % where)
        out.append((addr, _atoms(o.get("value"), "an output value")))
    return out


def _verify_against_plan(plan, tx, where):
    """Does this transaction do exactly what the plan says, to the atom?

    Inputs in the same order, outputs exactly destination plus change, and the
    fee equal to inputs minus outputs. Anything else dies.
    """
    want_in = _outpoints(plan.get("inputSet", []), "the plan")
    if not want_in:
        die("the plan does not name the outputs it spends -- it was written "
            "by an older version of this script. Re-run `plan`.")
    if _outpoints(tx.get("vin", []), where) != want_in:
        die("%s does not spend the inputs the plan approved, or spends them "
            "in a different order" % where)

    amount = _atoms(plan["amount"], "the amount")
    change = _atoms(plan["change"], "the change")
    fee = _atoms(plan["fee"], "the fee")
    total_in = _atoms(plan["inputTotal"], "the input total")

    want_out = [(plan["to"], amount)]
    if change:
        want_out.append((TREASURY, change))
    got_out = _outputs(tx, where)
    if sorted(got_out) != sorted(want_out):
        die("%s does not pay exactly what the plan says. It pays: %s" %
            (where, ", ".join("%s to %s" % (wam(a / 1e8), ad) for ad, a in got_out)))

    if total_in - sum(a for _, a in got_out) != fee:
        die("%s does not conserve value: inputs minus outputs is not the "
            "fee the plan states" % where)


# ---------------------------------------------------------------------------
# plan -- runs where the chain is
# ---------------------------------------------------------------------------

def drop_excluded(mature, paths):
    """Remove the outputs an earlier plan in this sitting already took.

    --parts solves this for one address: the parts come out of one pool and
    the pool is consumed as they are cut. It cannot solve it for two
    addresses, because a plan pays one address.

    On 9 November 2026 three bounties were owed to three people in one
    sitting. Planning them one after another, with nothing broadcast in
    between, would have offered the same oldest outputs to all three -- the
    mempool filter sees only what has already been sent, and nothing had
    been. That is the 2 October fault arriving by a different road: two plans
    spending one outpoint, discovered at broadcast, after the key was used.

    So a plan can be told what an earlier plan already took. The check that
    --parts performs between its own parts, this performs across separate
    runs.

    It is deliberately loud. An --exclude that removes nothing is a file that
    is not what the operator believes it is, and continuing would be exactly
    the silence this tool exists to refuse: a check that could not look,
    reporting that it had looked.
    """
    for path in (paths or []):
        try:
            with open(path, "r", encoding="utf-8") as f:
                earlier = json.load(f)
        except Exception as e:
            die("cannot read the plan to exclude, %s (%s). Nothing was "
                "planned." % (path, e))
        taken = earlier.get("inputSet") if isinstance(earlier, dict) else None
        if not isinstance(taken, list) or not taken:
            die("%s has no inputSet, so it is not a plan this can exclude. "
                "Nothing was planned." % path)
        try:
            outpoints = {(i["txid"], i["vout"]) for i in taken}
        except (TypeError, KeyError) as e:
            die("an input of %s cannot be read (%s). Nothing was planned."
                % (path, e))
        before = len(mature)
        mature = [u for u in mature if (u["txid"], u["vout"]) not in outpoints]
        removed = before - len(mature)
        if removed == 0:
            die("%s names %d outpoint(s) and this scan offered none of them. "
                "Either it is a plan for another treasury or another chain, "
                "or what it spends has already confirmed -- and either way "
                "what you meant to exclude is not what was excluded. Nothing "
                "was planned." % (path, len(outpoints)))
        print("  already planned     %d output(s) taken by %s, left out"
              % (removed, os.path.basename(path)))
    return mature


def cmd_plan(args):
    rpc = Rpc(args.conf, port=args.port)
    tip = rpc.call("getblockcount")

    print("scanning the treasury's unspent outputs (this takes a minute)...")
    scan = rpc.call("scantxoutset", ["start", ["addr(%s)" % TREASURY]])
    if not scan.get("success"):
        die("the scan did not complete")

    utxos = scan.get("unspents", [])
    # Spendable at depth 101, not 100. Consensus rejects a coinbase spent
    # earlier than (COINBASE_MATURITY + 1) confirmations -- Core's own wallet
    # computes max(0, (COINBASE_MATURITY + 1) - depth) -- so a selection that
    # stops at 100 can put an output in the plan that the network will not
    # accept, and the failure arrives at broadcast, after the key has already
    # been used on the offline machine. Every treasury output is a coinbase.
    mature = [u for u in utxos if tip - u["height"] + 1 > COINBASE_MATURITY]
    young = len(utxos) - len(mature)

    # AND NOT THE ONES AN UNCONFIRMED TRANSACTION HAS ALREADY SPENT.
    #
    # scantxoutset reads the UTXO SET, which is the chain and nothing else. A
    # transaction sitting in the mempool has spent its inputs as far as the
    # network is concerned and not at all as far as this scan is concerned.
    #
    # On 2026-10-02 the bounty was being paid in eight parts. Part one was
    # broadcast and was still unconfirmed when part two was planned, so the
    # scan offered the same 501 outputs again, the planner took them in the
    # same order, and the result was byte-identical to part one -- the same
    # txid. The founder signed it on the offline machine before anything
    # noticed, and the node refused it at broadcast. No money moved and none
    # could have, but the key had been used for nothing.
    #
    # So the mempool is read and its spent outpoints are removed. Waiting two
    # minutes for a confirmation would also have worked and is the wrong fix:
    # it makes correctness depend on somebody being patient.
    spent = set()
    for txid in rpc.call("getrawmempool") or []:
        try:
            entry = rpc.call("getrawtransaction", [txid, True])
        except SystemExit:
            raise
        except Exception as e:
            # IT USED TO `continue`, AND THAT IS THE WHOLE BUG.
            #
            # This loop exists to find outputs an unconfirmed transaction has
            # already spent, so they are not selected twice. A transaction we
            # fail to read contributes nothing to `spent` -- so its inputs stay
            # in `mature` and can be chosen, which is exactly the duplicate
            # spend this loop was added to prevent. One failed read and the
            # defence is silently off.
            #
            # An incomplete picture of the mempool is not a picture of an empty
            # mempool. Found by dang150296 (Urriki1502), 2026-10-04, and it is
            # the same fault as the pool's payout path and the release watcher
            # on the same days: could not ask, read as nothing there.
            die("cannot read mempool transaction %s (%s). The mempool picture "
                "would be incomplete, and an incomplete picture is how an "
                "already-spent output gets selected. Nothing was planned."
                % (txid, e))
        if not isinstance(entry, dict) or not isinstance(entry.get("vin"), list):
            die("mempool transaction %s came back in a shape this cannot "
                "read. Nothing was planned." % txid)
        for vin in entry["vin"]:
            if "coinbase" in vin:
                continue
            if "txid" not in vin or "vout" not in vin:
                die("an input of mempool transaction %s cannot be read. "
                    "Nothing was planned." % txid)
            spent.add((vin["txid"], vin["vout"]))
    if spent:
        before = len(mature)
        mature = [u for u in mature if (u["txid"], u["vout"]) not in spent]
        held = before - len(mature)
        if held:
            print("  in the mempool      %d output(s) already spent by an "
                  "unconfirmed transaction, left out" % held)

    # AND NOT THE ONES A PLAN WRITTEN MINUTES AGO HAS ALREADY TAKEN.
    #
    # --parts solves this for one address: the parts come out of one pool and
    # the pool is consumed as they are cut. It cannot solve it for two
    # addresses, because a plan pays one address.
    #
    # On 9 November 2026 three bounties were owed to three people in one
    # sitting. Planning them one after another, with nothing broadcast in
    # between, would have offered the same oldest outputs to all three: the
    # mempool filter above sees only what has already been sent, and nothing
    # had been. That is the 2 October fault with a different cause -- two
    # plans spending one outpoint, found at broadcast, after the key was used.
    #
    # So a plan can be told what an earlier plan already took. The check that
    # --parts does between its own parts, this does across separate runs, and
    # it is deliberately loud: an --exclude that removes nothing is a file
    # that is not what the operator thinks it is, and carrying on would be
    # exactly the silence this tool exists to refuse.
    mature = drop_excluded(mature, getattr(args, "exclude", None))

    print("  height              %d" % tip)
    print("  outputs             %d, totalling %s WAM" %
          (len(utxos), wam(float(scan["total_amount"]))))
    print("  spendable now       %d (%d are at or under %d confirmations)" %
          (len(mature), young, COINBASE_MATURITY))

    # Oldest first: it spends the coins that have been there longest and keeps
    # the output count falling rather than leaving a tail of dust behind.
    mature.sort(key=lambda u: u["height"])

    target = float(args.amount)
    parts = max(1, int(getattr(args, "parts", 1) or 1))
    if parts > 1:
        print("  parts               %d, all cut from this one scan" % parts)

    # ONE SCAN, N PARTS, AND NO OUTPUT OFFERED TWICE.
    #
    # A bounty does not fit in one transaction. The treasury is paid one 2.5
    # WAM output per block and never consolidated, so 10,000 WAM is about
    # 4,000 inputs and 590 KB -- six times what any node will relay. It has to
    # leave in parts.
    #
    # Planning those parts one at a time costs a trip to the offline machine
    # per part, because a plan can only avoid the inputs of a transaction that
    # has already been sent: scantxoutset reads the chain, and the mempool
    # filter above sees only what was broadcast. On 2026-10-02 that cost a
    # signature -- part two was planned while part one was still unconfirmed,
    # the scan offered the same 501 outputs in the same order, and the two
    # plans came out byte-identical.
    #
    # Parts cut from one scan cannot collide, because the pool is consumed as
    # each part takes from it. The key is then used once per part in a single
    # sitting, instead of once per journey.
    pool = list(mature)
    built = []
    for i in range(1, parts + 1):
        reason = (args.reason if parts == 1
                  else "%s (%d of %d)" % (args.reason, i, parts))
        built.append(_plan_part(rpc, pool, target, args.to, reason, tip,
                                i, parts))

    # AND IT IS CHECKED RATHER THAN ASSUMED.
    #
    # The sentence above says the parts cannot collide. This is the line that
    # makes it true, because a plan that spends an outpoint another plan also
    # spends is a signature thrown away, and it is found at broadcast, after
    # the key has been used. Nothing is written until every part is disjoint.
    seen = {}
    for plan in built:
        for inp in plan["inputSet"]:
            key = (inp["txid"], inp["vout"])
            if key in seen:
                die("part %d and part %d both spend %s:%d. No file was "
                    "written and nothing is safe to sign."
                    % (seen[key], plan["part"], key[0], key[1]))
            seen[key] = plan["part"]

    names = []
    for plan in built:
        out = (args.out if parts == 1
               else _part_name(args.out, plan["part"], parts))
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(plan, f, indent=2)
        names.append(out)

    print()
    print("=" * 66)
    print(" READ THIS BEFORE YOU SIGN IT")
    print("=" * 66)
    if parts == 1:
        plan = built[0]
        print("  paying             %s WAM" % wam(target))
        print("  to                 %s" % args.to)
        print("  from               %s  (the treasury)" % TREASURY)
        print("  inputs             %d, totalling %s WAM"
              % (plan["inputs"], wam(plan["inputTotal"])))
        print("  change back        %s WAM" % wam(plan["change"]))
        print("  fee                %s WAM  (%d bytes)"
              % (wam(plan["fee"]), plan["sizeBytes"]))
        print("  reason             %s" % args.reason)
        print()
        print("  written to         %s" % names[0])
        print()
        print("  Carry that file to the air-gapped machine and run:")
        print("      python3 scripts/treasury_spend.py sign --in %s" %
              os.path.basename(names[0]))
        print("=" * 66)
        return

    print("  paying             %s WAM in %d parts, to one address"
          % (wam(target * parts), parts))
    print("  to                 %s" % args.to)
    print("  from               %s  (the treasury)" % TREASURY)
    print("  reason             %s" % args.reason)
    print()
    for plan, out in zip(built, names):
        print("  %d of %d   %s WAM   %4d inputs   fee %s   %s"
              % (plan["part"], parts, wam(plan["amount"]), plan["inputs"],
                 wam(plan["fee"]), out))
    print()
    print("  total leaving      %s WAM  (%s paid, %s in fees)"
          % (wam(sum(p["amount"] + p["fee"] for p in built)),
             wam(sum(p["amount"] for p in built)),
             wam(sum(p["fee"] for p in built))))
    print("  no two parts spend the same output: %d outpoints, all distinct"
          % len(seen))
    print()
    print("  Carry all %d files to the air-gapped machine, and sign each:" % parts)
    for out in names:
        print("      python3 scripts/treasury_spend.py sign --in %s"
              % os.path.basename(out))
    print("=" * 66)


def _part_name(path, i, n):
    """treasury-plan.json, part 2 of 8 -> treasury-plan-2of8.json"""
    base, ext = os.path.splitext(path)
    return "%s-%dof%d%s" % (base, i, n, ext or ".json")


def _plan_part(rpc, pool, target, to, reason, tip, part, parts):
    """Take inputs off the front of `pool` and build one unsigned plan.

    `pool` is consumed: every output this part spends is removed from it
    before it returns, so the next part cannot be offered the same coins."""
    chosen, got = [], 0.0
    for u in pool:
        chosen.append(u)
        got += float(u["amount"])
        # Over-collect by one input's worth so the fee is always covered.
        if got >= target + 3.0:
            break
    if got < target:
        die("the treasury has %s WAM left to select from and part %d of %d "
            "asked for %s. Nothing was planned."
            % (wam(got), part, parts, wam(target)))

    # Size, then fee. 148 bytes per P2PKH input, 34 per output, 10 overhead.
    size = len(chosen) * 148 + 2 * 34 + 10
    fee = round(FEERATE_PER_KVB * size / 1000.0, 8)
    change = round(got - target - fee, 8)
    if change < 0:
        die("the chosen inputs do not cover the amount and the fee")

    inputs = [{"txid": u["txid"], "vout": u["vout"]} for u in chosen]
    outputs = [{to: target}]
    # A change output below the dust threshold cannot be created, and
    # dropping it silently would pay the difference to miners.
    if change >= 0.00000546:
        outputs.append({TREASURY: change})
    else:
        fee = round(fee + change, 8)
        change = 0.0

    raw = rpc.call("createrawtransaction", [inputs, outputs])

    # signrawtransactionwithkey needs the scriptPubKey and amount of every
    # input, because the offline machine has no chain to look them up in.
    prevtxs = [{"txid": u["txid"], "vout": u["vout"],
                "scriptPubKey": u["scriptPubKey"], "amount": float(u["amount"])}
               for u in chosen]

    # The pool is a list, and `chosen` came off its front in order.
    del pool[:len(chosen)]

    return {
        "network": "mainnet",
        "from": TREASURY,
        "to": to,
        "amount": target,
        "change": change,
        "fee": fee,
        "inputs": len(chosen),
        # THE EXACT OUTPUTS, NOT JUST HOW MANY OF THEM.
        #
        # `inputs` is a count, and a count proves nothing: a transaction
        # spending 201 entirely different outputs matches 201. Both machines
        # after this one compare against this list, in this order.
        "inputSet": inputs,
        "inputTotal": round(got, 8),
        "sizeBytes": size,
        "plannedAtHeight": tip,
        "unsignedHex": raw,
        "prevtxs": prevtxs,
        "reason": reason,
        "part": part,
        "parts": parts,
    }


# ---------------------------------------------------------------------------
# sign -- runs where the key is, with no network
# ---------------------------------------------------------------------------

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _cli_base(args):
    """The wam-cli invocation the offline machine uses, without the method."""
    cli = [args.cli, "-chain=main", "-rpcconnect=%s" % args.rpcconnect,
           "-rpcport=%d" % args.port]
    if args.rpcuser:
        cli += ["-rpcuser=%s" % args.rpcuser, "-rpcpassword=%s" % args.rpcpassword]
    return cli + ["-stdin"]


def _offline_decode(args, raw_hex):
    """Decode a transaction on the signing machine, before anything is approved.

    The node's own parser, not one written here. A transaction decoder is
    exactly the kind of code that looks simple and has edge cases measured in
    consensus failures, and this machine is already about to ask the same node
    to sign -- so the dependency is not new, only used one call earlier.
    """
    proc = subprocess.run(_cli_base(args) + ["decoderawtransaction"],
                          input=raw_hex + "\n", capture_output=True, text=True)
    if proc.returncode != 0:
        die("the transaction in the plan could not be decoded: %s"
            % (proc.stderr.strip() or proc.stdout.strip()))
    try:
        return json.loads(proc.stdout)
    except ValueError as e:
        die("the decoded transaction could not be read: %s" % e)


# The private key's own arithmetic, checked before the key is used.
#
# This proved the base58check checksum and stopped there, which catches a
# mistyped character and nothing else. A key with a sound checksum can still be
# for another network, carry the wrong payload shape, or hold a scalar outside
# the curve's order -- and each of those fails at the node, after the key has
# been typed, on the one machine where retrying costs a walk to another room.
WAM_WIF_VERSION = 190            # mainnet, consensus; see chainparams.cpp
SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def _wif_problem(s):
    """None if this is a usable WAM mainnet private key, else why not.

    Pure arithmetic and two hashes. No node, no network, and the string does
    not leave this function.
    """
    if any(c not in _B58 for c in s):
        return "it contains a character that is not base58"
    n = 0
    for c in s:
        n = n * 58 + _B58.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    raw = bytes(len(s) - len(s.lstrip("1"))) + raw
    if len(raw) < 5:
        return "it is too short to be a key"
    body, check = raw[:-4], raw[-4:]
    if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != check:
        return ("its own checksum does not match, which means a mistyped or "
                "missing character")
    if body[0] != WAM_WIF_VERSION:
        return ("it is a private key for another network -- version byte %d, "
                "and WAM mainnet is %d" % (body[0], WAM_WIF_VERSION))
    payload = body[1:]
    if len(payload) == 33:
        if payload[-1] != 1:
            return "its compressed-key marker is wrong"
        payload = payload[:-1]
    elif len(payload) != 32:
        return "its payload is %d bytes, and a key is 32" % len(payload)
    scalar = int.from_bytes(payload, "big")
    if not 1 <= scalar < SECP256K1_N:
        return "the number in it is not a valid secp256k1 private key"
    return None


def cmd_sign(args):
    parts = max(1, int(getattr(args, "parts", 1) or 1))
    names = ([args.infile] if parts == 1
             else [_part_name(args.infile, i, parts)
                   for i in range(1, parts + 1)])
    plans = []
    for n in names:
        try:
            plans.append(json.load(open(n, encoding="utf-8")))
        except OSError as e:
            die("cannot read %s: %s. Nothing was signed." % (n, e))
        except ValueError as e:
            die("%s is not readable as a plan (%s). Nothing was signed."
                % (n, e))

    # ONE PAYMENT, OR IT IS NOT ONE SIGNING.
    #
    # The key is about to be typed once and used on every file in this batch.
    # That is only defensible if the batch is one payment: the same
    # destination, and no two parts spending the same coins. Both are checked
    # here, on this machine, because these files crossed removable media to
    # get here and this is the last place anything looks at them before a
    # signature exists.
    why = _batch_problem(names, plans)
    if why:
        die("%s Nothing was signed." % why)

    for n, plan in zip(names, plans):
        _sign_preflight(args, plan, n)

    print("=" * 66)
    print(" WHAT YOU ARE ABOUT TO SIGN")
    print("=" * 66)
    if len(plans) == 1:
        plan = plans[0]
        print("  paying       %s WAM" % wam(plan["amount"]))
        print("  to           %s" % plan["to"])
        print("  from         %s" % plan["from"])
        print("  change back  %s WAM" % wam(plan["change"]))
        print("  fee          %s WAM" % wam(plan["fee"]))
        print("  reason       %s" % plan.get("reason", "(none given)"))
    else:
        print("  paying       %s WAM in %d parts"
              % (wam(sum(p["amount"] for p in plans)), len(plans)))
        print("  to           %s" % plans[0]["to"])
        print("  from         %s" % plans[0]["from"])
        print("  fees         %s WAM in total"
              % wam(sum(p["fee"] for p in plans)))
        print("  reason       %s" % plans[0].get("reason", "(none given)"))
        print()
        for n, plan in zip(names, plans):
            print("    %s WAM   %4d inputs   fee %s   %s"
                  % (wam(plan["amount"]), plan["inputs"], wam(plan["fee"]),
                     os.path.basename(n)))
        print()
        print("  the key is asked for once and used on all %d" % len(plans))
    print("  verified             the bytes to be signed decode to exactly this")
    print("=" * 66)
    if input("  type the destination address again to confirm: ").strip() \
            != plans[0]["to"]:
        die("that is not the address in the plan; nothing was signed")

    wif = _ask_for_key()
    written = []
    try:
        for i, (n, plan) in enumerate(zip(names, plans), 1):
            out = (args.out if parts == 1 else _part_name(args.out, i, parts))
            _sign_one(args, plan, wif, out)
            written.append(out)
            if len(plans) > 1:
                print("  signed %d of %d -> %s" % (i, len(plans), out))
    finally:
        del wif

    print()
    print("  signed, and the key was not written anywhere.")
    if parts == 1:
        print("  carry %s back and run:" % written[0])
        print("      python3 scripts/treasury_spend.py broadcast --in %s" %
              os.path.basename(written[0]))
    else:
        print("  carry all %d files back and run:" % len(written))
        print("      python3 scripts/treasury_spend.py broadcast --in %s "
              "--parts %d" % (os.path.basename(args.out), parts))
    print("=" * 66)


def _batch_problem(names, plans):
    """Why these plans are not one payment, or None if they are.

    Pure: no node, no key, no file. Everything it judges is already in the
    files, and they crossed removable media to get here."""
    if len(plans) < 2:
        return None
    dests = sorted({p.get("to") for p in plans})
    if len(dests) != 1:
        return ("these %d parts pay %d different addresses (%s). That is not "
                "one payment and they are not signed together."
                % (len(plans), len(dests), ", ".join(str(d) for d in dests)))
    if dests[0] is None:
        return "a part does not name a destination at all."
    seen = {}
    for n, plan in zip(names, plans):
        inset = plan.get("inputSet")
        if not isinstance(inset, list) or not inset:
            return ("%s does not name the outputs it spends, so nothing can "
                    "tell whether it collides with the others."
                    % os.path.basename(n))
        for inp in inset:
            key = (inp.get("txid"), inp.get("vout"))
            if key in seen:
                return ("%s and %s both spend %s:%s. One of the two "
                        "signatures would be thrown away."
                        % (os.path.basename(seen[key]), os.path.basename(n),
                           key[0], key[1]))
            seen[key] = n
    return None


def _ask_for_key():
    """The key is read from the terminal, used, and never written down."""
    # getpass keeps it off the screen and out of the shell's history.
    # A TYPO IS CAUGHT HERE, NOT BY THE NODE, AND IT COSTS ONE RETRY.
    #
    # The key is typed by hand, from somewhere that is not on this machine,
    # into a prompt that shows nothing. Fifty-two characters, and one wrong
    # one used to end the run with "Invalid private key" from the node -- so
    # the whole command had to be started again, the address retyped, for a
    # single letter.
    #
    # A WIF carries its own base58check checksum, so a typo is detectable
    # right here with no node, no network and no key ever leaving this
    # function. Three tries, then it gives up rather than looping for ever.
    #
    # It does not prove the key is the TREASURY's -- that needs secp256k1 and
    # is the node's job. It proves the key is a key, which is what a typo
    # breaks.
    for attempt in range(3):
        wif = getpass.getpass("  treasury private key (WIF, not echoed): ").strip()
        if not wif:
            die("no key was given")
        why = _wif_problem(wif)
        if why is None:
            return wif
        left = 2 - attempt
        if left:
            print("  that key cannot be used: %s. %d try/tries left."
                  % (why, left))
    die("three unusable keys; nothing was signed")


def _sign_one(args, plan, wif, out):
    """Sign one plan with a key already in hand, and write the result."""
    # EVERYTHING GOES DOWN STDIN, NOTHING ON THE COMMAND LINE.
    #
    # Two reasons, and the first one is fatal on Windows. The transaction is
    # 29,974 bytes, which is 59,948 hex characters, and cmd.exe stops at
    # 8,191 for the whole line -- so the earlier version of this could not
    # run there at all. It failed with "the command line is too long" and the
    # founder was the one who noticed.
    #
    # The second is worse and was invisible: the key was an argv element, so
    # it sat in the process list where any program on the machine could read
    # it. wam-cli -stdin takes the arguments one per line instead, which
    # keeps the key out of argv entirely.
    cli = _cli_base(args) + ["signrawtransactionwithkey"]

    payload = "\n".join([plan["unsignedHex"],
                         json.dumps([wif]),
                         json.dumps(plan["prevtxs"])]) + "\n"
    proc = subprocess.run(cli, input=payload, capture_output=True, text=True)
    del payload
    if proc.returncode != 0:
        die("signing failed: %s" % (proc.stderr.strip() or proc.stdout.strip()))

    res = json.loads(proc.stdout)
    if not res.get("complete"):
        die("the transaction is not fully signed: %s" %
            json.dumps(res.get("errors", []))[:400])

    signed = dict(plan)
    signed["signedHex"] = res["hex"]
    signed.pop("prevtxs", None)          # no longer needed, and it is bulky
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(signed, f, indent=2)


def _sign_preflight(args, plan, name):

    # READ THE TRANSACTION BEFORE SHOWING ANYTHING, AND LONG BEFORE THE KEY.
    #
    # What this used to do: print plan["to"], plan["amount"] and the rest --
    # which are text fields in a JSON file -- ask the operator to type the
    # destination back, and then sign plan["unsignedHex"], which nothing had
    # decoded or compared against any of it.
    #
    # So the ceremony confirmed the LABEL and signed the PARCEL. If the two
    # ever disagreed -- a tampered file, a corrupted stick, a bug in `plan` --
    # the operator would read the correct address on screen, type it back
    # carefully, and sign something else. This file crosses an air gap on
    # removable media, which is precisely the journey the gap exists to make
    # safe, and this was the one place that trusted a label across it.
    #
    # Decoding needs the node, which this machine has -- it is about to ask it
    # to sign. Doing it first costs one RPC call and means the transaction is
    # read by something before it is approved by someone.
    #
    # Found by dang150296 (Urriki1502), 2026-10-04.
    decoded = _offline_decode(args, plan["unsignedHex"])
    _verify_against_plan(plan, decoded,
                         "the unsigned transaction in %s"
                         % os.path.basename(name))


# ---------------------------------------------------------------------------
# broadcast -- runs where the chain is, and checks before it sends
# ---------------------------------------------------------------------------

def cmd_broadcast(args):
    parts = max(1, int(getattr(args, "parts", 1) or 1))
    if parts == 1:
        return _broadcast_one(args, args.infile, Rpc(args.conf, port=args.port),
                              ask=not args.yes)

    # EVERY PART IS CHECKED AGAINST THE CHAIN BEFORE ANY PART IS SENT.
    #
    # The confirmation is asked once, because eight identical prompts for one
    # payment teach the operator to type SEND without reading. What replaces
    # them is that all eight are verified first -- plan match, destination,
    # amount, fee, and whether their inputs are still unspent -- so the one
    # question covers eight transactions that have each already passed every
    # check the single-file path applies.
    rpc = Rpc(args.conf, port=args.port)
    names = [_part_name(args.infile, i, parts) for i in range(1, parts + 1)]
    for n in names:
        _broadcast_one(args, n, rpc, ask=False, send=False)

    print()
    print("=" * 66)
    print("  %d part(s) verified against the chain, none sent yet." % parts)
    print("=" * 66)
    if not args.yes:
        if input("  type SEND to broadcast all %d: " % parts).strip() != "SEND":
            die("not sent")

    sent = []
    for n in names:
        sent.append(_broadcast_one(args, n, rpc, ask=False, send=True))
    print()
    print("  %d transaction(s) sent." % len(sent))
    return None


def _broadcast_one(args, infile, rpc, ask=True, send=True):
    try:
        signed = json.load(open(infile, encoding="utf-8"))
    except OSError as e:
        die("cannot read %s: %s. Nothing was sent." % (infile, e))

    # DECODE WHAT IS ACTUALLY THERE, not what the file claims.
    #
    # Between the two machines a file can be edited, swapped or corrupted.
    # The only defence is to read the transaction itself and compare it
    # against the plan, field by field, before it is sent anywhere.
    tx = rpc.call("decoderawtransaction", [signed["signedHex"]])

    # The same exact check the signer now makes, on the signed bytes this
    # time. Inputs in the approved order, outputs to the atom, fee conserved.
    # What follows it is the human-readable report, which stays because a
    # person should still see what is about to happen in words.
    _verify_against_plan(signed, tx, "the signed transaction")

    # AND ARE THOSE INPUTS STILL THERE?
    #
    # Everything above compares the transaction to the plan. Nothing asked the
    # chain whether the outputs the plan selected are still unspent -- and
    # between planning, carrying the file to another room, signing it and
    # carrying it back, they can stop being. A transaction spending one that
    # is gone is rejected by every node, after the key has been used.
    #
    # gettxout with include_mempool=true is the question, asked for every
    # input immediately before the send rather than once at the start.
    missing = []
    live_total = 0
    for txid, vout in _outpoints(signed.get("inputSet", []), "the plan"):
        entry = rpc.call("gettxout", [txid, vout, True])
        if not entry:
            missing.append("%s:%d" % (txid, vout))
        else:
            live_total += _atoms(entry.get("value"), "a live input value")
    if missing:
        die("%d of the inputs this spends are no longer unspent -- the first "
            "is %s. Nothing was sent; re-run `plan`." % (len(missing), missing[0]))
    if live_total != _atoms(signed["inputTotal"], "the input total"):
        die("the inputs are worth %s WAM on the chain now, and the plan said "
            "%s. Nothing was sent." % (wam(live_total / 1e8), wam(signed["inputTotal"])))

    paid = {}
    for o in tx["vout"]:
        addr = o["scriptPubKey"].get("address")
        if addr:
            paid[addr] = round(paid.get(addr, 0.0) + float(o["value"]), 8)

    want_to = round(float(signed["amount"]), 8)
    want_change = round(float(signed["change"]), 8)

    problems = []
    if signed["to"] not in paid:
        problems.append("it does not pay %s at all" % signed["to"])
    elif paid[signed["to"]] != want_to:
        problems.append("it pays %s WAM to %s, the plan said %s"
                        % (wam(paid[signed["to"]]), signed["to"], wam(want_to)))
    if want_change > 0:
        if paid.get(TREASURY, 0.0) != want_change:
            problems.append("change is %s WAM, the plan said %s"
                            % (wam(paid.get(TREASURY, 0.0)), wam(want_change)))
    for addr in paid:
        if addr not in (signed["to"], TREASURY):
            problems.append("it pays an address in neither the plan nor the "
                            "treasury: %s" % addr)
    if len(tx["vin"]) != signed["inputs"]:
        problems.append("it spends %d inputs, the plan said %d"
                        % (len(tx["vin"]), signed["inputs"]))

    total_out = round(sum(paid.values()), 8)
    fee = round(float(signed["inputTotal"]) - total_out, 8)
    if abs(fee - float(signed["fee"])) > 0.00000001:
        problems.append("the fee works out at %s WAM, the plan said %s"
                        % (wam(fee), wam(signed["fee"])))

    print("=" * 66)
    print(" WHAT THE SIGNED TRANSACTION ACTUALLY DOES")
    print("=" * 66)
    for addr, amt in sorted(paid.items(), key=lambda kv: -kv[1]):
        tag = "  <- the destination" if addr == signed["to"] else \
              "  <- back to the treasury" if addr == TREASURY else "  <- UNEXPECTED"
        print("  %s WAM  %s%s" % (wam(amt), addr, tag))
    print("  fee                %s WAM" % wam(fee))
    print("  inputs             %d" % len(tx["vin"]))
    print("  txid               %s" % tx["txid"])
    print("=" * 66)

    if problems:
        print()
        for p in problems:
            print("  MISMATCH  %s" % p)
        die("the signed transaction does not match the plan. Nothing was sent.")

    print("  every field matches the plan, and its inputs are still unspent.")
    if not send:
        return None
    if ask:
        if input("  type SEND to broadcast it: ").strip() != "SEND":
            die("not sent")

    txid = rpc.call("sendrawtransaction", [signed["signedHex"]])
    print()
    print("  broadcast. txid %s" % txid)
    print()
    print("  Publish it: the amount, the reason and this txid. That is the")
    print("  promise in SECURITY.md and in docs/TREASURY_CUSTODY.md, and it")
    print("  is a row in docs/TREASURY_LEDGER.md before it is a sentence")
    print("  anywhere else.")
    return txid


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="build the unsigned transaction (online)")
    p.add_argument("--to", required=True)
    p.add_argument("--amount", required=True, type=float)
    p.add_argument("--reason", required=True,
                   help="one line, and it will be published with the txid")
    p.add_argument("--conf", default="/root/.wam-mainnet/wam.conf")
    p.add_argument("--port", type=int, default=9554)
    p.add_argument("--out", default="treasury-plan.json")
    p.add_argument("--exclude", action="append", metavar="PLAN.JSON",
                   help="a plan written earlier in this sitting whose inputs "
                        "this one must not take. Repeat it once per plan. "
                        "Use it when several people are paid before anything "
                        "is broadcast, because until a transaction is sent "
                        "the mempool cannot warn anybody about it.")
    p.add_argument("--parts", type=int, default=1,
                   help="cut the payment into N equal parts from ONE scan, "
                        "with no output offered twice; --amount is the "
                        "amount of each part")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("sign", help="sign it where the key is (offline)")
    p.add_argument("--in", dest="infile", default="treasury-plan.json")
    p.add_argument("--out", default="treasury-signed.json")
    p.add_argument("--cli", default="wam-cli")
    p.add_argument("--rpcconnect", default="127.0.0.1")
    p.add_argument("--port", type=int, default=9554)
    p.add_argument("--rpcuser", default="")
    p.add_argument("--rpcpassword", default="")
    p.add_argument("--parts", type=int, default=1,
                   help="sign N parts in one sitting; the key is asked for "
                        "once and used on all of them")
    p.set_defaults(func=cmd_sign)

    p = sub.add_parser("broadcast", help="check it, then send it (online)")
    p.add_argument("--in", dest="infile", default="treasury-signed.json")
    p.add_argument("--conf", default="/root/.wam-mainnet/wam.conf")
    p.add_argument("--port", type=int, default=9554)
    p.add_argument("--yes", action="store_true", help="skip the typed confirmation")
    p.add_argument("--parts", type=int, default=1,
                   help="verify N parts against the chain, then send them "
                        "after one confirmation")
    p.set_defaults(func=cmd_broadcast)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
