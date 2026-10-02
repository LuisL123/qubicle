#!/usr/bin/env bash
# Start the OpenRig daemon without its kernel rig, then bring Qubicle up.
# Runs at login via launchd. Safe to run by hand.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

rig daemon start --no-kernel 2>/dev/null || true   # already running is fine
rig up qubicle --existing --yes || rig up "$ROOT/rig.yaml" --yes
