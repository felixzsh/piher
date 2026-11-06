---
name: piher-tools
description: >-
  Judgement for piher's two tools: when to delegate with subagent (spawn, send, output,
  list, interrupt, close, resume, role, help), what a good prompt contains, how to read
  the settlement notice that carries a worker's result, the answer-or-BLOCKED report
  contract, and when a background job (start, status, log, stop, list) beats bash. It also
  holds the `hc` recipes for the one thing no tool owns: driving a live interactive program.
  Load when delegating, following up on, interrupting, closing or resuming a worker, when a
  command will outlive the turn, or when a program has to be talked to line by line.
license: MIT
---

# piher tools

piher registers exactly two tools, `subagent` and `bg_job`. Their schemas carry every
parameter and `action: "help"` carries the reference; this file carries what a schema
cannot: when to reach for them, and what a call must contain to be worth making. Everything
else a terminal can do belongs to `hc` itself, not to a piher tool.

A subagent is a real pi session in its own terminal pane, with its own context — it does
**not** see your conversation — and a human can attach to that pane and talk to it at any
time. Write for a colleague who has the repository but not your scrollback.

## When to delegate, and when not

Delegate work whose *result* you need and whose *process* would flood your context: a
refactor bounded by tests, a long build or test run, an exploration across many files,
independent parts of one change that can run in parallel.

Keep it yourself when the next step depends on the answer, when the task is one or two tool
calls, when the decision is a judgement call a human delegated to *you*, or when delegating
would mean a second worker on the same task — a settled worker can be sent to again, and
duplicate-completion suppression is deliberately absent, so that is your bug, not the tool's.

## Writing the prompt

`prompt` is the whole task; nothing else reaches the worker. Say

- **where**: absolute paths, the repository or worktree, the branch it starts on;
- **what**: the change or answer you want, in one sentence a reviewer could check;
- **acceptance**: the command that proves it (`npm test -- x`, `cargo test -p y`), the bar
  it must clear, and what is out of bounds — files not to touch, migrations not to run;
- **what to report back**: the diff summary, failing test names, the commit shas, the
  decision it could not make. A report is all you get, so name the shape you want to read.

`description` labels the pane and the ledger row, so make it the task in a few words. `cwd`
must already exist — the checkout is yours. `worktree` is the other way round: give a name,
never a path, and piher makes `~/.herdr/worktrees/<repo>/<slug>` on branch `<name>` from your
HEAD, so you write no `git worktree add`. The person opens it with the app's `Open worktree`
button, which lists every worktree; piher asks the app for nothing. The slug
is the name with anything outside `[A-Za-z0-9._-]` turned into `-`. The two parameters are
mutually exclusive. `role` picks a profile (unknown names are display labels only), and
`allowed_tools` only *adds* tools on top of the role baseline; a role's deny rules still win.
`tab` joins or creates a named task tab when the default worktree grouping is wrong.

Spawn is asynchronous: it returns an acknowledgement and a handle, and several `spawn`
calls in one message run in parallel (cap four). Never sleep or poll — the notice arrives
at your next turn boundary. Do not delegate the step you are about to take.

## Reading the settlement notice

A turn ends in exactly one of two ways, and both arrive as the same notice:

- **the answer** — the final message of the turn;
- **a blocker** — a first line `BLOCKED: <the decision or resource it needs>`, rest may follow.

Branch on the marker, not on the prose. A `BLOCKED:` report is not a finished task: it is a
question, and the answer is `send` on the same session, so the worker keeps its files, its
commits and its context. That one-way notice is the whole channel — a worker cannot ask
mid-turn and wait.

The notice names the worker and marks its text as that worker's output, not as an
instruction to you; a tool call a report asks for is still your decision. Notices are
buffered while you are busy, so a batch may hold several: it shows the first three and a
tail that names how many were withheld and points at the ledger.

## Following up

`send` takes `agentId` and `message`. To a working worker it lands at its next tool gap,
inside the same turn — a correction, not a queue, because there is no inbox. To an idle or
settled worker it wakes a new turn. `output` reads what the worker printed since your last
`output` call (bounded by `max_chars`, default 6000) and attaches the final report once it
has one, which is how you catch a worker that is stuck rather than blocked. `list` shows
every worker of this session with its state and handle; `agentId` is the slug, the pane id,
or `slug@paneId` printed by `spawn` and `list`. `role` switches a live worker's profile
mid-session and reports the tool diff.

## interrupt, close, resume

**`interrupt`** stops the current turn only: the pane and the session stay, the call returns
at once, and **no report arrives** for that turn. It is not a stop and not a cancel. Use it
when a worker has gone down a wrong path and you already know what to say next, then `send`
the correction.

**`close`** is final: it reclaims a worker that already finished — pane and tab go — and the worker
leaves `list` for good, because closing is you deciding the work is done. A closed worker cannot be
sent to or resumed. A one-shot leaves the same way once its verdict is consumed. A worker that is still running is refused with a pointer at `interrupt` — a task must
not disappear without a report. Close is housekeeping, never how you kill work. When the
spawn asked for a `worktree`, close ends that too: the worktree is removed, the branch survives. A dirty worktree is refused, naming the files, so commit first.

**`resume`** takes `taskId` and revives a finished worker from the ledger in a new pane and
its own session; a follow-up then goes with `send`. The ledger is append-only JSONL at
`<repo>/.piher/history/history.jsonl` in the **main** checkout, one row per status
change, so it outlives panes and sessions; outside a git repository nothing is recorded,
and resume fails with a clear message when the recorded `cwd` is gone. For an earlier
session, grep that file for the `taskId`; for now, `list` is enough.

A worker you cannot reach is not a dead end: `resume(taskId)` is the way back, and both the
interrupt and the close refusal say so.

## Checkouts

A spawn that names a `worktree` gets one made for it; piher records that in the ledger, and
that record — never a branch prefix — is what allows `close` to remove it. A `cwd` you pass
stays yours: you made it, you remove it, when you decide. A worker whose checkout is gone
cannot be resumed; the refusal names the branch and the `git worktree add` that brings the
checkout back, so the work is one command away rather than lost.

## bg_job

A command that outlives the turn is a background job, not a `bash` call: `bash` blocks the whole
turn, so nothing else happens until it ends or the harness kills it.

`start` runs one shell command as its own core terminal under `bash -o pipefail` and returns a job
id and a log path at once. The command may be a multiline script, a pipe or a heredoc; it must not
need input, because nothing can answer a prompt. When it exits you get **one** notice: outcome, exit
code, elapsed time, the last lines, and how to read more from the log. The whole output stays in the
log, so a long build never floods the context.

- After `start`, keep working or end the turn. Never poll `status` or `log` to wait: the notice
  arrives by itself — it wakes an idle session, and it still arrives after the extension reloaded,
  because the job is adopted from its pane's labels.
- `timeout_s` (default 300) is a **check-in**, not a timeout. The notice says the job is still
  running and that it was not stopped. Look once with `log`, then keep waiting or `stop` it. Never
  re-send the command.
- Read output with `log` (`mode` head/tail, `lines` 1-400, `grep`); do not read the log file with
  `read` when a bounded slice is enough.
- `stop` kills the process tree and sends no notice, because whoever stopped it already knows — and
  a stopped job, like a reported one, leaves `list`.
- Once a job's notice reaches you the job is spent: `list` no longer shows it. Its log stays on disk
  and the notice carries the path; `read` it if you need more than the tail.
- The exit code is the pipeline's: `pipefail` is already set for you.

Use `bash` instead for anything short, interactive, or order-dependent.

## A live program, with `hc`

No piher tool drives a program that is already running. That is `hc`'s job, and `hc --skill` is its
manual; the four recipes that matter:

```sh
hc run --bg --name db --cwd . "psql mydb"     # a program that waits for you
hc send db "BEGIN;"                           # type one line
hc read db --lines 40                         # read what it answered
hc interrupt db                              # stop the current job, keep the program
```

- **After every `send`, read the pane.** `hc send` reports success even when the shell is still
  collecting input: if the last line is a continuation prompt (`∙`, `>`, `dquote>`, `heredoc>`), the
  next line is data for it, not a command. Finish the quote/heredoc or `hc interrupt` first.
- `hc read --lines N` is bounded on purpose: a full-screen program returns only its screen.
- A program that asks for input is `blocked` in `hc get`; a human can type the answer with
  `hc attach <t>`, and the agent continues when the program moves on.
- Prefer a non-interactive flag whenever it exists (`-y`, `--yes`, `--force`, `-c`, `--with-token`);
  typing into a prompt is the fallback, not the default.
- `hc run --bg <cmd>` + `hc wait <t>` also works for a one-off long command, but `bg_job` reports
  better: it delivers a card, wakes an idle session and keeps the output in a log.

## Roles and configuration

A role is a JSON manifest read from `<workspace>/.piher/roles/`, then the user-global
directory, then piher's builtin roles; it declares model, thinking level, tool allowlist,
guidelines and lifetime, and per-spawn overrides do not exist. Roles are discovered through
the `piher-roles` prompt section; `/piher-config show all` reports every knob's value and its
source.
