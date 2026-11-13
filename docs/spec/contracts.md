# Tool contracts

What each `subagent` action promises, what it writes, and the refusals that must survive the refactor.
Existing user-facing strings are kept where they already say the right thing; a string that mentions a
removed concept (`settled`, the ledger, `/piher-tree`) is rewritten.

## Refusals (kept verbatim where they already hold)

- Close on a worker with a turn in flight:
  `Error: subagent <ref> is still running — close only reclaims a worker that already finished, and a task must not disappear without a report. Use action "interrupt" to stop its current turn (the pane and its session stay), then close it once it settles.`
  → the trailing sentence loses "once it settles" with S12; it becomes `…then close it once it has finished.`
- Close on an already closed task:
  `Subagent <ref> is already closed (pane and tab gone); action resume with taskId <taskId> revives its session.`
  → **changes**, because S9 makes `close` final: `Error: task <taskId> was closed by the master; close is final, so there is nothing to resume or send to. Start a new subagent for further work.`
- Resume or send on a closed task: the message above.
- Resume on a spent one-shot:
  `Error: task <taskId> was a one-shot and already delivered its verdict; there is nothing to resume. Spawn a new one-shot for new work.`
- Resume whose transcript is gone: names the task, the path it expected, and offers `retry` as the way out.
- Resume with no session anywhere (P5): names the three places it looked — the core's `hresume` label on
the record's address, the `session` field the settlement document reported, and the record itself — and
says that reviving without one starts a fresh conversation. It reports only what it established: a null
from the label read is "no label, no terminal, or the core did not answer", and the document is read
before the refusal is printed. Fixed shape, extended by P5: `Error: task <taskId> has no session to
resume: its core terminal is gone, its settlement document reported no session, and its record carries
none — reviving it would start a fresh conversation. Use action "spawn" for new work, or "retry" to
start a new task from the same brief.`
- Unknown id: `Error: unknown subagent id "<raw>" (see action list)` — printed only after the view, the
  records of this repository, and the id forms of S17 have all missed.

## spawn

Input: `prompt` (complete brief), `description`, `role`, `cwd` | `worktree`, `tab`. Writes one record and
appends its id to the view, then answers with `started subagent <slug>@<paneId> (task <taskId>, …)` and
returns. The prompt is stored beside the user's agent directory so `retry` can resend it for free.

## list

One line per row, `<slug>@<paneId> [<state>] (<kind> · <lifecycle>) <description>`, where the state text
derives from the three predicates plus the observed status:

| situation | state text |
|---|---|
| turn in flight (core says working/blocked) | `running` |
| no turn in flight, report consumed | `idle` |
| no turn in flight, no report consumed | `no report` |
| pane gone, task unresolved | `no pane` |
| another session's task, pane alive (**S13/S23**) | the same line, prefixed `[otra sesión] ` |

A closed or spent row is never printed. Empty answer: `No subagents started (from this session view).`

## send

`agentId` + `message`. Live pane: steered at its next tool gap (`Message sent to subagent <ref>.`). Pane
gone and the task is unresolved: a new generation is revived first, then the text is delivered. Closed or
spent: refused.

## output

`agentId`, `max_chars` (100-16000), `full`. Reads the transcript; a finished turn yields its final report,
a live one the latest lines. Never writes a document.

## interrupt

`agentId`. Stops the current turn only; the pane, the transcript and the record stay. A task with no turn
in flight is refused, naming `close` (the natural next step) rather than a wait.

## retry

`agentId` or `taskId`, no message. Same task: resend the stored brief. Closed task or spent one-shot: a new
task with the same brief, role and checkout. No stored brief: refused, naming `send`.

## close

`agentId`. Refuses a turn in flight (above), otherwise retires the pane and tab, releases the checkout when
the spawn created one, and writes `closedAt`. The record survives, so the answer of a later `close` is the
finality message above.

A task that belongs to another session is closed the same way, with no adoption step: the record write **is**
the decision, and the owning session drops the row on its next read (**S24**).

## resume

`taskId` (prefix accepted). Requires an unresolved task whose transcript still exists. Revives a new
generation in the checkout the record names and answers with the new ref. Three answers, not two: the
session was restored from the document's own report, the session was restored from the core's `hresume`
label, or there was no session and the refusal above was printed. The label's `agent` must be `pi` and the
terminal must still be the task's own — an address alone never identifies a conversation (**S18**,
**S26**).

## help

One inline result: the actions, the parameters, and the placement/role notes. It names the two documents and
the fact that `close` is final; it no longer mentions a ledger.

## The three texts

The tool `description`, the manual returned by `help`, and the shipped skill in `packages/ext/skills/` are
one document in three places: the existing coverage test extracts actions and parameters from all three and
fails on divergence. This refactor changes vocabulary, not shape, so all three move in the same commit.
