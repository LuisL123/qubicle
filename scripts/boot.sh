#!/usr/bin/env bash
# Start the OpenRig daemon without its kernel rig, then bring Qubicle up.
# Runs at login via launchd. Safe to run by hand.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rig daemon start --no-kernel 2>/dev/null || true   # already running is fine
rig up qubicle --existing --yes >/dev/null 2>&1 || rig up "$ROOT/rig.yaml" --yes

# The 5-minute tick relaunches seats that did not come back (qb heal), once,
# 3 to 30 minutes after this ran.
STATE="${QUBICLE_HOME:-$HOME/.qubicle}"
mkdir -p "$STATE" && date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE/boot-at"
