# Design decisions

Each row states a rule the code still holds, with a `path:line` anchor so a module rename or a shrink
cannot quietly rot the entry. IDs are the shorthand the source comments use (`D45`, `S52`, …), which
makes a comment like `// D45: PTY input is for humans` resolvable from here.

`packages/ext/test/doc-anchors.test.ts` enforces the anchors: a row that points past the end of a file,
or at a file that no longer exists, fails the suite.

| ID | Decision | Anchor |
|---|---|---|
| WS-D7 | The master pane applies its own role manifest through the same gate as a worker: nothing is exempt because it happens to be the caller | `packages/ext/src/index-roles.ts:1` |
| WS-D10 | A role may pin `provider/model`; the spawn passes them to the child as argv, and an omitted field falls back to the process default | `packages/ext/src/subagent-core.ts:474` |
| D10 | The subagent lifecycle has one owner module: planners and call sites share it, so placement, launch, readiness and settle cannot drift apart | `packages/ext/src/subagent-core.ts:1` |
| D11 | The built-in role names (`master`, `worker-default`) are read from the bundle only, so a workspace or user file cannot hijack them | `packages/ext/src/role-loader.ts:30` |
| D29 | Task-tab GC is a pure decision function: a consumed pane is closed, a pane no live task claims is never touched | `packages/ext/src/gc-core.ts:1` |
| D45 | ~~PTY input belongs to the human at that pane~~ narrowed to what still holds: piher types exactly two keystrokes of its own — the first task (`terminal.send`, then `enter` when the brief stayed in the composer, S14/S25) and `interrupt`'s stop key (`terminal.interrupt`) — and never writes any other key; core's parent notes stay disabled for worker terminals (`noNotify: true`) | `packages/ext/src/core-client.ts:1` |
| D47 | ~~Machine-to-machine traffic goes through the extension's own pipe channel, never through PTY injection, so the transcript stays clean~~ superseded by the core documents (S6–S15): a report, a steer and a replacement request are document values and piher opens no socket. "Never the PTY" does not hold as written: two keystrokes remain piher's — the first task's `terminal.send` (spec S14/S25) and `interrupt`'s stop key (`terminal.interrupt`), both addressed to the worker's own pane | `packages/ext/src/report-documents.ts:1` |
| D48 | ~~Each pane serves its own pipe name, so no side has to assume a controller/child role~~ superseded: a worker's address names its documents (`piher.rep.<address>`, `piher.cmd.<address>`), and nothing listens | `packages/ext/src/report-documents.ts:42` |
| D49 | ~~A reply follows the pipe name the sender declared, instead of a hard-coded route~~ superseded: the settlement is a document the master's poll loop reads, so there is no route to declare | `packages/ext/src/report-documents.ts:52` |
| D50 | ~~The latest machine request per pane is tracked, so an interrupt is claimed once and a settlement reply can be pushed without a round trip~~ superseded, and narrowed: the only thing still tracked per pane is the request boundary (`injectTs`) that a settle's `sinceTs` is judged against — there is no request id and no claim-once latch, the settlement's identity is the document instance (`address`, `at`), and `interrupt` is the core's own `terminal.interrupt` | `packages/ext/src/report-documents.ts:78` |
| D76 | Role manifest v2 with a fail-closed validator: an unknown rule value is an error at load, not a silent refusal at call time | `packages/ext/src/role-manifest.ts:1` |
| D77 | The visible-tool layer hides tools outside the manifest *after* every plugin has registered, so a role cannot see what it may not call | `packages/ext/src/index-roles.ts:1` |
| D78 | The master composes a cordis tree for its plugins; a worker process bypasses it entirely | `packages/ext/src/bootstrap.ts:1` |
| D79 | One disposal ledger compensates HMR reloads and session shutdown alike | `packages/ext/src/ledger.ts:1` |
| D80 | Loader, group and timer plugins mount in order so declarations resolve; HMR is a development path only | `packages/ext/src/bootstrap.ts:20` |
| D81 | Three-way split: entry (mode selection), pure core (testable planners), platform adapter (core client) | `packages/ext/src/bootstrap.ts:1` |
| D82 | `unknownTools: allow\|deny` states what happens to a tool a role has never heard of — a newly installed extension tool is governed on purpose, not by silence | `packages/ext/schemas/role-manifest.schema.json:1` |
| D83 | `worker-default` mirrors the master's tools minus `subagent` and `bg_job`, and those families are denied explicitly: a worker owns no other worker | `packages/ext/src/role-loader.ts:1` |
| D86 | Workers group by git worktree: a worker in the caller's checkout shares its tab, one in another worktree gets the tab named after it, and the main tab is never closed wholesale | `packages/ext/src/subagent-core.ts:1` |
| D92 | A settlement that lands while the parent is mid-turn waits in a notice buffer instead of being dropped by pi's prompt rejection | `packages/ext/src/index-notices.ts:1` |
| D94 | A terminal that already runs the same session is reused, so two pi processes never compete over one transcript | `packages/ext/src/subagent-spawn.ts:393` |
| D96 | When the caller settles while workers still run, one reminder is injected per run set (de-duplicated, cooled down, suppressed by an abort) | `packages/ext/src/settle-wake-core.ts:1` |
| D97 | Fullscreen TUI mode is what turns a pane into a static frame the caller can read without ANSI reflow | `packages/ext/src/subagent-core.ts:474` |
| D98 | Execution is a program, not a typed shell line: `bg_job` runs an argv and core reports the child's exit, so no sentinel is parsed from a screen | `packages/ext/src/bg-job-core.ts:1` |
| D102 | A worker is spent when the master was told: a consumed one-shot or a closed one leaves `list`, and `resume` exists only for work left unfinished | `packages/ext/src/plugins/subagent.ts:1` |
| D101 | A `bg_job` job is adopted by label after a reload: core knows what is alive, so an in-memory registry never decides whether the launcher gets told | `packages/ext/src/bg-job-core.ts:1` |
| D100 | A checkout worker opens its app space by `herdr.space` label alone (the app creates an unknown space from it); only closing that space calls `herdr-app`, best effort | `packages/ext/src/worktree.ts:1` |
| D106 | A persistent worker's pane is never reclaimed by housekeeping: killing it costs a cold start and revives a conversation that was never over | `packages/ext/src/gc-core.ts:35` |
| D105 | Housekeeping reclaims panes and tabs but never ends a task: a vanished pane leaves the row as it is (listed as `no pane`, revivable by `send` or `resume`), and only `close` ends the task | `packages/ext/src/subagent-gc.ts:1` |
| D104 | A worker terminal carries no placement label: it never becomes a pane, and the app's agents view still nests it under its parent (the agents mod walks the core's terminals, not the panes) | `packages/ext/src/subagent-spawn.ts:1` |
| D103 | A one-shot closes its space but never its checkout: the working tree is what the master reviews before deciding to merge | `packages/ext/src/plugins/subagent.ts:1` |
| D99 | There is no `terminal` tool: an interactive shell is `hc`'s business through the bundled skill, so the extension never re-implements a PTY CLI | `packages/ext/skills/piher-tools/SKILL.md:1` |
| D104 | The config catalog is one plane map: roles are per file, env is per process, and every value reports its source | `packages/ext/src/config-catalog-core.ts:1` |
| D114 | Delegation state is two documents written through one store: a record per task under `<repo>/.piher/tasks` plus the session's view; nothing else under `.piher/` is delegation state | `packages/ext/src/task-store.ts:1` |
| D115 | Three predicates decide a row's fate — `isClosed`, `isSpent`, `isActionable` — and nothing else in the codebase may interpret a row | `packages/ext/src/task-row.ts:1` |
| D116 | Liveness is observed, never stored: `list` probes panes and transcripts at call time, and a stale observation may mislabel a row but never steers, revives or closes one | `packages/ext/src/task-row.ts:1` |
| D117 | Close is final for every session: a closed task refuses `send`, `resume` and `interrupt` — no turn left to steer or stop — while `retry` starts a new task with the stored brief | `packages/ext/src/plugins/subagent.ts:1` |
| D118 | Ownership derives from the session view: an actionable record outside it belongs to another session, listed but acted on only by `interrupt`, `output` and `close` | `packages/ext/src/plugins/subagent.ts:1` |
| S1 | The package is the delegation surface: role manifests and tool wiring live here, and a workflow policy belongs to the prompt that asks for it | `packages/ext/src/index.ts:1` |
| S2 | Write locks are a soft veto by default and a hard one under `PIHER_WRITE_LOCK=1`; the warning names every holder | `packages/ext/src/lock-core.ts:1` |
| S9 | A role may declare `lifecycle`; only `one-shot` changes behaviour (the worker is reclaimed at its settlement), and an unresolvable role never reclaims a pane by surprise | `packages/ext/src/role-manifest.ts:1` |
| S10 | The registered tool set is exactly `{subagent, bg_job}`, asserted by a test, because pi keeps one provider per tool name | `packages/ext/test/integration/tool-scope.test.ts:1` |
| S20 | The role menu is derived from the manifests on every turn, so a role added to a directory appears without editing any shipped text | `packages/ext/src/role-catalog.ts:1` |
| S21 | The catalog rides the prompt: an action would spend a round trip on text that fits in the request for free | `packages/ext/src/role-catalog.ts:1` |
| S22 | A role switch is the one recompute point for the visible tool set; a widen from a human asks first | `packages/ext/src/role-state.ts:1` |
| S41 | One task directory per repository: a spawn or resume asked from a linked worktree resolves the main checkout's `<repo>/.piher/tasks`, not its own | `packages/ext/src/storage-layout.ts:1` |
| S50 | The admission slot covers pane creation only, so a resume waiting for its agent to report ready cannot starve a spawn behind it | `packages/ext/src/subagent-core.ts:110` |
| S52 | An interrupted turn reports nothing: the settlement notice hangs off the report document, and an aborted settle never writes one | `packages/ext/src/index.ts:1` |
| S53 | `close` reclaims a worker that already finished — `terminal.kill` then `terminal.rm`, the app closes the pane, the record keeps the decision and later calls are refused | `packages/ext/src/plugins/subagent.ts:1` |
| S54 | The report document comes before the shutdown: a worker whose report never reached the caller's document store must not exit as if it had | `packages/ext/src/index.ts:1` |
| S57 | A settlement renders as one card header (name, role, outcome, elapsed) while the text the caller receives stays plain | `packages/ext/src/settlement-card.ts:1` |
| S64 | A background job gets exactly one completion notice: its real exit code, the last lines and the path of the full log | `packages/ext/src/bg-job-core.ts:1` |
| S69 | Nothing under the per-session root is the extension's to prune; the transcript and the task records are the record | `packages/ext/src/index.ts:1` |
| S70 | The three texts that describe `subagent` (tool description, manual, skill) cannot diverge: a test extracts the actions and parameters and fails on a gap | `packages/ext/test/skill-coverage.test.ts:1` |
| S71 | A persisted checkout record is trusted only when its path and branch are readable; an occupied path fails naming both | `packages/ext/src/worktree.ts:1` |
| S72 | The checkout's task record is what `resume` and `close` read, so a restart finds the worktree without listing or pattern-matching | `packages/ext/src/subagent-spawn.ts:1` |
| S73 | ~~The persisted registry keeps running workers and a bounded tail of settled ones~~ superseded by S74: a bounded restore is what dropped a worker the master still had to close | `packages/ext/src/subagent-core.ts:1` |
| S74 | ~~The registry is one document per session (`<sessionDir>/piher/<id>/registry.json`), rewritten in place with every row~~ superseded by the task record + session view: one record per task (`<repo>/.piher/tasks/<taskId>.json`) plus the session's ordered ids (`<sessionDir>/piher/<id>/tasks.json`), and a fork inherits the view by copy | `packages/ext/src/task-store.ts:1` |
