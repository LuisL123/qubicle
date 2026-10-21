#!/usr/bin/env bash
# Nightly self-update for the tools Qubicle runs on. launchd runs it at 4:30.
# Running seats keep their current version until they restart (qb open after a
# rig down, or a reboot). Results go to Discord #updates via qb notify.
#
#   bash scripts/update.sh            normal run (OpenRig only on Sundays)
#   bash scripts/update.sh --openrig  also update OpenRig today
set -o pipefail   # macOS bash 3.2: no -u (empty arrays), no mapfile
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${QUBICLE_HOME:-$HOME/.qubicle}"
QB=(env OPENRIG_SESSION_NAME=update node "$ROOT/bin/qb.mjs")
changed=() failed=()

ver() { "$@" 2>/dev/null | head -1 | grep -Eo '[0-9]+(\.[0-9]+)+' | head -1; }
step() { # name, version-cmd, update-cmd...
  local name=$1 vcmd=$2; shift 2
  local before after; before=$(ver $vcmd)
  if "$@" >>"$STATE/logs/update.log" 2>&1; then
    after=$(ver $vcmd)
    if [[ -z "$after" ]]; then
      failed+=("$name (no version after update, may be broken)")
    elif [[ "$before" != "$after" ]]; then
      changed+=("$name ${before:-?} → $after")
    fi
  elif [[ -n "$before" && "$(ver $vcmd)" == "$before" ]]; then
    # The update didn't go through (often a dropped download) but the old version still runs.
    # Not urgent: tomorrow's run retries. Just mention it.
    changed+=("$name update didn't go through, still on $before")
  else
    failed+=("$name")
  fi
}

mkdir -p "$STATE/logs" "$STATE/pinned"
echo "== $(date) ==" >>"$STATE/logs/update.log"

# Back up pinned paths (e.g. the Claude version the Midas benchmark uses).
KEEP=()
while IFS= read -r line; do [[ -n "$line" ]] && KEEP+=("$line"); done < <(node -e '
  const y=require(process.argv[1]); const c=y.parse(require("fs").readFileSync(process.argv[2],"utf8"))||{};
  for (const p of (c.update?.keep||[])) console.log(p.replace(/^~/, process.env.HOME));
' "$ROOT/node_modules/yaml" "$ROOT/config.yaml")
for p in "${KEEP[@]}"; do
  [[ -e "$p" ]] && cp -Rp "$p" "$STATE/pinned/" 2>/dev/null
done

codex_before=$(ver codex --version)
step codex   "codex --version"  npm install -g @openai/codex@latest --silent
# A broken Codex keeps both Codex seats from launching (OpenRig runs codex --help
# first), so roll back to the version that worked.
if [[ -n "$codex_before" ]] && ! codex --help >/dev/null 2>&1; then
  if npm install -g "@openai/codex@$codex_before" --silent >>"$STATE/logs/update.log" 2>&1 && codex --help >/dev/null 2>&1; then
    changed+=("codex rolled back to $codex_before (latest was broken)")
    # Handled: drop the codex failure step() recorded so this isn't also an urgent ping.
    keep=(); for f in ${failed[@]+"${failed[@]}"}; do [[ "$f" == codex* ]] || keep+=("$f"); done
    failed=(${keep[@]+"${keep[@]}"})
  else
    failed+=("codex (broken after update, rollback to $codex_before failed)")
  fi
fi
# claude's download times out now and then at 4:30 AM (Oct 20, 21); one retry after a minute.
retry_once() { "$@" || { sleep 60; "$@"; }; }
step claude  "claude --version" retry_once claude update
step herdr   "herdr --version"  brew upgrade herdr
step gh      "gh --version"     brew upgrade gh
# tmux is deliberately not upgraded: a new tmux can't attach to the running
# server, which would cut OpenRig off from every seat until a reboot.

if [[ "$(date +%u)" == 7 || "${1:-}" == "--openrig" ]]; then
  before=$(ver rig --version)
  if npm install -g @openrig/cli@latest --silent >>"$STATE/logs/update.log" 2>&1; then
    after=$(ver rig --version)
    if [[ "$before" != "$after" ]]; then
      # CLI and daemon must match: restart the daemon (agent tmux sessions survive).
      rig daemon stop >>"$STATE/logs/update.log" 2>&1
      bash "$ROOT/scripts/boot.sh" >>"$STATE/logs/update.log" 2>&1
      changed+=("openrig $before → $after (daemon restarted)")
    fi
  else
    failed+=("openrig")
  fi
fi

# Restore any pinned path an update removed.
for p in "${KEEP[@]}"; do
  if [[ ! -e "$p" && -e "$STATE/pinned/$(basename "$p")" ]]; then
    mkdir -p "$(dirname "$p")" && cp -Rp "$STATE/pinned/$(basename "$p")" "$(dirname "$p")/"
    # Routine (claude update prunes old versions daily): log it, don't put it in the note.
    echo "re-pinned $(basename "$p") (update.keep)" >>"$STATE/logs/update.log"
  fi
done

if (( ${#failed[@]} )); then
  "${QB[@]}" notify --level urgent "Update failed: ${failed[*]}. See ~/.qubicle/logs/update.log"
fi
if (( ${#changed[@]} )); then
  "${QB[@]}" notify "Updated: $(printf '%s, ' "${changed[@]}" | sed 's/, $//'). Seats pick it up on their next restart."
fi
exit 0
