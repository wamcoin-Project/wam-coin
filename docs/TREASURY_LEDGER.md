# Treasury ledger

Every coin that leaves the treasury, with the amount, the reason and the
transaction id. Nothing else belongs here and nothing is left out of it.

`docs/TREASURY_CUSTODY.md` promised this and named what it must contain:
*every sweep: the transaction id, the amount, the resulting balance · monthly:
what was spent and on what, in one short note · never: a key, a descriptor, or
a photograph of any part of either.*

**The address, so nothing here needs to be taken on trust:**

    WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE

Check any line below against your own node:

    wam-cli getrawtransaction <txid> true
    wam-cli scantxoutset start '["addr(WdMMqW1DcgWZ6HtyJuEMdce6QkKg4raGmE)"]'

The second command answers with the balance as the chain holds it. If it
disagrees with the last line of this table, this file is wrong and the chain
is right.

---

## The arithmetic anyone can repeat

Consensus rule WAM-1 pays the treasury 5% of the block subsidy — 2.5 WAM per
block at the current subsidy — once per block, for heights 1 to 400,000. So
the balance at any height is:

    2.5 × height  −  (every amount below + every fee below)

The fee has a column of its own because a spend costs the treasury what it
sent *and* what it paid to send it. A fee left out of the arithmetic is a
number this file cannot be checked against, which defeats the point of it.

At height 37,300 that is `2.5 × 37300 − 32,000.00000000 − 0.38078440 =
61,249.61921560`, which is what `scantxoutset` returns, in 24,483 unspent
outputs. Two independent routes to the same number, to the last decimal
place.

---

## Spends

| date | amount | fee | to | reason | txid |
|---|---|---|---|---|---|
| 2026-09-22 | **500.00000000 WAM** | `0.00599480` | `WgsySSWQr1tRyjwj3S53XbiVz9yEUCCK9t` | Coin for an atomic-swap test on GLEEC PR #2034, at the maintainer's own request. Not a listing fee: none was asked for and none was paid, and the decision to merge is his. | txid `ac06a7af6d87eed56fda28898e483d67b1033365f4d5f744e59ec5f80b5f0605` |
| 2026-10-01 | **10.00000000 WAM** | `0.00019320` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Security bounty to chovy, accepted 16 September 2026: the pool accounting finding — the same pending block could mature more than once, crediting miner balances twice out of the operator's own wallet, plus two further manifestations of the same fault. Classified at 10,000 WAM under the tiers published at the time. Paid in nine transactions because consensus pays the treasury 2.5 WAM per block, so its balance is thousands of small outputs: 10,000 in one transaction would be about 4,000 inputs and 590 KB, six times the standard size limit, which no node would relay. 1 of 9 — the test payment, sent first and confirmed received before the rest. | txid `871e0f9e6e431ba2bae5a35777a8f739c83b8ceafc55a4fe94c5317a3262b5bd` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 2 of 9. | txid `a52d1d2f77ca2160d3126aaa41d1dc2a3ede4d23acf6661f0d7cd51b58b69f51` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 3 of 9. | txid `7f34f4e1e07e01b12595a6d74bf511003f06422d2e26e1b51a04948840d3f1d4` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 4 of 9. | txid `b0031f8c0ee779e2d2d4a20d30c763b0b482d6b7b3c55386264395eec78a13af` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 5 of 9. | txid `1692852e9ce0063b77b1ec81924017dfce1406fda5a68cb80e70c57196b39899` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 6 of 9. | txid `390d112403b914545f721d4328b032c7ae2d7a019ff7b96948ca7da16575e9fc` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 7 of 9. | txid `1bfef00cf093fdbdfb04e23f3d2c2ed261fec4160db06a09598117425501ca04` |
| 2026-10-01 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 8 of 9. | txid `e8ace6f3a2a951e24be887d7a10b8773e9b4269e4911dd5ce43256d95029a666` |
| 2026-10-02 | **1248.75000000 WAM** | `0.01484520` | `WcQCFiCzwikQTTmPeafn73e3asC32ofyLr` | Same bounty, 9 of 9. | txid `7c87c49a9bd35d0b75d4271febb3cb864d104068285bafbc4ab8f6b59ae19fa3` |
| 2026-10-11 | **10.00000000 WAM** | `0.00019320` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Security bounty to Alboy, findings WAM-F5 and WAM-F6, accepted 11 October 2026. WAM-F5 is the pool crediting one RandomX solution once per live job instead of once; WAM-F6 is a consensus field that no network assigned, read in three consensus paths. Classified at 10,000 WAM for WAM-F5 under the published tiers. WAM-F6 sits in the hardening rung at 250 WAM and has not been claimed. 1 of 9 — the test payment, sent first and confirmed received before the rest. | txid `a2754907f887e65bbafffed62564e5ac4848962e99afad6a01760be1011b54b0` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 2 of 9. | txid `ccd6de28e9b31a2e209749250736729ad04205a05152f97cf4506ac9ce60d3be` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01481560` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 3 of 9. | txid `38fb1bc2156e0b89dd50f8a33a8011ce578147d3b3351c7b4b45d87a7a2acfa7` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 4 of 9. | txid `1f9cce2a6f7673776fcb9d00c224fafd1a7ab316ed1d830a997d178bc15371b6` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 5 of 9. | txid `f45a75635195a6acbe035038bedff52d9264ca52b2ac4dc0d751bdcc181901ff` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 6 of 9. | txid `2570f0c5799ce0aa010942c8427db500ed6c2f988311797876b0227b45eb2535` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 7 of 9. | txid `0495e63eaeb38e1e5992c9501fe13a4ff45ef8edc9ecff078c3670c8d9d4d61b` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 8 of 9. | txid `7436e0bd60b0374df73e600959d47c7d3481dac60a40f0ac03560a833d0f9efc` |
| 2026-10-11 | **1248.75000000 WAM** | `0.01484520` | `WZSY6XFjmsef7Xb2E7DLhnkeU44bYyTLrA` | Same bounty, 9 of 9. | txid `b5d7710f76e7f247625cd04da5b1e7a3dc5c64f454f7bcf05dbcec7c2d851266` |
| 2026-10-13 | **1000.00000000 WAM** | `0.01191480` | `wam1q03z5vzzkz03a5nq986y9n49u6ku28rvcw5p0mz` | Security bounty to Smooth Jazz Crypto (@smoothjazcrypto), accepted 12 October 2026: the pool deleted a matured block from its pending state before writing any durable record of it, and the round's shares are deleted when that state is written — so an interruption between the two destroyed the only surviving statement of what each miner was owed. Classified at 1,000 WAM under the denial-of-service rung, as a judgement: the mechanism is the credit ledger, the impact is one block in a window no attacker can cause. One transaction, 402 inputs. | txid `867bffa18cafda9a82349125a2c1e15828a095ffe584b44dfa63d90d722dab70` |
| 2026-10-15 | **250.00000000 WAM** | `0.00303480` | `WRRXkrgxGkhePeBgFf4Xn1LYP8HfGKPzGh` | Security bounty to ahten (@ahteen66), accepted 15 October 2026: `addressToScript` in `pool/lib/util.js` tested whether an address looked like bech32 before trying to decode it as base58, so about one valid base58 address in twenty was refused as a segwit address for another chain -- including this treasury address itself, which decodes cleanly as version 73. A miner whose address matched was disconnected at `mining.authorize`; an operator whose `poolAddress` matched could not start his pool. No funds were at risk. The same fault had been fixed in the miner on 19 September and the pool was never updated with it. Classified at 250, the hardening rung, which is where the reporter classified it. One transaction of 102 inputs, in block 21,114. | txid `2ba6139518819ffeee0a15d4075680f04fa00a4730859cbe206ea4b1c57c2d12` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Security bounty to bobbyning, accepted 7 November 2026: the pool broadcast a payment, wrote its in-flight marker, and then committed the balance decrements in an ioredis pipeline — whose `exec()` resolves with the per-command error rather than throwing it. A failed commit therefore left every balance standing, nothing paused, and the next run ten minutes later paid the same miners again from the same balances. The marker written for exactly this was read in one place, `startupReconcile`, so it only ever spoke after a restart. Classified at 10,000 WAM under the published tiers, which is where the reporter classified it, plus 250 at the hardening rung for a separate finding: a share whose accounting failed was answered `valid:true` on its first submission, so the miner was told accepted while his work was credited to nothing. Paid in ten transactions because consensus pays the treasury 2.5 WAM per block and it is never consolidated, so its balance is thousands of small outputs: 10,250 in one transaction would be about 4,100 inputs and 591 KB, six times the standard size limit, which no node would relay. All ten are in block 37,299. 1 of 10. | txid `e8885d4fe2535f00afa121b8890390a0c2180f7924d24bfdb58e2b151e4651b3` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 2 of 10. | txid `3e7d1d74bd82b089afbaeb938774345e83c4e6ab6fca1069acadf11ab754bbd9` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 3 of 10. | txid `578ebaef27ae2edd451b7e68733cef3d7da289600c403cdec1ccce81514f082a` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 4 of 10. | txid `cc774c4ffff0bdfc10d41a0fa9862d7bb6f5fde66c7b5a918dc2d6f5e6b1d102` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 5 of 10. | txid `e4ec12c4a3a15603a325f3d7089809cc632f0fc2320686124a453c5e400871e1` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 6 of 10. | txid `f5d87fafb5284aeca83ea5931b91ee268f2971a477225af482d18393f38aebac` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01218120` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 7 of 10. | txid `d616a50b1f7464d0dea9181b332a566013dacb91ddfb55c61634680536876a6b` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01209240` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 8 of 10. | txid `c0cbd210bfb31481fefa2e85258899c17f1f9cad81af5a13679a46c72a6c26dd` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 9 of 10. | txid `4a7cdfad30e52783a34f898771ac7b518e8b9e02a5dd19b8f2620804ed11e95b` |
| 2026-11-08 | **1025.00000000 WAM** | `0.01221080` | `wam1qt54j2luencxehpq89n9ta4csfq3qq00t274w5e` | Same bounty, 10 of 10. | txid `b51311e341bcbbc1fa5e0b3a77e39874cddd9e827107e64cacea3fea29cfa509` |

The treasury is paid one output per block and never consolidated, so every
spend above is built from 2.5 WAM outputs and nothing else: the 500 WAM line
took 202 of them and 29,974 bytes, and each 10 WAM line takes 6 and 960. That
is also why a bounty leaves in instalments rather than at once — 10,000 WAM in
one transaction is about 4,000 inputs and 590 KB, six times the standard size
limit, and no node would relay it.

**Balance after the last line:** `61,249.61921560 WAM` in 24,483 unspent
outputs, at height 37,300.

---

## What this was, and what it was not

The 2026-09-22 line is the **first movement of the treasury since block 1**.
Until that day every coin WAM-1 had ever paid it was still sitting where it
arrived — 4,946 outputs, none of them spent, which anybody could and did
verify. Everything after it is a security bounty, and there has been nothing
else.

It was not a payment for a listing. The rule against those is in
`docs/LISTING_PACKAGE.md` and has not changed: this project does not pay a
platform to be listed. What was sent is the coin needed to *run* a test — a
maintainer who holds none of a coin cannot trade it against anything — and he
asked for it himself, in public, on a pull request he had opened and fixed on
his own initiative.

## How it was signed

The treasury is a single key until the 2-of-3 arrangement exists, so the key
never touched a networked machine:

1. the transaction was built on the node, where the chain is
2. it was signed on a machine with its network interface switched off
3. the signature was carried back and broadcast

`scripts/treasury_spend.py` does the three steps and refuses to send a signed
transaction whose destination, amount, change address, input count or fee
disagrees with the plan it was built from.

## Still outstanding

**The first sweep to a 2-of-3 address is due 2026-09-29**, fourteen days after
launch, as `docs/TREASURY_CUSTODY.md` states. It has not happened. Until it
does, this balance sits behind one key, and that is written here rather than
left for someone to notice.
