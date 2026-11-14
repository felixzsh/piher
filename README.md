<div align="center">

# piher

**pi** × h**er**dr — subagents and background jobs for [pi](https://pi.dev/), on [herdr-core](https://herdr.dev/).

</div>

`piher` is one pi extension. It gives a pi session two tools — `subagent` and `bg_job` — and runs
what they start as real terminals through [herdr-core](https://herdr.dev/) (`hc`), which the optional
**Herdr app** displays as spaces, tabs and panes. A subagent is a separate pi session in its own
terminal: its own context, visible to the person watching, and attachable at any time.

There is no app-side mod. piher writes terminals and labels through core; the app displays them by
its own rules.

## What it is

| Piece | Package | Role |
|---|---|---|
| **pi extension** | `packages/ext` (npm: [`piher`](https://www.npmjs.com/package/piher)) | Registers `subagent` and `bg_job`; starts, reads and reclaims their terminals through core; carries the role manifests and the task records |
| **herdr-core** | `hc` ≥ 0.1.16 | Terminal server: `terminal.run/read/wait/send/keys/interrupt/label/kill/rm`, `doc.get`/`doc.set` and `events.subscribe`, over its own socket (`HC_TERMINAL_SOCKET`) |
| **Herdr app** | `herdr-app` (optional) | Displays core terminals as spaces, tabs and panes; its built-in sidebar shows agents and raises blocked notifications |

## Architecture

- **One transport, and it is the core's own**: piher dials the `HC_TERMINAL_SOCKET` it inherits —
  core's JSON-RPC 2.0 endpoint — and `HC_TERMINAL_ID` is its own address. Both are injected by core
  and read-only for piher. One connection per request, plus one long-lived `events.subscribe` per
  worker. piher opens **no listener** and owns **no socket, pipe or channel of its own**; nothing
  survives from the private pipe this extension used to run.
- A worker is one `terminal.run {argv, cwd, env, labels: {herdr.space, herdr.tab}, noNotify: true}`
  call. Core starts the program; the app adopts that terminal as an unfocused pane of the caller's
  tab. A **new** `herdr.tab` id makes the app create a new tab — piher never does placement math. A
  spawn that asks for a `worktree` is the one exception on the app side: piher creates the checkout,
  and gives it no pane to live in: the app lists a pane-less worker under its parent in the agents
  view, where a person can peek at it, so a spawn no longer opens a pane beside the master. A worker
  in its own checkout is the exception — it carries a `herdr.space` label and the app creates that
  space from it (the app's worktree button), with the checkout as folder and no focus steal.
- A worker's process ends with its parent; piher closes terminals through `terminal.kill` +
  `terminal.rm`.
- **Status comes only from pi's native OSC 7501 report**, which core stores and the app renders.
  piher never writes terminal status.
- Metadata lives in **terminal labels**, and only ones with a reader inside piher: `piher.lock.<hash>`
  (write-lock beacons) and `piher.task` (the task a worker terminal was made for, written at spawn —
  what tells this task's worker from whatever a reused address holds now; spec S26). `hc get
  <terminal> --json` shows them. A worker's **session identity** comes from the core's own `hresume`
  label, written by the worker's Herdr extension — piher writes no session label of its own.
- Machine-to-machine messages are **core documents**, not a channel of piher's:
  `piher.rep.<address>` for a worker's report and `piher.cmd.<address>` for a steer or a replacement
  request. The core stores them, so neither a core restart nor a master restart loses a report, and a
  command carries the `taskId` it belongs to — an address alone restarts with the core and cannot
  identify a reader. Two keystrokes are piher's and only two: the worker's first task
  (`terminal.send`, with `enter` when the brief stayed in the composer — delivery proven by
  `started: true` or by a turn that began, never by an `idle` sample alone) and `interrupt`
  (`terminal.interrupt` presses the pane's own stop key, `esc` or `ctrl+c`). Everything else leaves
  the pane's keyboard to the person at it, and core's parent notes are disabled for worker terminals
  (`noNotify: true`).
- State arrives through core's `events.subscribe` (`status` / `turn` / `finished` / `labels`); a
  snapshot is pulled only when an event fires or a `missed` event says to resync. Nothing polls a
  worker's state.
- **A settlement is `turn` plus the report document** — never a timer, pane text or a parsed
  transcript. The only timer left in settlement is the silence budget, and what it produces is a
  notice that the worker never reported, not a verdict about what it did.

## The two tools

### `subagent`

One worker = one pi session in one core terminal. `spawn` returns an acknowledgement at once — the
worker's result arrives later, as a settlement notice at the caller's next turn boundary.

| Action | What it does |
|---|---|
| `spawn` (default) | Start a worker from `prompt` (the whole task), `description`, `cwd` **or** `worktree`, `role`, `allowed_tools`, `tab`. Several spawns in one message run in parallel (cap four) |
| `send` | Follow-up steered between tool calls; a task with no pane revives first, a closed or spent one is refused |
| `output` | What the worker printed since the previous `output` call, plus the final report once it has one |
| `reports` | The bodies a notice withheld, by the `ids` that notice printed — one turn instead of ten |
| `inbox` | The facts after `since` (default: this session's delivered cursor), `limit` at a time — how a lost notice is recovered without guessing |
| `list` | Every actionable task with state, handle, role and last activity, plus another session's live ones marked |
| `interrupt` | Abort the current turn only — the pane and its session stay, and no report arrives for that turn |
| `retry` | Re-send the stored spawn prompt after a fault outside the task; a closed task starts a new one |
| `resume` | Revive an unfinished task (`taskId`) in a new generation, reusing a live pane when one exists |
| `close` | Reclaim a finished worker: pane and tab go, the record keeps the decision — final for every session. A turn in flight is refused (interrupt first) |
| `help` | The full manual: placement, role profiles, the two documents, every parameter |

A task is addressed by `agentId`: the slug printed by `spawn`/`list`, the bare pane id, or the
combined `slug@paneId`.

`worktree: "<name>"` makes piher create `~/.herdr/worktrees/<repo>/<slug>` on branch `<name>` from
the caller's HEAD and record the checkout in the task record; repeating it reuses the checkout that
already sits on that branch. The worker then opens in its own app space, the same window the app's
worktree button makes. `close` ends it: the space closes and the checkout is removed, the branch
survives, and a dirty checkout is refused naming the files. A **one-shot closes only its space** —
the checkout stays, because merging is the master's decision. Closing a space is the one thing that
needs `herdr-app`, and it is best effort: an unreachable window leaves an empty space, never lost work. `cwd` is the other way round: a checkout the caller already has stays the caller's
to remove.

A role's `lifecycle` decides how long its worker lives — `one-shot` reports once and exits,
`persistent` (the default) stays until the master closes it — and the spawn acknowledgement says
which one was launched. A role that declares `lifecycle: "one-shot"` is reclaimed once its verdict is consumed,
and leaves `list` with it: a one-shot is spent when its result arrives. `close` is the same decision
for a persistent worker — after it, the worker is gone from `list` and cannot be resumed.

### `bg_job`

One shell command as its own core terminal, reported once when it exits. The command runs under
`bash -o pipefail`, so any multiline script, pipe or heredoc works and the exit code is the
pipeline's; nothing is typed at a prompt, so no command has to be a single line.

| Action | What it does |
|---|---|
| `start` | Run `command` in the background (`name`, `cwd`, `timeout_s`); returns a job id and the log path |
| `status` | One job's state, exit code, elapsed time, pane and log, with the last lines |
| `log` | A bounded slice of the log: `mode` (`head`/`tail`), `lines` (1-400), `grep` |
| `stop` | Kill the job's process tree; a stopped job never notifies |
| `list` | Jobs still yours: running, or finished with the notice not yet delivered |

A job is spent once its notice is handed over: it leaves `list`, its pane stops advertising it, and
only a short tail stays addressable by id (`status`, `log`) — the log file itself is permanent. A job
survives a reload of the extension: every job pane carries its id, log, start time and check-in
budget in labels, so the next mount asks core what is still running, re-arms the watch and reports a
job that exited while nobody was listening. The notice is the only thing the model receives:
outcome, exit code, elapsed time, the last lines and how to read more. The whole output stays in the log, so a long build never floods the context, and
`timeout_s` (default 300) produces a **check-in**, not a failure — the job keeps running and the
notice says so first. A settle wakes an idle session; a check-in does not.

Interactive shells are not a tool: they belong to `hc` itself (`hc run --bg bash`, `hc send`,
`hc read --lines`, `hc keys`, `hc interrupt`), and the bundled `piher-tools` skill tells a session
when to reach for them.

## Commands

| Command | Purpose |
|---|---|
| `/piher-role` | Without arguments: the current role and the available names. `/piher-role <name>` switches mid-session (widening beyond the current toolset asks for confirmation) |
| `/piher-config` | Read-only configuration guide: the plane index, `show [roles\|env\|all]` with effective value and source, `check`, `doc` |
| `/piher-locks` | Write locks held by this pane and by live panes — the human view of the `piher.lock.<hash>` labels |

## Roles

A role is a JSON manifest that decides what a worker is: `model`, `thinking`, `lifecycle`
(`persistent` or `one-shot`), `instructions`, `modelInvocable`, `guidelines`, and a `manifest` of
tool rules (`tools`, `rules`, `unknownTools`).

Layers, in order: `<cwd>/.piher/roles/<name>.json` → `~/.pi/agent/piher/roles/<name>.json` → the
bundled `src/roles/`. `master` and `worker-default` are reserved and read only from the bundle. Names
are `[a-z0-9-]+`; a malformed manifest is an error at the layer that holds it instead of silently
falling through.

The caller's model learns which roles exist from a derived `piher-roles` prompt section, not from a
skill file, so a role added to a directory appears without editing any text. Deny rules are not
bypassable: a denied tool call returns `terminate`, so a batch whose results are all terminating ends
without another model round trip.

### `hc` templates come from the manifests

A role is declared once, in its manifest. `hc run <role> "task"` needs the same role as a Markdown
template in `~/.config/herdr-core/templates/<role>.md`, so those files are **generated**: the
frontmatter (`name`, `description`, `command`) is the manifest's model, thinking level and tool set,
and the body is the standing brief. Regenerating rewrites only the frontmatter and keeps a
hand-written body, and an integration test fails when the two disagree — the drift that once had
`subagent spawn {role:"reviewer"}` and `hc run reviewer` launching different models.

## The task documents

One spawned worker is one task, and a task is three things: one record per task at
`<repo>/.piher/tasks/<taskId>.json` in the **main** checkout — a worker in a linked worktree records
into the repository, never into the worktree — this session's settlement ledger beside it, and this
session's view. Liveness is observed, never stored: `list` shows `running`, `idle`, `no report` or
`no pane` from live probes, not from a saved status. `close` is final for every session, so further
work always starts a new subagent. Outside a git repository nothing is recorded and `resume` says
so.

The ledger (`settlement-<sessionId>.jsonl`) is append-only, one line per fact, and its cursor is
written **only after pi accepted the message**: a crash, a `/reload` or a compaction re-delivers
what was never read instead of losing it, and every fact carries its (`taskId`, `turn`) so a repeat
is recognisable rather than silent. `inbox` reads those facts, `reports` reads the withheld bodies
from the same documents, and a report outlives its pane, its record and a core restart.

On the parent side, a finished worker's result arrives as a notice that names the worker and marks
its text as that worker's output; while the parent is busy, notices are buffered and the batch shows
the first few plus a tail that says how many were withheld. Report text is budgeted twice — 4 KiB
inline per delivery, 32 KiB across a session with a durable counter — and past either ceiling a row
arrives with a pointer instead of a body, saying which budget withheld it. A compaction pauses the
buffer, so a settlement that lands mid-cut is delivered after it, with a roster of running,
settled-unread and failed tasks riding the same message.

A worker is a real pi process, measured here at a median 212 MB RSS: about twenty fit this machine
and forty do not. The extension states that limit instead of hiding it.

## Install

### Requirements

- Node ≥ 22
- pi ≥ 1.4.0 (`@earendil-works/pi-coding-agent`) — its native OSC 7501 program-status reporter is the
  only status source
- herdr-core ≥ 0.1.16 (`hc`) — `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`
- Herdr app (optional) — without it pi still runs and piher still spawns workers; you just cannot
  watch them in a window

### Install

piher is one pi package — the extension and its skill in one — so pi owns installing, updating and
removing it:

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh   # herdr-core, once
pi install npm:piher                                         # the extension
```

| Task | Command |
|---|---|
| Update | `pi update --extensions` |
| Remove | `pi remove npm:piher` |
| Version, changelog | pi shows it under *Extension Updates* on the next launch |

Dev mode links a clone instead, so code edits are live:

```sh
git clone <this repo> && cd <this repo>
pi install ./packages/ext
```

piher must be registered in pi from exactly one source: two registrations load the same tool names
twice and pi rejects the duplicate provider at launch. `pi remove` the other source first.

## Scope — what the extension changes

After install, piher is live in every pi session, not only inside a core terminal.

| Surface | Bare `pi` | Inside a herdr-core terminal |
|---|---|---|
| `subagent`, `bg_job` | **not registered** | live |
| Worker-terminal rules, write locks, core documents | off | live |
| Role manifest and its visible-tool layer (`setActiveTools`) | off | on |
| Session entries of the extension's own types | replayed from the transcript | live |

Outside core, a session still replays what it recorded before, so a resumed transcript keeps its
delegation cards. Detection is `HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`.

## Configuration

Runtime policy is one registry (`packages/ext/src/options.ts`); every knob is milliseconds unless
noted. `PIHER_*` is the only namespace.

| Variable | Default | Purpose |
|---|---|---|
| `PIHER_SUBAGENT_TIMEOUT_MS` | `300000` | Silence budget: how long a worker may say nothing before the master is told it never reported |
| `PIHER_READY_TIMEOUT_MS` | `90000` | How long a spawned pane gets to report ready and take its first message (a dead pane fails fast) |
| `PIHER_COMMAND_PICKUP_MS` | `1500` | Read-back budget of a steering command (`0`: no wait) |
| `PIHER_GC_TICK_MS` | `30000` | Idle GC sweep cadence |
| `PIHER_SESSION_TTL_SECONDS` | `600` | Session retention after a worker exits, before GC |
| `PIHER_NOTICE_BODY_BUDGET_BYTES` | `4096` | Report text one settlement delivery carries inline; over it the notice is a row with a pointer |
| `PIHER_SESSION_REPORT_BUDGET_BYTES` | `32768` | Report text one session carries inline across every delivery; once spent, further reports arrive as rows |
| `PIHER_GIT_TIMEOUT_MS` | `10000` | git command timeout (worktree creation, status probes) |
| `PIHER_JOBS_DIR` | system temp `piher-jobs` | Directory receiving one log file per background job |
| `PIHER_WRITE_LOCK` | – | `1` makes a conflicting `write`/`edit` block instead of warn |
| `PIHER_HMR` | – | Dev only: enable the cordis HMR boundary (needs `--expose-internals`) |

`PIHER_SUBAGENT`, `PIHER_DELEGATION`, `PIHER_ROLE_MANIFEST` and `PIHER_ROLE_BASE` are contracts
handed to a child at spawn, not knobs to set by hand. Core's own `HC_*` variables are core's.

The same values are inspectable in-session, read-only:

```text
/piher-config            # plane index; hands a guided change to the agent
/piher-config show all   # effective value + source per key (env > default; roles are per-file)
/piher-config check      # validation across planes   ·   /piher-config doc → written report
```

See [docs/configuration.md](docs/configuration.md) for the plane map and the "which plane do I edit?"
table.

## Plugin conflicts

pi keeps one provider per tool name and refuses to load a second one, so two extensions that register
`subagent` cannot coexist — the second one is a hard load failure. Do not install alongside another
extension that owns `subagent` (for example `@tintinweb/pi-subagents`, `@minhduydev/pi-subagents` or
`pi-herdr-subagents`), and do not add a second OSC 7501 status reporter for the same terminal.

## Design principles

- **The session transcript is the source of truth**: delegations and role switches replay
  from session branches, so a restart or a branch switch stays correct.
- **Event-driven, never poll**: core's `events.subscribe` drives state. The two timers that remain —
  the silence budget and the pane GC sweep — produce a notice or a sweep, never a verdict about
  whether a worker finished.
- **Zero app-side mod**: piher writes terminals and labels through core; the app decides how they look.
- **PTY input belongs to humans**: machine-to-machine messages travel as core documents; core's
  parent notes are off for worker terminals.
- **Best-effort metadata**: a label or notice failure is swallowed and never blocks the session.

## Repository layout

```
packages/
  ext/             # the pi package (npm: piher): tools, core client, roles, skill
docs/              # install guide, configuration overview, decision index, release process
```

## Development

```sh
npm install --ignore-scripts
npm test                  # typecheck + the whole suite (652 tests, ~25 s)
npm run test:mutation
```

`test/integration/` gathers what spawns a process, opens a socket, touches a real git worktree or
boots the composition root; the rest is pure logic. That is directory order, not a separate command —
the same `npm test` runs both, in about half a minute. One test stays skipped on purpose: E10, the
per-worker subscription cost, is a limit of the core, written down in
[docs/spec/hc-native/invariants.md](docs/spec/hc-native/invariants.md).

## License

MIT
