# Install and use

Two programs and one package:

| Piece | What it is | Needed |
|---|---|---|
| **herdr-core** (`hc`) | Terminal server. piher starts, reads and reclaims terminals through it | yes |
| **Herdr app** (`herdr-app`) | Shows those terminals as spaces, tabs and panes | optional |
| **piher** | The pi package (npm `piher`) registering `subagent` and `terminal` | yes |

## Install

piher is one pi package — the extension and its skill in one — so pi owns the whole lifecycle:

```sh
# herdr-core (required, once)
curl -fsSL https://releases.herdr.dev/core/install.sh | sh

# Herdr app (optional, display only): install from https://herdr.dev/

# the package, any one of:
pi install npm:piher                 # npm release
pi install ./packages/ext            # a local checkout (registered in settings.packages)
pi -e ./packages/ext/src/index.ts    # one session only, not persisted
```

| | npm release | local checkout |
|---|---|---|
| Install | `pi install npm:piher` | `pi install ./packages/ext` |
| Update | `pi update --extensions` | nothing to do: the linked directory is live |
| Remove | `pi remove npm:piher` | `pi remove ./packages/ext` |
| Version, changelog | *Extension Updates* on the next launch | *Extension Updates* on the next launch |

piher must be registered from exactly one source. Two registrations load the same tool names twice
and pi rejects the duplicate provider at launch, so `pi remove` the other source first.

If `hc` is missing, piher still loads but both tools answer with the core install command instead of
running anything — the preflight is in the tool result, not in a separate installer.

The old one-shot installer (`piher-setup`) is retired and no longer published: it only wrapped the
commands in the table above, and the `hc` preflight now travels with the package itself.

If a settlement notice ever arrives late or not at all, read the worker's own transcript first
(`subagent output`), then the session log: those two are the record, and nothing else is kept.

Hot reload while developing needs node's `--expose-internals` flag before pi's own entry point and
`PIHER_HMR=1`; without both there is no watcher.

## Use

1. Start core and open a terminal (`hc run --bg pi`, or a terminal from the Herdr app), then run `pi`
   inside it. The extension detects `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` and starts talking to core.
2. The model calls `subagent` (delegate) and `bg_job` (background shell).
3. Every worker shows up as a terminal; the app adopts it as an unfocused pane of the caller's tab, or
   as its own tab when the spawn asked for a different `tab`/`worktree`.
4. A human can attach to a worker's pane and talk to it directly. Status reaches the app through pi's
   native OSC 7501 report; piher never synthesizes it.
5. If core stops, its terminals are gone with it. `subagent(action: "resume", taskId)` revives a
   finished worker's task record in a new terminal.

## Compatibility and known limits

| Item | Status | Notes |
|---|---|---|
| herdr-core 0.1.16 / macOS | tested | `terminal.run` starts the pane, the app adopts it, OSC 7501 status, `terminal.read/wait/send` |
| herdr-core 0.1.16 / Windows | not tested | same RPC surface; path and quoting follow core |
| Linux | not tested (expected to work) | same POSIX branch as macOS |
| pi outside a core terminal | tested | degrades: `subagent` / `terminal` are not registered, nothing else breaks |
| Herdr app closed | by design | core keeps the terminals; the sidebar is complete when it reopens |
| core stopped or restarted | known limit | worker terminals are not re-created; `subagent resume` revives the task from its record |
| `terminal.send` | human-first gate | core refuses to type into a blocked terminal; piher surfaces it as a tool error |
| Human and machine on one pane | soft locks | machine messages travel as core documents, the keyboard channel belongs to the human; core parent notes are off for workers |

## Tests

From the repository root:

```sh
npm install --ignore-scripts
npm test        # typecheck + node --test
```
