# The operations dashboard

Double-click `start.cmd`, or:

```bash
python3 ops/ops.py
```

Then open <http://127.0.0.1:9787>.

---

## Why it runs on your own machine

A monitoring page says which service is down, which machine is short of
memory, what hour the backup runs and which node is behind. That is what
makes it useful to you, and the same page is a map for anyone who wants to
attack the network: it names the weak machine and the unwatched hour.

Served from a server it would need a public address, a password, TLS, and it
would be one more door into a machine that holds money. Run here it needs
none of those, because it is not on the internet at all. It binds to
`127.0.0.1`, which nothing outside this laptop can reach — not the café
wifi, not the router, not anyone.

It runs read-only commands over the ssh key already on this machine. It
writes nothing to any server, stores no credential, and opens no port beyond
the loopback.

Port **9787**, not the obvious 8787: that one is already taken on this
laptop by another application, and a dashboard that silently shows somebody
else's page is worse than one that refuses to start.

---

## The four rules against lying

A green panel over a broken system is worse than no panel, because it buys
calm that was not earned. This project has had exactly that three times in
one day: a sweep reporting *21 passed* while the backups had been dead for
three days; a version check going green because the one outdated node
happened to be offline in that minute; and two measurements that reported
the wrong answer about something that was working perfectly.

So:

1. **Every value carries the moment it was measured.** Not "backups ok" but
   "backups, 6h ago". A stale number shown as current is the ordinary way a
   dashboard lies.
2. **Unreachable is not healthy.** A host that cannot be reached goes grey
   and says when it was last tried and what the failure said, rather than
   holding its last good reading and looking fine.
3. **The page shows its own age.** If the collector dies the page freezes,
   and the age at the top is what tells you — not the stillness, which looks
   identical to a quiet night.
4. **Nothing is inferred.** What was not measured is not displayed, and a
   check that could not run says so instead of being counted as a pass.

---

## Where it gets the truth

It runs the repository's own check scripts — the same ones `scripts/sweep.sh`
runs — and keeps their exit status and their output. It does not
reimplement them.

That is deliberate. Two implementations of the same check will disagree one
day, and on that day you will not know which to believe.

Fast facts (heights, peers, services, memory, disk, backup age) are gathered
every minute in a single ssh round trip per host — one call rather than ten,
because ten calls take ten times as long and can contradict each other, the
machine having changed in between. The heavier checks run every fifteen
minutes.

---

## What it deliberately does not shout about

- A **mainnet unit that is inactive** before 15 September is correct, not
  broken. It is shown faint, not red.
- A **service that was never installed** on that host — the pool runs on one
  machine — is not shown at all. Saying "pool: inactive" in red on the other
  machine every day is how a person learns to stop reading red.

A dashboard that cries about things that are fine is a dashboard nobody
reads, and then it is worth less than nothing, because you believe you are
being watched.


---

## And the one that comes to you

The dashboard waits to be opened. `scripts/daily_report.py` does not: it
runs on the Germany server every morning at 06:00 UTC and sends one message
to a private Telegram chat.

    systemctl status wam-report.timer     # on the pool host

The two are the same idea pointed in opposite directions, and neither
replaces the other:

| | |
|---|---|
| the dashboard | what you look at |
| the report | what wakes you |

Each report carries a **sequence number**. If #12 arrives and then #14, then
#13 never came, the machine that sends them was down, and the gap is the
alarm. Silence is the one failure a monitor cannot report on its own.

It reads the other machine through a key that Singapore accepts only with a
forced command -- `/usr/local/bin/wam-facts`, which prints status and
changes nothing. Asked for a shell, or for `/etc/shadow`, sshd ignores the
request and runs the facts script instead. That was tested, not assumed.

It ends by naming what it cannot see from one server, rather than letting
absence read as health. Those are the checks the sweep runs from here.
