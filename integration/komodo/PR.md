add a third electrum server for WAM

One file, one entry: `electrums/WAM` gains `wam.zcd.lol`. Nothing else is
touched, and the coin entry is not reopened.

The two servers already in this file are both ours. A wallet reading WAM has
therefore had no route to the chain that does not pass through one operator,
and two servers under one operator fail together. That is measured here rather
than feared: on 1 November the same stale binaries were found on all three of
our machines at once, and the check that compares them to each other reported
agreement -- correctly, because they were wrong identically.

`wam.zcd.lol` is run by cup, who is not us, in Seoul on Vultr. It was built
with this project's own `integration/electrumx/install.sh --network mainnet`,
and runs `wamd` v0.1.13 from the signed release with SHA256SUMS verified.

Verified from outside his machine rather than taken on his word, 2 November
2026:

  wam.zcd.lol -> 158.247.220.175   50002 SSL / 50001 TCP / 50004 WSS
  tip 33344, block-identical to our node and to both existing servers
  genesis d8d3debea987b62a0934c3980d62bffbb6e16aa797d19891d4fcc9b9fb11d7e9
          identical to the assert in src/wam/chainparams.cpp:483
  server.features advertises wss_port 50004, so the web wallet has its port
  certificate Let's Encrypt, CN wam.zcd.lol, notAfter 2027-01-31, publicly
          trusted, with a renewal hook installed so that a renewal reloads
          the server instead of leaving a stale certificate serving

The genesis comparison is the one that matters: a server on the wrong network
answers every other call perfectly. `scripts/check_electrum.py` makes it, and
the new server sits in our sweep and our operations panel as a row of its own,
separate from the row that judges our own two. A reboot of a machine we do not
own must not read as a fault of ours, and a red line nobody can act on is how
people learn to ignore red lines. It can still fail, and it has to: this entry
advertises the endpoint, so a wallet told a wrong balance by it was sent there
by us.

The contact on the new entry is his, in the order he asked for: Discord first,
because that reaches him fastest, and the email as the fallback when it is
quiet.

Source:   https://gitlab.com/WAMCoin/wam-coin
          https://github.com/wamcoin-Project/wam-coin
          https://gitea.com/WAMCoin/wam-coin
Explorer: https://explorer.wamcoin.org
Site:     https://wamcoin.org  https://wamcoin.net
