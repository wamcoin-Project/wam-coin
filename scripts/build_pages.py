#!/usr/bin/env python3
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  build_pages.py -- the documents we already have, as pages people can read
# ===========================================================================
#
#      python3 scripts/build_pages.py
#
#  WHY THIS EXISTS
#
#  Everything worth reading about WAM lived at addresses nobody says out loud:
#
#      github.com/wamcoin-Project/wam-coin/blob/main/docs/START_HERE_AR.md
#
#  It is long, it looks like a filename, and it asks a reader to be
#  comfortable on GitHub before anyone has told them what a node is. So the
#  guide became wamcoin.org/start, and this now does the same for the rest.
#
#  WHY IT MATTERS BEYOND CONVENIENCE
#
#  On 4 September 2026 the founder searched Google for `wamcoin` and found the
#  gaming token, a Nigerian dairy, a Maldivian waste company and a futsal
#  match ahead of us. Our own site was not on the first three pages. Part of
#  that is a one-month-old domain and nothing fixes it but time -- but part of
#  it is that wamcoin.org was three URLs. A site with three pages gives a
#  search engine almost nothing to rank, and we were sitting on a whitepaper,
#  a build guide, a pool guide and a rehearsal record, all of them written,
#  none of them a page.
#
#  WHY GENERATED AND NOT WRITTEN
#
#  A second copy of a document is a document that will disagree with the
#  first. That has happened here twice: the site's Arabic footer denied two
#  reviewers weeks after the English half was corrected, and both guides told
#  people to download a release whose binaries had been deleted.
#
#  So the markdown stays the only source. Editing a page means editing the
#  document.
#
#  THE LINK REWRITING IS THE PART THAT WAS BROKEN
#
#  The previous version rewrote exactly two link targets, the ones between the
#  two guides. Every other relative .md link was emitted unchanged, so the
#  live /start/ page carried three links that returned 404 -- the whitepaper,
#  the build guide and the pool guide -- on the page we send every newcomer
#  to. It had been that way since the page was published, and it was found by
#  fetching them, not by reading the generator.
#
#  Now every .md link is resolved relative to its own source file and then
#  either mapped to the page built from it, or rewritten to the file on
#  GitHub. Neither outcome is a 404, and check_page_links() refuses to finish
#  if one slips through.
# ===========================================================================

import html
import pathlib
import re
import subprocess

# ===========================================================================
#  THE ONE PLACE THE SITE NAMES ITSELF
# ===========================================================================
#
#  This project publishes two domains in every post, and the second one is
#  not decoration: it is the way back if the first is ever lost. wamcoin.net
#  is meant to stand on its own rather than bounce visitors to wamcoin.org --
#  a redirect dies with the thing it points at, and is no insurance at all.
#
#  The pages were already built for that without anyone planning it: every
#  link a reader clicks is relative, 106 of them, so a visitor who arrives on
#  one domain stays on it. What was NOT ready was this file, which wrote
#  "wamcoin.org" into eight separate places. Changing the site's name meant
#  finding all eight and hoping.
#
#  canonical, og:url and the sitemap must name ONE domain -- that is what
#  those tags are for, and two names for one page is the thing they exist to
#  prevent. So this is not a list of domains. It is the single name they all
#  read, so that the day it has to change, it changes once.
#
#  Not in the download commands, which are a separate decision: a reader on
#  wamcoin.net who copies `curl https://wamcoin.org/...` is downloading from
#  the other domain, and if that one is gone he has a live page describing a
#  dead download. Serving /downloads/ from both names is the honest fix and
#  it is not made here.
# ===========================================================================
CANONICAL_ORIGIN = "https://wamcoin.org"
CANONICAL_HOST = CANONICAL_ORIGIN.split("//", 1)[1]
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "lib"))
import quoted  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parent.parent
# Where "read the source of this page" points.
#
# It was GitHub until 2026-09-24, when the account was suspended and every
# one of these links on every page became a 404 -- including the ones telling
# a reader where to check the signing fingerprint for himself. The canonical
# repository is GitLab now; GitHub is a mirror if it ever returns.
SOURCE_BROWSE = "https://gitlab.com/WAMCoin/wam-coin/-/blob/main/"

# source, output dir, lang, dir, title, meta description, og description
PAGES = [
    ("docs/START_HERE.md", "site/start", "en", "ltr",
     "Start here — WAM Coin",
     "How to run a WAM Coin node, for someone who has never run one.",
     "Run a node in four commands, with the checksum step that most guides skip."),

    ("docs/START_HERE_AR.md", "site/start-ar", "ar", "rtl",
     "ابدأ من هنا — WAM Coin",
     "كيف تُشغّل عقدة WAM، لمن لم يُشغّل عقدةً من قبل.",
     "شغّل عقدةً بأربعة أوامر، مع خطوة التحقّق التي تتخطّاها أغلب الأدلّة."),

    ("docs/MINE.md", "site/mine", "en", "ltr",
     "Mine WAM — nine lines",
     "The shortest correct way to start mining WAM Coin: nine commands, no "
     "explanation.",
     "Nine commands and nothing to read. Written because a tester said his "
     "friends wanted the shortest way to start, and the guide is the wrong "
     "shape for that."),

    ("WHITEPAPER.md", "site/whitepaper", "en", "ltr",
     "Whitepaper — WAM Coin",
     "Why WAM's money works the way it does: a 22,000,000 cap, RandomX proof "
     "of work, and a founder reserve locked in the genesis block itself.",
     "The monetary design in full — emission, the treasury that ends, and a "
     "premine that consensus refuses to release early."),

    ("SECURITY.md", "site/security", "en", "ltr",
     "Security — WAM Coin",
     "How to verify a WAM release, the signing key fingerprint, and how to "
     "report a vulnerability.",
     "Every release is signed with an offline key. One command checks it, and "
     "refuses to say ok for the wrong reasons."),

    ("docs/BUILD.md", "site/build", "en", "ltr",
     "Build from source — WAM Coin",
     "Compile WAM Coin yourself instead of trusting a binary anybody handed "
     "you.",
     "Build the node and the miner from source, on Linux, with the exact "
     "dependencies and nothing else."),

    ("docs/POOL_OPERATOR.md", "site/pool", "en", "ltr",
     "Run a mining pool — WAM Coin",
     "How to run a WAM Coin stratum pool for other miners.",
     "Everything needed to host a pool: ports, payout handling, and the "
     "failure modes that cost other pools money."),

    ("docs/REHEARSALS.md", "site/rehearsals", "en", "ltr",
     "Launch rehearsals — WAM Coin",
     "One rehearsal a day until launch, and a published record of what each "
     "one found.",
     "What every launch rehearsal found, including the days that found "
     "nothing. The rate is the only honest measure of ready."),
]

# A .md path, as it appears in the repository, and the page built from it.
# Anything not here is rewritten to GitHub rather than left to 404.
LINKMAP = {src: "/" + outdir.split("/", 1)[1] + "/"
           for src, outdir, *_ in PAGES}
LINKMAP["CHANNELS.txt"] = "/CHANNELS.txt"

CSS = """
:root{--bg:#faf9f7;--fg:#1a1a1a;--dim:#5c5a57;--rule:#e3e0db;--code:#f2f0ec;--accent:#8a6d1f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0e1211;--fg:#eceae7;--dim:#9a9691;--rule:#242a29;--code:#171d1c;--accent:#c9a94a}}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);margin:0;padding:2.2rem 1.1rem 5rem;
 font:16px/1.72 ui-serif,Georgia,"Times New Roman",serif;-webkit-text-size-adjust:100%}
main{max-width:44rem;margin:0 auto}
h1{font-size:1.85rem;line-height:1.25;margin:0 0 .4rem;letter-spacing:-.01em}
h2{font-size:1.28rem;margin:2.6rem 0 .7rem;padding-top:1.1rem;border-top:1px solid var(--rule)}
h3{font-size:1.06rem;margin:1.8rem 0 .5rem}
p,li{margin:.75rem 0}
a{color:inherit;text-decoration:underline;text-underline-offset:2px;text-decoration-color:var(--accent)}
code{background:var(--code);padding:.12em .38em;border-radius:3px;
 font:13.5px/1.5 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;word-break:break-word}
pre{background:var(--code);padding:.95rem 1.05rem;border-radius:6px;overflow-x:auto;
 border:1px solid var(--rule)}
pre code{background:none;padding:0;white-space:pre}
blockquote{margin:1.1rem 0;padding:.1rem 0 .1rem 1rem;border-inline-start:3px solid var(--accent);color:var(--dim)}
table{border-collapse:collapse;width:100%;margin:1.1rem 0;font-size:.94rem;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--rule);padding:.5rem .6rem;text-align:start}
th{font-weight:600}
hr{border:0;border-top:1px solid var(--rule);margin:2.2rem 0}
/* The mark, on every page. A reader who meets WAM in a search result should
   have seen the same coin four times before they read the name. */
.mast{display:flex;align-items:center;gap:.7rem;margin-bottom:1.4rem}
.mast img{width:44px;height:44px;flex:none;border-radius:50%}
.mast .wordmark{font-weight:600;letter-spacing:-.01em;font-size:1.05rem}
.mast .wordmark span{display:block;font-size:.8rem;font-weight:400;color:var(--dim);
 letter-spacing:0}
.top{display:flex;gap:1rem;flex-wrap:wrap;font-size:.9rem;color:var(--dim);
 margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid var(--rule)}
.foot{margin-top:3.5rem;padding-top:1.2rem;border-top:1px solid var(--rule);
 font-size:.87rem;color:var(--dim)}
[dir=rtl]{font-family:ui-serif,"Noto Naskh Arabic","Amiri",Georgia,serif}
[dir=rtl] pre,[dir=rtl] code{direction:ltr;text-align:left}
"""


def esc(s):
    return html.escape(s, quote=False)


def resolve_link(target, src):
    """A markdown link target, as the site should serve it.

    `target` is written relative to `src`, which is why POOL_OPERATOR.md in
    docs/START_HERE.md means docs/POOL_OPERATOR.md and not the repository
    root. Getting that wrong is how the live page ended up linking to
    wamcoin.org/start/POOL_OPERATOR.md, which has never existed.
    """
    if re.match(r"^(https?:|mailto:|#|/)", target):
        return target
    frag = ""
    if "#" in target:
        target, frag = target.split("#", 1)
        frag = "#" + frag
    if not target:
        return frag
    # Resolve against the source's own directory.
    base = pathlib.PurePosixPath(src).parent
    path = str((base / target)).replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    parts = []
    for p in path.split("/"):
        if p == "..":
            if parts:
                parts.pop()
        elif p not in ("", "."):
            parts.append(p)
    path = "/".join(parts)
    if path in LINKMAP:
        return LINKMAP[path] + frag
    if path.endswith(".md"):
        return SOURCE_BROWSE + path + frag
    return SOURCE_BROWSE + path + frag if "/" in path or "." in path else target + frag


def inline(s, src):
    """Inline markdown: code, bold, italics, links. Code first, so nothing
    inside a code span is reinterpreted."""
    spans = []

    def stash(m):
        spans.append(f"<code>{esc(m.group(1))}</code>")
        return f"\x00{len(spans)-1}\x00"

    s = re.sub(r"`([^`]+)`", stash, s)
    s = esc(s)
    s = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)",
               lambda m: f'<a href="{resolve_link(m.group(2), src)}">{m.group(1)}</a>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", s)
    return re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], s)


def convert(md, src, marked=()):
    """`md` as HTML. `marked` is the set of line indices the author marked as
    quotation, and every block built from one of them carries the mark out.

    See the note in build() for why it is carried rather than dropped.
    """
    out, lines, i = [], md.split("\n"), 0
    marked = set(marked)

    def mark(start, end, block):
        """`block`, with the quotation mark on it if its source was marked.

        It goes on the block AFTER conversion, never through inline() or
        esc() -- which is what turned `<!-- ... -->` into visible text the
        first time this was attempted.

        A one-line mark covers one line, and a <pre> block is many: quoted.py
        reads a file line by line, so an end-of-line mark on a code block
        covered its LAST line and left the rest unmarked. docs/REHEARSALS.md
        marks a rehearsal log that names the retired testnet port, and
        check_published_endpoints.py read that port off the generated page as
        a live instruction. A multi-line block therefore gets the region form
        of the mark, which is what regions are for.
        """
        if not any(n in marked for n in range(start, end)):
            return block
        if "\n" in block:
            return ("<!-- wam:quote-begin -->\n" + block
                    + "\n<!-- wam:quote-end -->")
        return block + " <!-- wam:quote-line -->"

    while i < len(lines):
        ln = lines[i]
        start = i

        if ln.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i]); i += 1
            i += 1
            out.append(mark(start, i, "<pre><code>" + esc("\n".join(buf)) + "</code></pre>"))
            continue

        if re.match(r"^\s*(-{3,}|\*{3,})\s*$", ln):
            out.append("<hr>"); i += 1; continue

        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            lvl = len(m.group(1))
            text = m.group(2).strip()
            slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
            i += 1
            out.append(mark(start, i, f'<h{lvl} id="{slug}">{inline(text, src)}</h{lvl}>'))
            continue

        if ln.strip().startswith("|") and i + 1 < len(lines) \
                and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            def cells(row):
                return [c.strip() for c in row.strip().strip("|").split("|")]
            head = cells(ln)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(cells(lines[i])); i += 1
            t = ["<table><tr>" + "".join(f"<th>{inline(c, src)}</th>" for c in head) + "</tr>"]
            for r in rows:
                t.append("<tr>" + "".join(f"<td>{inline(c, src)}</td>" for c in r) + "</tr>")
            out.append(mark(start, i, "".join(t) + "</table>"))
            continue

        if re.match(r"^\s*>", ln):
            buf = []
            while i < len(lines) and re.match(r"^\s*>", lines[i]):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i])); i += 1
            # Not marked here: a blockquote is several output lines and a
            # mark lands on one of them. The recursive call marks whichever
            # paragraph inside it the author actually marked, which is the
            # line a check reads.
            inner = {n - start for n in marked if start <= n < i}
            out.append("<blockquote>" + convert("\n".join(buf), src, inner)
                       + "</blockquote>")
            continue

        # A FOUR-SPACE INDENT IS A CODE BLOCK, NOT A PARAGRAPH.
        #
        # This renderer only ever knew the fenced kind, so every indented
        # block in every document fell through to the paragraph accumulator
        # below -- which joins the lines with a space and leaves HTML to
        # collapse the indentation. Ten were live on seven pages, and they are
        # the worst possible lines to run together, because an indented block
        # is what a writer uses for the text a reader is meant to COPY:
        #
        #   /security/  the operating treasury address, as a sentence
        #   /security/  the scantxoutset command that checks it
        #   /start/     three Qt download filenames on one line, space-joined
        #   /mine/      the miner's own alarm, re-wrapped into prose
        #
        # Every one of them renders as code on GitLab, which is where they
        # were read and proofread. The page was the only place they were
        # wrong, and nobody reads our pages the way a stranger does.
        #
        # `    - item` is deliberately left alone: this renderer has always
        # read an indented marker as a list, and rewriting those pages would
        # fix nothing that is wrong.
        def indented(s):
            return re.match(r"^ {4,}\S", s) \
                and not re.match(r"^\s*([-*+]|\d+\.)\s+", s)

        if indented(ln):
            buf = []
            while i < len(lines):
                if re.match(r"^ {4,}", lines[i]):
                    buf.append(lines[i][4:]); i += 1; continue
                if not lines[i].strip():
                    # A blank line stays inside the block only if indented
                    # text resumes after it. Otherwise the block ended and
                    # the blank belongs to whatever comes next.
                    j = i
                    while j < len(lines) and not lines[j].strip():
                        j += 1
                    if j < len(lines) and indented(lines[j]):
                        buf.extend([""] * (j - i)); i = j; continue
                break
            while buf and not buf[-1].strip():
                buf.pop()
            out.append(mark(start, i,
                            "<pre><code>" + esc("\n".join(buf)) + "</code></pre>"))
            continue

        m = re.match(r"^\s*([-*+]|\d+\.)\s+", ln)
        if m:
            ordered = bool(re.match(r"^\s*\d+\.", ln))
            tag = "ol" if ordered else "ul"
            items = []
            while i < len(lines):
                cur = lines[i]
                if re.match(r"^\s*([-*+]|\d+\.)\s+", cur):
                    items.append(re.sub(r"^\s*([-*+]|\d+\.)\s+", "", cur))
                    i += 1
                    continue
                # A wrapped line belongs to the item above it.
                #
                # Markdown indents the continuation of a long list item. The
                # loop used to accept only lines beginning with a marker, so
                # the indented remainder closed the list, became its own
                # paragraph, and the NEXT marker opened a fresh list -- which
                # restarts an ordered list's numbering at 1. docs/REHEARSALS.md
                # has three numbered rules and the page rendered them "1. 1. 1."
                # with half of each rule floating outside its own item.
                #
                # This was already live: the same breakage is visible in the
                # published /start/ page, in the list explaining the miner's
                # output. Nobody had looked at the rendered page.
                if items and cur.strip() and re.match(r"^\s{2,}\S", cur):
                    items[-1] += " " + cur.strip()
                    i += 1
                    continue
                break
            out.append(mark(start, i, f"<{tag}>"
                       + "".join(f"<li>{inline(x, src)}</li>" for x in items)
                       + f"</{tag}>"))
            continue

        if not ln.strip():
            i += 1; continue

        # The paragraph accumulator, and the one rule it must never break:
        # it has to consume at least one line.
        #
        # A line beginning with `|` that is NOT followed by a |---|---| row
        # is not a table, so it falls through to here -- where the loop
        # condition excludes lines beginning with `|`. The buffer stays
        # empty, `i` never advances, and the generator spins forever on a
        # single line. WHITEPAPER.md has such a line; START_HERE.md does not,
        # which is why this survived unnoticed in the version that only ever
        # built the two guides.
        buf = [lines[i]]
        i += 1
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(("#", "```", "|", ">")) \
                and not re.match(r"^\s*([-*+]|\d+\.)\s+", lines[i]) \
                and not re.match(r"^\s*(-{3,}|\*{3,})\s*$", lines[i]):
            buf.append(lines[i]); i += 1
        out.append(mark(start, i, "<p>" + inline(" ".join(buf), src) + "</p>"))

    return "\n".join(out)


def nav_links(current, lang):
    """The same handful of destinations on every page, current one omitted."""
    items = [("/", CANONICAL_HOST if lang == "en" else "الرئيسية")]
    for src, outdir, plang, *_rest in PAGES:
        path = "/" + outdir.split("/", 1)[1] + "/"
        if path == current:
            continue
        if plang != lang and not (lang == "en" and path == "/start-ar/") \
                and not (lang == "ar" and path == "/start/"):
            continue
        label = {
            "/start/": "start" if lang == "en" else "English",
            "/start-ar/": "بالعربية",
            "/mine/": "mine",
            "/whitepaper/": "whitepaper",
            "/security/": "security",
            "/build/": "build",
            "/pool/": "pool",
            "/rehearsals/": "rehearsals",
        }.get(path)
        if label:
            items.append((path, label))
    return items


def build(src, outdir, lang, direction, title, desc, og_desc):
    md = (REPO / src).read_text(encoding="utf-8")

    # THE QUOTATION MARKS TRAVEL WITH THE TEXT.
    #
    # Twice now. First this renderer escaped HTML in markdown text, so
    # `<!-- wam:quote-line -->` came out as `&lt;!-- wam:quote-line --&gt;` --
    # visible, in the middle of a sentence, in the whitepaper. Caught by
    # looking at the built page rather than trusting that an HTML comment is
    # invisible: it is, until something escapes it.
    #
    # The fix then was to delete the marks here, and that was wrong for a
    # reason that took a month to show up. docs/MINE.md quotes its own old
    # wording in a correction -- "this paragraph said ... needs v0.1.11" --
    # and the mark says so. The mark lived in the document and died in the
    # generator, so the GENERATED page carried the quotation with nothing to
    # say it was one, and check_promises.py read the correction as the
    # promise it was correcting. Every check honours the mark; a page that
    # loses it is a page no mark can reach.
    #
    # So the marks are read here, the mark lines are taken out of the
    # markdown (a whole-line mark would otherwise split the block it sits
    # inside), and convert() puts one back on every block built from a marked
    # line -- after escaping, never through it. See scripts/lib/quoted.py.
    marked = quoted.quoted_lines(md)
    kept, flags = [], set()
    for n, line in enumerate(md.splitlines()):
        if re.search(r"^\s*(<!--\s*)?#?\s*wam:quote-(begin|end)\b", line):
            continue
        if n in marked:
            flags.add(len(kept))
        kept.append(re.sub(r"\s*(<!--\s*)?wam:quote-line\s*(-->)?", "", line))
    body = convert("\n".join(kept), src, flags)

    path = "/" + outdir.split("/", 1)[1] + "/"
    nav = "\n  ".join(f'<a href="{h}">{esc(t)}</a>' for h, t in nav_links(path, lang))
    nav += f'\n  <a href="{SOURCE_BROWSE}{src}">{esc("source" if lang == "en" else "المصدر")}</a>'

    note = (f"This page is generated from {src} in the repository. "
            "It is the same text; nothing here is written twice."
            if lang == "en" else
            f"هذه الصفحة مولَّدة من {src} في المستودع. "
            "هي النصّ نفسه — لا شيء مكتوبٌ مرّتين.")
    tag = ("A CPU-mineable proof-of-work currency"
           if lang == "en" else "عملة إثبات عملٍ تُعدَّن بالمعالج")

    page = f"""<!doctype html>
<html lang="{lang}" dir="{direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<link rel="icon" href="/favicon.png" type="image/png">
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{CANONICAL_ORIGIN}{path}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="WAM Coin">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(og_desc)}">
<meta property="og:image" content="{CANONICAL_ORIGIN}/og-card.png">
<meta property="og:url" content="{CANONICAL_ORIGIN}{path}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@WAMCoinCore">
<meta name="twitter:image" content="{CANONICAL_ORIGIN}/og-card.png">
<style>{CSS}</style>
</head>
<body>
<main>
<a class="mast" href="/">
  <img src="/wam-coin.png" alt="The WAM Coin mark" width="44" height="44">
  <span class="wordmark">WAM Coin<span>{esc(tag)}</span></span>
</a>
<nav class="top">
  {nav}
</nav>
{body}
<p class="foot">{esc(note)}</p>
</main>
</body>
</html>
"""
    d = REPO / outdir
    d.mkdir(parents=True, exist_ok=True)
    # newline="\n" is not decoration. Python's text mode translates \n to
    # \r\n on Windows, and this generator is run from Windows: both start
    # pages once went into the repository with CRLF on every line and nothing
    # said so.
    emit(d / "index.html", page)
    return page


CHECK = False
DRIFT = []


def emit(path, text):
    """Write the file -- or, under --check, say whether it is already right.

    A GENERATED PAGE GOES STALE IN SILENCE.

    site/security/index.html is built from SECURITY.md. On 8 November 2026
    SECURITY.md gained a fifth paid bounty and four published figures moved
    with it; the commit went out and this generator was not run. For as long
    as that lasted, wamcoin.org/security told every reader "21,250 WAM to
    four people" while the file it is made from said 31,500 to five, which is
    the exact class of contradiction that page exists to be free of.

    Neither guard could see it. check_site_published.py compares the live
    site to this repository and passed, because the two were stale together.
    check_bounty_total.py reads SECURITY.md and site/index.html and has never
    looked at the page built from the first of them.

    So the generator answers it itself: --check renders everything, writes
    nothing, and fails on any page that disagrees with its source. Nobody has
    to remember.
    """
    if not CHECK:
        path.write_text(text, encoding="utf-8", newline="\n")
        return
    try:
        have = path.read_text(encoding="utf-8")
    except OSError:
        DRIFT.append((path, "has never been generated"))
        return
    if have.replace("\r\n", "\n") != text:
        DRIFT.append((path, "is not what its source builds"))


def check_page_links(pages):
    """No generated page may carry a link this site does not serve.

    The whole reason this function exists is that three of them shipped: the
    live /start/ page linked to /start/BUILD.md, /start/POOL_OPERATOR.md and
    /WHITEPAPER.md, all 404, for as long as the page had existed. Nothing
    read the output, so nothing knew.
    """
    served = {"/", "/CHANNELS.txt", "/CHANNELS.txt.asc", "/sitemap.xml",
              "/robots.txt", "/favicon.png", "/og-card.png", "/wam-coin.png"}
    served |= {"/" + o.split("/", 1)[1] + "/" for _s, o, *_r in PAGES}

    bad = []
    for path, text in pages.items():
        for m in re.finditer(r'href="([^"]+)"', text):
            h = m.group(1).split("#")[0]
            if not h or h.startswith(("http://", "https://", "mailto:", "#")):
                continue
            if not h.startswith("/"):
                bad.append((path, m.group(1), "relative -- would resolve under the page"))
            elif h not in served:
                bad.append((path, m.group(1), "not a URL this site serves"))
    return bad


def last_changed(rel, today):
    """The day the bytes served at this URL last changed, from git.

    `lastmod` used to be today for every URL on every run, which is the one
    field a crawler uses to decide whether to fetch a page again. So a one
    line fix to the mining guide told every crawler that all ten pages had
    changed -- and a sitemap whose dates are not true is a sitemap a crawler
    learns to ignore, which costs exactly the pages a stranger would have
    found. It also meant any rebuild dirtied this file, so a diff of the
    site stopped meaning anything.

    The generated pages are committed, so git already knows the day each
    one's bytes last changed. A file with uncommitted changes changed today,
    which is the common case during a build. Without git -- a tarball, a
    machine with no git -- the honest answer is today.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO), "log", "-1", "--format=%cs", "--", rel],
            capture_output=True, text=True, timeout=20)
        dirty = subprocess.run(
            ["git", "-C", str(REPO), "status", "--porcelain", "--", rel],
            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return today
    if dirty.returncode != 0 or dirty.stdout.strip():
        return today
    stamp = out.stdout.strip()
    return stamp if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stamp) else today


def write_sitemap(built):
    """Generated, so it cannot go stale.

    It was hand-maintained and already had: /start/ and /start-ar/ existed for
    days before either appeared in it.
    """
    from datetime import date
    today = date.today().isoformat()
    entries = [(CANONICAL_ORIGIN + "/", "1.0", "weekly", "site/index.html"),
               (CANONICAL_ORIGIN + "/CHANNELS.txt", "0.5", "monthly",
                "site/CHANNELS.txt")]
    for _src, outdir, *_r in PAGES:
        entries.append((CANONICAL_ORIGIN + "/" + outdir.split("/", 1)[1] + "/",
                        "0.8", "monthly", outdir + "/index.html"))
    xml = ['<?xml version="1.0" encoding="UTF-8"?>',
           "<!--",
           "  Generated by scripts/build_pages.py. Do not edit: the next run",
           "  overwrites it. It used to be written by hand and went stale --",
           "  /start/ and /start-ar/ were live for days and listed nowhere.",
           "-->",
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, prio, freq, rel in entries:
        xml += ["  <url>", f"    <loc>{loc}</loc>",
                f"    <lastmod>{last_changed(rel, today)}</lastmod>",
                f"    <changefreq>{freq}</changefreq>",
                f"    <priority>{prio}</priority>", "  </url>"]
    xml.append("</urlset>")
    emit(REPO / "site/sitemap.xml", "\n".join(xml) + "\n")
    return len(entries)


def main():
    global CHECK
    CHECK = "--check" in sys.argv[1:]
    if CHECK:
        print("  --check: rendering every page, writing nothing")
    built = {}
    for src, outdir, lang, direction, title, desc, og in PAGES:
        if not (REPO / src).exists():
            print(f"  missing source: {src}")
            return 1
        page = build(src, outdir, lang, direction, title, desc, og)
        path = "/" + outdir.split("/", 1)[1] + "/"
        built[path] = page
        print(f"  {path:<14} {len(page):>7,} bytes   from {src}")

    bad = check_page_links(built)
    if bad:
        print(f"\n  {len(bad)} link(s) point at something this site does not serve:")
        for path, href, why in bad:
            print(f"    {path:<14} {href}\n                   {why}")
        print("\n  Add the target to PAGES, or to LINKMAP so it rewrites to GitHub.")
        return 1
    print("\n  every link on every page resolves to something served")

    n = write_sitemap(built)
    if not CHECK:
        print(f"  sitemap.xml regenerated: {n} URLs")
        return 0

    if DRIFT:
        print(f"\n  {len(DRIFT)} generated file(s) do not match their source:")
        for path, why in DRIFT:
            print(f"    {path.relative_to(REPO).as_posix():<26} {why}")
        print("\n  Run: python3 scripts/build_pages.py")
        print("  A page built from a document and then left behind tells")
        print("  readers something the document no longer says.")
        return 1
    print(f"  sitemap.xml current, {n} URLs")
    print("\n  every generated page is what its source builds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
