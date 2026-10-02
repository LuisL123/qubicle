# Qubicle

A 5-seat [OpenRig](https://openrig.dev) team that works GitHub Issues into PRs
while you watch, or while you're away.

| Seat | Runs on | Job |
|---|---|---|
| `lead-orchestrator` | Claude Code | picks work, routes it, writes digests |
| `build-codex` | Codex | main builder |
| `build-claude` | Claude Code | hard or writing-heavy work |
| `build-grunt` | Claude Code on DeepSeek | tests, refactors, boilerplate |
| `review-codex` | Codex | reviews every PR, merges owned repos |

## Setup (macOS)

```sh
gh auth login            # plus: claude and codex logged in, DeepSeek key handy
./scripts/setup.sh
```

Add repos and local workspaces to `repos.yaml`.

## Coming back

Agents keep running when you close herdr or the terminal. After a reboot they
start again on login.

```sh
herdr                    # open herdr, then inside it:
qb open                  # start the team if needed and show every seat as a tile
```

Click a tile to talk to that seat. `rig tui` shows the queue and activity.
To stop everything: `rig down qubicle --snapshot` (`qb open` brings it back).

## Daily use

```sh
qb status                # mode, open questions, seats
qb inbox                 # decisions waiting on you
qb answer <id> "yes"     # reply; the asking seat gets it
qb mode away             # questions and digests ping your phone on Discord
```

Digests run at 9:00 and 19:00, plus a pulse every 3h while you're away.

## Discord (away mode)

Bot config is in `config.yaml`; the token is in Keychain (`scripts/setup.sh` asks).
Channels: `#digest`, `#decisions`, `#updates`, `#orchestrator`.

- Tap a button or reply in a decision's thread to answer it.
- Message `#orchestrator` to talk to the orchestrator.
- `/away`, `/back`, `/status`, `/inbox`, `/digest`.

At your desk everything still posts, silently. Away, you get pinged.
Logs: `~/.qubicle/logs/dev.qubicle.discord.log`.

## Rules

- All work happens in worktrees under `work/` and lands as PRs.
- `owned` repos: reviewer merges after approval and green CI.
- `shared` repos (Midas, anything with other contributors): you merge.
- Local workspaces (non-git folders): edited in place, no PRs, costly runs need your OK.
- Docs stay short. See `CULTURE.md`.
