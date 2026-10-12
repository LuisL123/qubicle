# Qubicle

A 5-seat [OpenRig](https://openrig.dev) team that works GitHub Issues into PRs
while you watch, or while you're away.

| Seat | Runs on | Job |
|---|---|---|
| `lead-orchestrator` | Claude Code | picks work, routes it, writes digests |
| `build-codex` | Codex | main builder |
| `build-claude` | Claude Code | hard or writing-heavy work |
| `build-grunt` | Claude Code (Sonnet) | tests, refactors, boilerplate |
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

## Starting a project

1. **Grill.** In the orchestrator tile: `/grill-me` on what you want. It asks
   until the goal is clear.
2. **Goal.** It writes `work/specs/<project>/GOAL.md`. Read every line, fix it,
   then `qb goal <project> --lock`.
3. **Plan.** Ask it to break the goal into tickets (`/to-tickets` or `/to-spec`).
   Big plans get a second opinion before they start.
4. **Let it run.** The team decides small things itself, proposes the rest
   (goes ahead unless you object), and only asks you about real decisions.
5. **Audit, don't approve.** Skim `work/specs/<project>/DECISIONS.md` and the
   digests. Object to what's off; that's your steering.
6. **Change course** by editing the goal: `qb goal <project> --unlock`, edit,
   `--lock`. Not by answering a stream of questions.

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

- Tap a button or reply in a decision's thread to answer it. Proposals say
  when they go ahead; tap Object (or reply with why) to stop one.
- Big moves come with a ⚖️ second opinion in the thread.
- Each decision thread gets a plain-words breakdown and a suggested pick from a
  second model (the explainer). Reply `? <question>` in the thread to ask it more.
- Message `#orchestrator` to talk to the orchestrator.
- `/away`, `/back`, `/status`, `/inbox`, `/digest`.

At your desk everything still posts, silently. Away, you get pinged.
Logs: `~/.qubicle/logs/dev.qubicle.discord.log`.

## Watchdog

Runs every 5 minutes (plain script, no AI): relaunches a seat whose harness
crashed, tells you when a seat sits on a prompt for 15+ minutes, nudges seats
idle on open work, and escalates to the orchestrator (flagging likely provider
refusals). `qb watch --dry` shows what it would do right now.

## Safety and usage

- `qb sandbox on <seat>` puts a Claude seat's shell commands in macOS's sandbox:
  writes only to its own folders and tool caches, no reading secrets, blind
  blocks enforced by the OS. Lists live under `sandbox:` in `config.yaml`.
  Codex seats can't be sandboxed while they run with full access.
- `qb usage` shows tokens per seat, provider limit signals and the DeepSeek
  balance. Digests include a line from it.

## Updates

`scripts/update.sh` runs nightly at 4:30: Codex, Claude Code, herdr and gh update
every night, OpenRig on Sundays (or `--openrig`). tmux stays put on purpose.
Running seats switch to new versions on their next restart. Paths under
`update.keep` in `config.yaml` are protected from removal.

## Rules

- All work happens in worktrees under `work/` and lands as PRs.
- `owned` repos: reviewer merges after approval and green CI.
- `shared` repos (Midas, anything with other contributors): you merge.
- `delegated` repos (midas-reviewer): the orchestrator merges after review-codex approves the head commit.
- Local workspaces (non-git folders): edited in place, no PRs, costly runs need your OK.
- Docs stay short. See `CULTURE.md`.
