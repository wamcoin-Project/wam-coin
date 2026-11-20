#!/usr/bin/env bash
# Copyright (c) 2026 The WAM Coin developers
# Distributed under the MIT software license, see COPYING.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)"
HERE="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "$HERE"

GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; OFF=$'\033[0m'

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  %sok%s    %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!!%s    %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '\n  %sFAIL%s  %s\n\n' "$RED" "$OFF" "$*" >&2; exit 1; }

CHECKER="${HERE}/scripts/check_android_miner.py"

# Allow overriding target directory (used by check_android_miner.py in CI)
TARGET_DIR="${1:-${SCRIPT_DIR}/app/src/main/cpp/src}"

printf '\n%sPreparing Android miner code%s\n' "$BLD" "$OFF"
log "Repository root : ${HERE}"
#log "Checker script  : ${CHECKER}"
log "Target directory: ${TARGET_DIR}"

# Pre-flight validation
[[ -f "${CHECKER}" ]]        || die "Checker script (source of ANDROID_EDITS) not found: ${CHECKER}"
[[ -d "${HERE}/miner/src" ]] || die "Source directory not found: ${HERE}/miner/src"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed or not in PATH"

# Step 1: Delete any existing generated directory
if [[ -d "${TARGET_DIR}" ]]; then
    log "Removing existing target directory..."
    rm -rf "${TARGET_DIR}" || die "Failed to remove ${TARGET_DIR}"
    ok "Removed ${TARGET_DIR}"
else
    warn "Target directory does not exist yet; skipping cleanup"
fi

# Step 2: Copy miner/src
log "Copying sources from ${HERE}/miner/src/..."
mkdir -p "${TARGET_DIR}" || die "Failed to create ${TARGET_DIR}"
cp -R "${HERE}/miner/src/." "${TARGET_DIR}/" || die "Failed to copy sources to ${TARGET_DIR}"
ok "Copied miner sources"

# Step 3: Apply ANDROID_EDITS from check_android_miner.py
log "Fetching Android edits from check_android_miner.py..."
if ! edits_output="$(python3 "${CHECKER}" --emit-edits 2>&1)"; then
    printf '%s\n' "${edits_output}" >&2
    die "Failed to run ${CHECKER} --emit-edits"
fi
[[ -n "${edits_output}" ]] || die "No edits emitted by ${CHECKER}"

edit_count=0

while IFS=$'\t' read -r file src dst; do
    [[ -z "${file}" ]] && continue
    ((edit_count++))
    target_file="${TARGET_DIR}/${file}"

    [[ -f "${target_file}" ]] || die "${file} not found in ${TARGET_DIR}"

    # Literal string replacement (portable across GNU/BSD without regex escaping)
    if ! awk -v src="${src}" -v dst="${dst}" '
        {
            idx = index($0, src)
            if (idx > 0 && !replaced) {
                $0 = substr($0, 1, idx - 1) dst substr($0, idx + length(src))
                replaced = 1
            }
            print
        }
        END {
            if (!replaced) exit 2
        }
    ' "${target_file}" > "${target_file}.tmp"; then
        rm -f "${target_file}.tmp"
        die "Recorded Android edit no longer matches ${file}: ${src}"
    fi

    mv "${target_file}.tmp" "${target_file}" || die "Failed to overwrite ${file}"
    ok "Applied edit #${edit_count} to ${file}"
done <<< "${edits_output}"

printf '\n  %s%sok%s    Prepared Android miner sources (%d edit(s) applied)\n\n' "$BLD" "$GRN" "$OFF" "$edit_count"
