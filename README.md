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

Add repos to `repos.yaml`, then watch:

```sh
rig terminal open qubicle   # every seat as a live tile (herdr)
rig tui                     # topology, queue, activity
```

## Daily use

```sh
qb status                # mode, open questions, seats
qb inbox                 # decisions waiting on you
qb answer <id> "yes"     # reply; the asking seat gets it
qb mode away             # digests and questions go to your phone (Discord, coming next)
```

Digests run at 9:00 and 19:00, plus a pulse every 3h while you're away.

## Rules

- All work happens in worktrees under `work/` and lands as PRs.
- `owned` repos: reviewer merges after approval and green CI.
- `shared` repos (Midas, anything with other contributors): you merge.
- Docs stay short. See `CULTURE.md`.
