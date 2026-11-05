# Install and use

Two programs and one extension:

| Piece | What it is | Needed |
|---|---|---|
| **herdr-core** (`hc`) | Terminal server. piher starts, reads and reclaims terminals through it | yes |
| **Herdr app** (`herdr-app`) | Shows those terminals as spaces, tabs and panes | optional |
| **piher** | The pi extension (npm `piher`) registering `subagent` and `terminal` | yes |

## One-shot install (recommended)

```sh
npx piher-setup@latest            # user mode: pi install npm:piher (preflights node / pi / hc)
npx piher-setup@latest version    # local vs npm latest (installer / extension / herdr-core)
npx piher-setup@latest update     # refresh the extension in place (does not uninstall first)
npx piher-setup@latest uninstall
```

Pin `@latest` so npx does not reuse a cached installer. The installer never writes core's own
configuration; upgrade core with `hc update`.

| | User mode (default) | Dev mode (`--dev`) |
|---|---|---|
| The extension | `pi install npm:piher` | `pi install ./packages/ext` (local path) |
| Versions | `npx piher-setup@latest version` | `node install.mjs version --dev` |
| Update | `npx piher-setup@latest update` (`pi update`, no uninstall) | re-checks versions only; the linked directory is live |
| Uninstall | `npx piher-setup@latest uninstall` | same |

piher must be registered from exactly one source. Two registrations load the same tool names twice
and pi rejects the duplicate provider at launch, so `install`/`update` stop with exit 1 and print the
`pi remove …` to run first.

## Manual install

```sh
# herdr-core (required)
curl -fsSL https://releases.herdr.dev/core/install.sh | sh

# Herdr app (optional, display only)
# install from https://herdr.dev/

# the extension, any one of:
pi install npm:piher                 # npm release
pi install ./packages/ext            # a local checkout (registered in settings.packages)
pi -e ./packages/ext/src/index.ts    # one session only, not persisted
```

Hot reload while developing needs node's `--expose-internals` flag before pi's own entry point and
`PIHER_HMR=1`; without both there is no watcher.

## Use

1. Start core and open a terminal (`hc run --bg pi`, or a terminal from the Herdr app), then run `pi`
   inside it. The extension detects `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET` and starts talking to core.
2. The model calls `subagent` (delegate) and `terminal` (persistent shell).
3. Every worker shows up as a terminal; the app adopts it as an unfocused pane of the caller's tab, or
   as its own tab when the spawn asked for a different `tab`/`worktree`.
4. A human can attach to a worker's pane and talk to it directly. Status reaches the app through pi's
   native OSC 7501 report; piher never synthesizes it.
5. If core stops, its terminals are gone with it. `subagent(action: "resume", taskId)` revives a
   finished worker from the ledger in a new terminal.

## Compatibility and known limits

| Item | Status | Notes |
|---|---|---|
| herdr-core 0.1.16 / macOS | tested | `terminal.run` starts the pane, the app adopts it, OSC 7501 status, `terminal.read/wait/send` |
| herdr-core 0.1.16 / Windows | not tested | same RPC surface; path and quoting follow core |
| Linux | not tested (expected to work) | same POSIX branch as macOS |
| pi outside a core terminal | tested | degrades: `subagent` / `terminal` are not registered, nothing else breaks |
| Herdr app closed | by design | core keeps the terminals; the sidebar is complete when it reopens |
| core stopped or restarted | known limit | worker terminals are not re-created; use the ledger's `subagent resume` |
| `terminal.send` | human-first gate | core refuses to type into a blocked terminal; piher surfaces it as a tool error |
| Human and machine on one pane | soft locks | machine messages use pipe-channel, the keyboard channel belongs to the human; core parent notes are off for workers |

## Tests

From the repository root:

```sh
npm install --ignore-scripts
npm test        # typecheck + node --test
```
