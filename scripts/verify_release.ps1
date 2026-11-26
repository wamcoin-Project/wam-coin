# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
#
# ===========================================================================
#  verify_release.ps1 -- verify_release.sh, for Windows without WSL
# ===========================================================================
#
#      powershell -ExecutionPolicy Bypass -File verify_release.ps1
#      powershell -ExecutionPolicy Bypass -File verify_release.ps1 C:\wam
#
#  WHY THIS EXISTS
#
#  v0.1.8 is the first release with Windows downloads, and the verifier that
#  has guarded every release until now is a bash script. A Windows user who
#  installed no Linux -- which is the entire audience the Windows build was
#  added for -- cannot run it.
#
#  What docs/MINE.md told them to do instead was
#
#      certutil -hashfile wam-coin-...zip SHA256
#      type SHA256SUMS
#
#  and compare sixty-four hexadecimal characters by eye. People do not do
#  that. They glance at the first four characters and the last four, which is
#  the check an attacker would design for, or they skip it, which is what the
#  whole discipline exists to prevent. Verification that is tedious is
#  verification that does not happen, and this project has said in five places
#  that the signature is the one step that cannot be checked afterwards.
#
#  WHAT IT REFUSES TO SAY
#
#  The same three things as the bash version, and it prints ok only if all
#  three hold: the signature over SHA256SUMS is good, it was made by the
#  fingerprint published in SECURITY.md, and the file in front of you is a
#  file that signature covers.
#
#  Windows ships no gpg. If none is found this reports what the hashes did --
#  which is worth knowing -- and then exits 2, the convention in this project
#  for "the check could not run". It does not print a pass. A matching hash
#  against an unsigned list proves the download is not corrupt and proves
#  nothing about who wrote the list: whoever can replace the archive can
#  replace SHA256SUMS beside it, and the two will agree perfectly.
# ===========================================================================

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Directory = "."
)

# Continue, not Stop. gpg writes to stderr in normal operation, and under
# Stop a native command's stderr line becomes a terminating
# NativeCommandError -- so the first version of this file died inside its
# own cleanup block and reported nothing about the signature it had just
# checked. Every failure below is handled explicitly instead.
$ErrorActionPreference = "Continue"

# The fingerprint in SECURITY.md and nowhere else. Without spaces so it can be
# compared; printed with them so it can be read.
$EXPECT = "4BD4A8D3AFD43F5CBCB500E23798462FE00ADBA4"
$EXPECT_PRETTY = "4BD4 A8D3 AFD4 3F5C BCB5  00E2 3798 462F E00A DBA4"

function Write-Ok   ($m) { Write-Host "  ok    " -ForegroundColor Green -NoNewline; Write-Host $m }
function Write-Bad  ($m) { Write-Host "  FAIL  " -ForegroundColor Red   -NoNewline; Write-Host $m }
function Write-Warn ($m) { Write-Host "  !!    " -ForegroundColor Yellow -NoNewline; Write-Host $m }
function Write-Say  ($m) { Write-Host "        $m" }

# Git for Windows ships an MSYS build of gpg, and MSYS resolves a Windows path
# against its own root. Given a --homedir of C:\Users\me\tmp it looked for
#
#     /c/wam/C:\Users\me\tmp/pubring.kbx
#
# naming a path nobody chose, built from whichever directory happened to be
# the working one, and reported "No such file or directory" about it. Gpg4win's
# build takes Windows paths. So the path is translated for the build that wants
# it translated and left alone for the one that does not.
function ConvertTo-GpgPath([string]$Path, [string]$GpgExe) {
    if ($GpgExe -match '\\(usr|mingw64)\\bin\\gpg\.exe$') {
        if ($Path -match '^([A-Za-z]):[\\/](.*)$') {
            return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
        }
    }
    return $Path
}

# Run gpg, keep its stdout, and put its stderr in a file.
#
# Three ways to do this are wrong, and each was tried:
#
#   * a bare call prints gpg's own
#         gpg: WARNING: This key is not certified with a trusted signature!
#     straight at somebody verifying a download for the first time. That
#     warning is normal -- it means "you have not told GnuPG you trust this
#     key", which is true of everybody initially, and is the very question
#     this script answers by comparing the fingerprint. The bash version hides
#     it for the same reason and gives its own verdict.
#
#   * `2>&1` merges stderr into stdout, and PowerShell 5.1 wraps each of those
#     lines in an ErrorRecord: a good signature came out of an earlier version
#     of this file as a NativeCommandError raised inside its own cleanup.
#
#   * Start-Process -Wait with redirected streams HANGS on the MSYS gpg that
#     Git for Windows ships. gpg starts gpg-agent, the agent inherits the
#     redirected handle and outlives gpg, and -Wait never returns. It hung for
#     five minutes on a release that was perfectly valid.
#
# So: stderr to a file with a plain redirect, stdout captured as the value,
# and $LASTEXITCODE for the verdict -- not $?, which a redirected native
# stderr sets to false even on success.
function Invoke-Gpg {
    param([string]$Exe, [string[]]$Arguments)

    $se = [System.IO.Path]::GetTempFileName()
    # SilentlyContinue for the duration of the call, and only for it.
    #
    # The redirect above puts gpg's stderr in the file, and PowerShell ALSO
    # raises an ErrorRecord for it, which under Continue prints red text beside
    # this script's own verdict. On a bad signature the reader got the
    # explanation twice: once in plain words from here, once as
    # "NativeCommandError" with a caret diagram. The exit code is read from
    # $LASTEXITCODE, so nothing here depends on the error stream.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        $out = & $Exe @Arguments 2>$se
        $code = $LASTEXITCODE
        return [pscustomobject]@{
            Code = $code
            Out  = [string]($out | Out-String)
            Err  = [string](Get-Content -LiteralPath $se -Raw -ErrorAction SilentlyContinue)
        }
    } finally {
        $ErrorActionPreference = $prevEap
        Remove-Item -LiteralPath $se -Force -ErrorAction SilentlyContinue
    }
}

# Where this script is, resolved before any location change -- the bash
# version's header explains why the order matters: the published command is
# run from the directory holding the downloads, not from the repository.
$SelfDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $Directory)) {
    Write-Bad "$Directory does not exist"
    exit 2
}
$Directory = (Resolve-Path -LiteralPath $Directory).Path

Write-Host ""
Write-Host "=================================================================="
Write-Host " verifying the WAM Coin release in $Directory"
Write-Host "=================================================================="
Write-Host ""

$sums = Join-Path $Directory "SHA256SUMS"
$asc  = Join-Path $Directory "SHA256SUMS.asc"

# ---- 0. is there anything here to check? ---------------------------------
if (-not (Test-Path -LiteralPath $sums)) {
    Write-Bad "SHA256SUMS is not in $Directory -- nothing has been downloaded yet"

    # The version is read from the repository rather than written here, so
    # this text cannot go stale the way a hard-coded version would.
    $ver = ""
    $pu = Join-Path $SelfDir "patch_upstream.py"
    if (Test-Path -LiteralPath $pu) {
        $m = Select-String -LiteralPath $pu -Pattern '^WAM_CLIENT_VERSION\s*=\s*"([0-9.]+)"' |
             Select-Object -First 1
        if ($m) { $ver = $m.Matches[0].Groups[1].Value }
    }
    $base = "https://github.com/wamcoin-Project/wam-coin/releases"
    Write-Say ""
    Write-Say "Fetch the release into this directory first:"
    Write-Say ""
    if ($ver) {
        Write-Say "    cd $Directory"
        Write-Say "    curl -LO $base/download/v$ver/SHA256SUMS"
        Write-Say "    curl -LO $base/download/v$ver/SHA256SUMS.asc"
        Write-Say "    curl -LO $base/download/v$ver/wam-coin-v$ver-x86_64-w64-mingw32.zip"
    } else {
        Write-Say "    $base"
    }
    Write-Say ""
    Write-Say "Then run this again. SHA256SUMS.asc is the one that matters: it is"
    Write-Say "the signature, and without it nothing here can be proved."
    Write-Host ""
    exit 2
}

if (-not (Test-Path -LiteralPath $asc)) {
    Write-Bad "SHA256SUMS.asc is not here -- that file IS the proof."
    Write-Say "A release without it cannot be checked. Do not run the binaries."
    Write-Host ""
    exit 1
}

# ---- 1. the hashes, which Windows can do on its own ----------------------
#
# Done before the signature, unlike the bash version, and for a reason that
# only applies here: gpg may be absent, and in that case this is the only
# thing that can be reported. Reporting it is useful; calling it a pass is
# not, and the exit code below keeps those apart.
$checked = 0
$failed  = @()
$missing = @()

foreach ($line in Get-Content -LiteralPath $sums) {
    if ($line -notmatch '\S') { continue }
    # `hash  name` in text mode, `hash *name` in binary mode. Both are legal
    # and coreutils writes the second on Git Bash, so a parser that knows only
    # one is a parser that works only where it was written.
    $parts = $line.Trim() -split '\s+', 2
    if ($parts.Count -ne 2) { continue }
    $want = $parts[0].ToLower()
    $name = $parts[1].TrimStart('*').Trim()

    $path = Join-Path $Directory $name
    if (-not (Test-Path -LiteralPath $path)) { $missing += $name; continue }

    $got = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
    if ($got -eq $want) {
        Write-Ok ("{0,-46} matches" -f $name)
        $checked++
    } else {
        Write-Bad ("{0,-46} DOES NOT MATCH" -f $name)
        Write-Say "  expected : $want"
        Write-Say "  this file: $got"
        $failed += $name
    }
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Bad "$($failed.Count) file(s) do not match the list"
    Write-Say "Either the download is damaged, or this is not our file."
    Write-Say "Delete it and download again. Do not run it."
    Write-Host ""
    exit 1
}

# AND THE OTHER DIRECTION -- THE DOOR THIS VERIFIER DID NOT HAVE.
#
# The loop above walks the LIST. A file sitting in this directory that
# SHA256SUMS does not name is never looked at, and the banner at the end
# said "this is the WAM release, unmodified since it was signed" anyway.
#
# verify_release.sh grew this check in v0.1.15 and its comment states the
# attack: anyone who can serve HTTP to a downloader serves the genuine
# SHA256SUMS, the genuine signature and the genuine tarball, all untouched,
# PLUS one extra release-shaped archive. The reader is told the release is
# unmodified and extracts a binary nobody signed.
#
# The .ps1 never got it, and docs/MINE.md sends Windows readers here -- the
# people least able to check by hand. Reported by Warung Bunda Kanse Bunda
# on 2026-11-22, the day after the .sh fix shipped: "this is the second door
# of a guard that exists in one of the two published verifiers".
#
# It is reachable with no attacker at all: the Windows and macOS archives are
# added to SHA256SUMS by hand, and package_release.sh leaves the wallet out
# of the list when Qt did not build. A missed step produces this directory.
$listed = @{}
foreach ($line in Get-Content -LiteralPath $sums) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
        $listed[$matches[2]] = $true
    }
}
# THREE GLOBS IN THE TOP DIRECTORY IS NOT "EVERY FILE", AND THAT IS WHAT THE
# BANNER CLAIMS.
#
# This enumerated -Include 'wam-coin-*','wam-miner-*','wam-qt-*' with no
# -Recurse and no -Force, so it saw nothing in a subdirectory, nothing
# hidden, and nothing named anything else -- a bare wamd.exe, an installer,
# a dotfile. The .sh had exactly this shape and was widened on 26 November
# 2026; this one was left, which is the half-fix that keeps happening here.
# Reported by mpit the same day as the residual.
#
# Every file, at any depth, hidden included, except the three this
# verification is made of and the verifiers themselves -- the same exception
# list the .sh uses, for the same reason: you are running one of them, so you
# chose it.
#
# Paths are compared relative to $Directory and with forward slashes, because
# that is how SHA256SUMS writes a name that is in a subdirectory, and a
# backslash would make a genuine listed path read as unlisted.
$root = (Resolve-Path -LiteralPath $Directory).Path.TrimEnd('\', '/')
$selfFiles = @('SHA256SUMS', 'SHA256SUMS.asc', 'SIGNING-KEY.asc',
               'verify_release.ps1', 'verify_release.sh')
$unlisted = @()
foreach ($item in Get-ChildItem -LiteralPath $Directory -File -Recurse -Force `
                    -ErrorAction SilentlyContinue) {
    $rel = $item.FullName
    if ($rel.StartsWith($root)) { $rel = $rel.Substring($root.Length) }
    $rel = $rel.TrimStart('\', '/') -replace '\\', '/'

    # An array test and not a switch: in PowerShell `continue` inside a
    # switch leaves the SWITCH, not the enclosing foreach, so every name
    # after the first match would have fallen through to the check below.
    if ($selfFiles -contains $rel) { continue }
    if (-not $listed.ContainsKey($rel)) { $unlisted += $rel }
}
if ($unlisted.Count -gt 0) {
    Write-Host ""
    Write-Bad "these file(s) are here and are NOT in the signed list:"
    foreach ($f in $unlisted) { Write-Say "    $f" }
    Write-Say "SHA256SUMS.asc signs SHA256SUMS and nothing else. A file the list"
    Write-Say "does not name is covered by nothing, whoever gave it to you."
    Write-Host ""
    exit 1
}

if ($checked -eq 0) {
    Write-Host ""
    Write-Bad "none of the files in SHA256SUMS are here"
    Write-Say "It lists:"
    foreach ($n in $missing) { Write-Say "    $n" }
    Write-Say "Nothing was verified. Download the file you want into this directory."
    Write-Host ""
    exit 1
}
if ($missing.Count -gt 0) {
    Write-Warn "$($missing.Count) file(s) in the list were not downloaded, and were skipped"
}

# ---- 2. the signature, which needs gpg ----------------------------------
$gpg = $null
$candidates = @()
$onPath = Get-Command gpg -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }
$candidates += "$env:ProgramFiles\Git\usr\bin\gpg.exe"
$candidates += "${env:ProgramFiles(x86)}\GnuPG\bin\gpg.exe"
$candidates += "$env:ProgramFiles\GnuPG\bin\gpg.exe"
$candidates += "$env:ProgramFiles\Gpg4win\..\GnuPG\bin\gpg.exe"
foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $gpg = $c; break }
}

if (-not $gpg) {
    Write-Host ""
    Write-Warn "no gpg on this machine, so the SIGNATURE WAS NOT CHECKED"
    Write-Say ""
    Write-Say "$checked file(s) match SHA256SUMS. That means the download is not"
    Write-Say "corrupt. It does NOT mean the file is ours: whoever could replace"
    Write-Say "the archive could replace SHA256SUMS beside it, and the two would"
    Write-Say "agree perfectly. SHA256SUMS.asc is the part that cannot be forged"
    Write-Say "without a key that is kept offline, and checking it needs gpg:"
    Write-Say ""
    Write-Say "    https://gpg4win.org/          (install, then run this again)"
    Write-Say ""
    Write-Say "Git for Windows also ships one, at"
    Write-Say "    C:\Program Files\Git\usr\bin\gpg.exe"
    Write-Host ""
    Write-Host "  this is not a pass" -ForegroundColor Yellow
    Write-Host ""
    exit 2
}
Write-Host ""
Write-Ok "gpg           $gpg"

# The key file, if it was downloaded beside the release. Importing it and
# verifying against THAT is not circular: the key file is not the trust
# anchor, the fingerprint compared below is, and a substituted key file
# changes the fingerprint.
$keyfile = $null
foreach ($c in @(
        (Join-Path $Directory "SIGNING-KEY.asc"),
        (Join-Path $SelfDir "..\SIGNING-KEY.asc"),
        (Join-Path $SelfDir "SIGNING-KEY.asc"))) {
    if (Test-Path -LiteralPath $c) { $keyfile = (Resolve-Path -LiteralPath $c).Path; break }
}

# A throwaway keyring. Nothing is added to the reader's own, which is not ours
# to modify.
$tmphome = Join-Path $env:TEMP ("wam-verify-" + [guid]::NewGuid().ToString("N").Substring(0, 12))
New-Item -ItemType Directory -Path $tmphome -Force | Out-Null
try {
    # Every path handed to gpg goes through the translation, not just the
    # homedir: an MSYS build resolves all of them the same way.
    $gHome = ConvertTo-GpgPath $tmphome $gpg
    $gAsc  = ConvertTo-GpgPath $asc     $gpg
    $gSums = ConvertTo-GpgPath $sums    $gpg

    $gpgArgs = @("--homedir", $gHome, "--batch", "--quiet")
    if ($keyfile) {
        $gKey = ConvertTo-GpgPath $keyfile $gpg
        $imp = Invoke-Gpg $gpg ($gpgArgs + @("--import", $gKey))
        if ($imp.Code -ne 0) {
            Write-Bad "gpg would not import SIGNING-KEY.asc"
            Write-Say "The key file is damaged, or is not a PGP key at all."
            if ($imp.Err) { Write-Host ""; Write-Host $imp.Err }
            Write-Host ""
            exit 1
        }
    } else {
        Write-Warn "SIGNING-KEY.asc is not here, so the key could not be imported"
        Write-Say "Download it beside the release:"
        Write-Say "    curl.exe -LO https://wamcoin.org/SIGNING-KEY.asc"
        Write-Host ""
        exit 2
    }

    # --status-fd 1 puts the machine-readable result on stdout. That is the
    # stream with a grammar; gpg's prose goes to stderr and is kept back.
    $ver = Invoke-Gpg $gpg ($gpgArgs + @("--status-fd", "1", "--verify", $gAsc, $gSums))
    $text = $ver.Out

    if ($text -notmatch "GOODSIG") {
        Write-Bad "the signature over SHA256SUMS is NOT valid"
        Write-Say "SHA256SUMS was changed after it was signed, or the signature"
        Write-Say "is not ours. Do not run the binaries."
        # Here gpg's own words earn their place: this is the case where the
        # reader needs to know what it actually objected to.
        if ($ver.Err) { Write-Host ""; Write-Host $ver.Err }
        Write-Host ""
        exit 1
    }

    $fpr = ""
    $m = [regex]::Match($text, "VALIDSIG\s+([0-9A-Fa-f]{40})")
    if ($m.Success) { $fpr = $m.Groups[1].Value.ToUpper() }

    if ($fpr -ne $EXPECT) {
        Write-Bad "signed by a key this project does not publish"
        Write-Say "  signed by : $(if ($fpr) { $fpr } else { 'unknown' })"
        Write-Say "  expected  : $EXPECT"
        Write-Say ""
        Write-Say "This is what a substituted release looks like. Do not run it."
        Write-Host ""
        exit 1
    }
    Write-Ok "signed by the key published in SECURITY.md"
}
finally {
    # gpg-agent keeps the keyring directory open on Windows, so it has to be
    # stopped before the directory can be removed. No 2>&1 here either.
    $gpgconf = Join-Path (Split-Path -Parent $gpg) "gpgconf.exe"
    if (Test-Path -LiteralPath $gpgconf) {
        $env:GNUPGHOME = ConvertTo-GpgPath $tmphome $gpg
        Invoke-Gpg $gpgconf @("--kill", "all") | Out-Null
        Remove-Item Env:\GNUPGHOME -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $tmphome -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "  this is the WAM release, unmodified since it was signed" -ForegroundColor Green
Write-Host ""
Write-Host "  What that does and does not tell you:"
Write-Host "    it does     -- these bytes are the bytes the holder of that key signed"
Write-Host "    it does not -- say the key belongs to anyone you should trust."
Write-Host "                   Check the fingerprint at wamcoin.org/security/, over"
Write-Host "                   HTTPS. Do not take it from an email or a forum post."
Write-Host ""
Write-Host "    $EXPECT_PRETTY"
Write-Host ""
exit 0
