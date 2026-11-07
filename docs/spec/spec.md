# Delegation state: one row, two documents, no status cache

purpose: a master never loses a worker it can still act on, and never acts on a state it only remembers.

done when: with the suite green, a session that spawns two workers, receives `session_start` with reason
`reload`, and lists them shows both and closes both by the refs it printed; after that `close`, neither a
reload nor any other session can list, send to, retry or resume either one; and no code path reads or
writes the repository ledger or a `piher.subs` session entry.

Ground: the design was agreed in the session that produced commits `9428251`, `02f3353` and `9c8cc2d`. The
superseded decisions are S73/S74 in the decisions index. This spec is the contract; it does not restate
the history.

## Domain

- **S1.** A *task* is one delegation unit: a spawned subagent, identified by a `taskId` minted at spawn. It
  is not a tool call, and `bg_job` is not a task — background jobs keep their own domain. (User: "que es un
  task en toda esta propuesta? representa a un subagente lanzado o bg shell o es cada action de tool
  subagente o bg shell?")
- **S2.** Every later action (`send`, `output`, `interrupt`, `retry`, `close`, `resume`) acts on the same
  task. The one exception: `retry` of a closed task or of a spent one-shot starts a **new** task with a new
  `taskId`, keeping the brief, the role and the checkout.
- **S3.** A task has exactly one *current generation*: `paneId`, `sessionFile`, `launchCommand`, `slug`,
  tab identity and `startedAt`. A revive replaces it wholesale. Earlier generations leave no durable trace.
- **S4.** A *session view* is the ordered set of `taskId`s one session delegated. A fork inherits its
  parent's view; a session never inherits any other session's view implicitly.

## Durability

- **S5.** There are exactly two durable documents, each with exactly one writer:
  - task record `<repo>/.piher/tasks/<taskId>.json` — the task, its current generation and its decision;
  - session view `<sessionDir>/piher/<sessionId>/tasks.json` — the ids this session works on.
- **S6.** Every write is atomic (temporary file + rename). A torn, foreign or absent document reads as "no
  record" and never raises.
- **S7.** A task record is never written by another session, and no document is kept by read-merge-write
  between sessions.
- **S8.** Nothing durable is pruned by age or by count. A task leaves use only through `close` or by
  deleting its record file.
- **S9.** `close` writes `closedAt` into the task record and is final for every session, forever. (User:
  "piens en close como la operacion del master para un agente que ya no nececita ... no habria porque
  nececitar revivir algo que ya se le hizo close".)
- **S10.** The durable facts are exactly: `taskId`, `description`, role, lifecycle, `cwd`, checkout record,
  `createdAt`, the current generation, `consumedAt`, `closedAt`, and the delivered-report fingerprint.
  Nothing else is written.
- **S11.** Liveness is an *observation*, never durable: terminal and agent status come from core and live
  in memory only. A restore must not resurrect a status.

## Semantics

- **S12.** Three predicates and no more: `isClosed(row)`, `isSpent(row)` (a one-shot whose report the
  master already consumed), `isActionable(row) = !isClosed && !isSpent`. Every surface derives from them;
  no stored status field exists.
- **S13.** `list` shows the session's actionable tasks, plus tasks of this repository whose pane is **alive**
  and whose owner is another session, marked as such. It never shows another session's task whose pane is
  gone.
- **S14.** `close` refuses a worker whose turn is in flight, naming `interrupt`, and otherwise reclaims its
  pane, tab and checkout.
- **S15.** `send` steers into a live pane; with no pane it revives a new generation of the same task; a
  closed or spent task is refused.
- **S16.** `resume` resolves the task record by `taskId` (or a prefix of it), refuses a closed task, and
  fails with a clear message when the transcript no longer exists.
- **S17.** Every id `list` prints resolves: `slug`, `paneId`, `slug@paneId`, and a `taskId` prefix.

## Surface

- **S18.** `/piher-tree` is removed together with its overlay, its tree projection and its port method. The
  resident widget (`piher-agents`) stays, fed by live observations. (User: "lo que si no quiero que
  desaparezca es ... los que salen de color blanco que dice a los agentes activos".)
- **S19.** The widget's overflow hint no longer names the removed command.
- **S20.** Gone, with no reader or writer left: the repository ledger, its row type and writers, the
  bounded registry tail, the zombie sweep, `piher.subs` session entries, and the temporary trace module
  with its document.
- **S21.** Vocabulary moves together: `SubEntry` becomes `TaskRow`, `subs` becomes `tasks`, and the three
  texts that describe the tool (description, manual, shipped skill) keep agreeing.

## Verification

- **S22.** Behavior is proven at three seams and no others: (a) unit tests for the document store and the
  predicates; (b) the plugin seam (`mountSubagent` + `runSubagent`, already the home of every action test)
  for spawn, reload, fork, list, send, close, retry and resume; (c) one integration test for the
  command/widget surface.

## Ownership and host edge cases

- **S23.** `list` marks another session's live task with the prefix `[otra sesión]` on the same line.
  *(Was open question U1; answered by the user.)*
- **S24.** `close` may be issued on another session's live task directly: it writes `closedAt` in that
  record, and the owning session sees it as final on its next read. No adoption step exists. *(Was U2.)*
- **S25.** When the host reports no transcript path, the session keeps its view in memory only and still
  writes task records under the repository. *(Was U3.)*

## Freshness

- **S26.** An observation never authorizes an action. `list` and every action probe core for the rows they
touch; the cached observation only supplies the state text that `list` and the widget print. A stale
observation can mislabel a row — never revive, close or steer the wrong one.

## Non-goals

- **N1.** No migration. Existing ledgers, `piher.subs` entries and registries are deleted, not read. (User:
  "no tengo la verdadera sesiones importantes puedes limpiar ledgers o cualquier cosa residual".)
- **N2.** No delegation history or audit log: debugging rests on each worker's own transcript and on pi's
  session log.
- **N3.** `bg_job` is out of scope and keeps its current behavior.
- **N4.** No new UI surface: the desktop app already shows the human-facing hierarchy.
- **N5.** No compatibility shim for documents written by older builds.

## Closed questions

None open. The three assumptions this spec carried were put to the user and answered before delivery; each
became a requirement rather than a footnote:

- **U1** — the label for another session's live task → **S23** (`[otra sesión]`).
- **U2** — whether closing another session's live task needs an adopt step → **S24** (no; the record write
  is the decision).
- **U3** — what a session does when the host reports no transcript path → **S25** (memory-only view, records
  still written).
