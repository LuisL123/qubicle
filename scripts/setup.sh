#!/usr/bin/env bash
# Qubicle setup for macOS. Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${QUBICLE_HOME:-$HOME/.qubicle}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
SEATS=(orchestrator builder-codex builder-claude grunt reviewer)
CLAUDE_SEATS=(orchestrator builder-claude grunt)

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!   %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }

[[ "$(uname)" == "Darwin" ]] || { echo "Qubicle setup targets macOS."; exit 1; }

say "Checking tools"
need brew || { echo "Install Homebrew first: https://brew.sh"; exit 1; }
for pkg in tmux gh node@22 herdr; do
  bin="${pkg%@*}"
  need "$bin" || brew install "$pkg"
done
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' \
  || { echo "Node 22+ required (brew link --overwrite node@22)."; exit 1; }
need claude || warn "Claude Code not found. Install it and run 'claude' once to log in."
need codex  || warn "Codex not found. Install it and run 'codex' once to log in."
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }

say "Installing OpenRig"
need rig || npm install -g @openrig/cli
# rig setup reinstalls cmux on every run, so only run it once. Qubicle uses herdr.
if [[ ! -f "$ROOT/vendor/.rig-setup-done" ]]; then
  rig setup
  mkdir -p "$ROOT/vendor" && touch "$ROOT/vendor/.rig-setup-done"
fi

say "Installing qb"
(cd "$ROOT" && npm install --silent && npm link --silent)

say "Linking OpenRig's shared agent resources"
mkdir -p "$ROOT/vendor"
ln -sfn "$(npm root -g)/@openrig/cli/daemon/specs/agents/shared" "$ROOT/vendor/openrig-shared"

say "Creating seats and work dirs"
mkdir -p "$ROOT/work/repos" "$ROOT/work/wt" "$STATE"/{inbox,digests,approvals,logs}
for s in "${SEATS[@]}"; do mkdir -p "$ROOT/seats/$s"; done
# Let Claude seats edit worktrees and qb state outside their own seat dir.
for s in "${CLAUDE_SEATS[@]}"; do
  f="$ROOT/seats/$s/.claude/settings.local.json"
  mkdir -p "$(dirname "$f")"
  [[ -f "$f" ]] || echo '{}' > "$f"
  node -e '
    const fs = require("fs"), [f, ...dirs] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    s.permissions ??= {};
    s.permissions.additionalDirectories = [...new Set([...(s.permissions.additionalDirectories || []), ...dirs])];
    fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  ' "$f" "$ROOT" "$ROOT/work" "$STATE" $(node "$ROOT/bin/qb.mjs" workspaces | cut -f2)
done

# Codex's update prompt blocks unattended seats. Update with: npm i -g @openai/codex
CODEX_CFG="$HOME/.codex/config.toml"
mkdir -p "$(dirname "$CODEX_CFG")"; touch "$CODEX_CFG"
grep -q '^check_for_update_on_startup' "$CODEX_CFG" \
  || { printf 'check_for_update_on_startup = false\n' | cat - "$CODEX_CFG" > "$CODEX_CFG.tmp" && mv "$CODEX_CFG.tmp" "$CODEX_CFG"; }

say "DeepSeek key (stored in Keychain, never on disk)"
if security find-generic-password -s qubicle-deepseek -w >/dev/null 2>&1; then
  echo "    already in Keychain"
else
  read -rsp "    Paste your DeepSeek API key: " DS_KEY; echo
  security add-generic-password -a "$USER" -s qubicle-deepseek -w "$DS_KEY" -U
  unset DS_KEY
fi

say "Discord bot token (Keychain, for away mode)"
if security find-generic-password -s qubicle-discord -w >/dev/null 2>&1; then
  echo "    already in Keychain"
else
  read -rsp "    Paste your Discord bot token (Enter to skip): " DC_TOKEN; echo
  [[ -n "$DC_TOKEN" ]] && security add-generic-password -a "$USER" -s qubicle-discord -w "$DC_TOKEN" -U
  unset DC_TOKEN
fi

say "Validating rig spec"
rig daemon start --no-kernel >/dev/null 2>&1 || true   # no kernel: saves 3 extra agents
rig spec validate "$ROOT/rig.yaml"

say "Installing launch agents (boot + digests at 9:00 and 19:00, pulse every 3h when away)"
mkdir -p "$AGENTS_DIR"
NODE="$(command -v node)"
plist() { # label, interval-xml, program args...
  local label="$1" when="$2"; shift 2
  local args=""; for a in "$@"; do args+="<string>$a</string>"; done
  cat > "$AGENTS_DIR/$label.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  $when
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
  <key>StandardOutPath</key><string>$STATE/logs/$label.log</string>
  <key>StandardErrorPath</key><string>$STATE/logs/$label.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS_DIR/$label.plist"
}
at() { echo "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$1</integer><key>Minute</key><integer>$2</integer></dict>"; }
plist dev.qubicle.boot    "<key>RunAtLoad</key><true/>"                         /bin/bash "$ROOT/scripts/boot.sh"
plist dev.qubicle.morning "$(at 9 0)"                                           "$NODE" "$ROOT/bin/qb.mjs" digest morning
plist dev.qubicle.evening "$(at 19 0)"                                          "$NODE" "$ROOT/bin/qb.mjs" digest evening
plist dev.qubicle.pulse   "<key>StartInterval</key><integer>10800</integer>"    "$NODE" "$ROOT/bin/qb.mjs" digest pulse
if security find-generic-password -s qubicle-discord -w >/dev/null 2>&1; then
  plist dev.qubicle.discord "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>" "$NODE" "$ROOT/bridge/discord.mjs"
fi

say "Checking sleep settings"
if pmset -g custom | awk '/AC Power/{ac=1} ac && $1=="sleep"{print $2; exit}' | grep -qv '^0$'; then
  warn "This Mac sleeps on power. Away mode needs it awake:"
  warn "  sudo pmset -c sleep 0      (display can still turn off)"
fi

say "Done"
echo "    Next: add repos to repos.yaml. Watch with 'rig terminal open qubicle' (live tiles) or 'rig tui'."
