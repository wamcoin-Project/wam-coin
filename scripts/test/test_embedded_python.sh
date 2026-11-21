#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  test_embedded_python.sh -- does the Python inside our shell scripts parse?
# ===========================================================================
#
#      bash scripts/test/test_embedded_python.sh
#
#  WHY THIS EXISTS
#
#  scripts/prepare_listing_pr.sh carried a heredoc whose indentation had been
#  lost:
#
# wam:quote-begin
#      if any(x.get("ticker") == entry["ticker"] for x in data):
#      print("  ok     manifest already lists %s" % entry["ticker"])
#      else:
# wam:quote-end
#
#  It sat in the repository, committed, through every sweep. Nothing runs a
#  heredoc until the branch that reaches it runs, and that branch is the one
#  that submits this coin to an exchange. It failed on 6 September in the
#  middle of updating a live pull request, with an IndentationError as the
#  only explanation.
#
#  A shell script's syntax is checked by `bash -n`. The Python inside it is
#  checked by nobody, and it is the part most likely to be edited by whoever
#  is in a hurry.
#
#  WHAT IT DOES NOT CATCH
#
#  Whether the code is right. Only whether it is code. That is still the
#  difference between a fault found now and a fault found while pushing to
#  somebody else's repository.
# ===========================================================================

set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
. "$SCRIPTS_DIR/lib/python.sh" || exit 2

HERE="$(cd "$SCRIPTS_DIR/.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; BLD=$'\033[1m'; OFF=$'\033[0m'

printf '\n%sthe Python inside our shell scripts parses%s\n' "$BLD" "$OFF"

"$PY" - <<'PY'
import pathlib, re, subprocess, sys, ast

repo = pathlib.Path(".").resolve()
files = subprocess.run(["git", "ls-files", "*.sh"], capture_output=True,
                       text=True).stdout.split()

# A heredoc whose tag is PY or PYTHON, quoted or not. Quoted means the shell
# does not expand it, which is the form that is genuinely Python; an unquoted
# one may carry $VARIABLES that are not, so it is parsed with those blanked.
BLOCK = re.compile(r"<<-?\s*'?\"?(PY|PYTHON)'?\"?\s*\n(.*?)\n\1\n", re.S)

checked = failed = 0
for rel in files:
    try:
        text = pathlib.Path(rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        continue
    for m in BLOCK.finditer(text):
        body = m.group(2)
        line_no = text[:m.start()].count("\n") + 2
        checked += 1
        # $VAR and ${VAR} inside an unquoted heredoc are shell, not Python.
        probe = re.sub(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", "SHELLVAR", body)
        try:
            ast.parse(probe)
        except SyntaxError as e:
            failed += 1
            print(f"  \033[31mFAIL\033[0m  {rel}:{line_no + (e.lineno or 1) - 1}"
                  f"  {e.msg}")
            bad_line = (body.splitlines()[(e.lineno or 1) - 1]
                        if e.lineno and e.lineno <= len(body.splitlines()) else "")
            if bad_line:
                print(f"          {bad_line.strip()[:78]}")

if checked == 0:
    print("  \033[31mFAIL\033[0m  no embedded Python was found at all -- "
          "this proves nothing")
    sys.exit(2)

if failed:
    print(f"\n  \033[31m{failed} of {checked} block(s) do not parse\033[0m")
    print("  A heredoc is not run until the branch that reaches it runs.")
    print()
    sys.exit(1)

print(f"  \033[32mok\033[0m    all {checked} embedded block(s) parse")
print()
PY
exit $?
