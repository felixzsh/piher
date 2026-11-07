# Plan — delegation state refactor

spec: `docs/spec/spec.md` · domain and storage: `docs/spec/domain.md` · tool contracts: `docs/spec/contracts.md`

base: `master` @ `9c8cc2d` · push: **no** · parallel: **no** (one checkout, phases sequential) ·
red-at-end: **not allowed** (a phase that leaves the suite red is not accepted)

Delivery policy confirmed by the user before P1, together with the spec and this split: base `master`, no
push, no parallel phases, every phase boundary green. Nothing here is provisional; `spec-loop` starts from
this file alone.

checks (once, run at every phase boundary):

```sh
npm test                                    # from the repo root: tsc --noEmit + the whole suite
rg -n "history\.jsonl|piher\.subs|HistoryEntry|piher-tree" packages/ext/src   # must be empty at the end
```

## Non-goals

- No migration of existing state (spec N1): old ledgers, `piher.subs` entries and registries are deleted.
- No new tool actions, no new UI, no `bg_job` changes (spec N3, N4).
- No compatibility shims for documents an older build wrote (spec N5).

## Unknowns

None open. Each was answered by the user before P1 and became a requirement in the spec:

| # | question | answer | where |
|---|---|---|---|
| U1 | the label `list` prints for another session's live task | `[otra sesión]` | S23 |
| U2 | does closing another session's live task need an adopt step | no: the record write is the decision | S24 |
| U3 | what a session does when the host reports no transcript path | memory-only view, records still written | S25 |

## Phases

| Phase | Outcome (one line) | Acceptance (can fail) | blocked_by |
| --- | --- | --- | --- |
| P1 | `TaskRow` + a shared atomic document store: spawn, settle and close write a task record and the session view, and a reload restores from them instead of the branch snapshot | a plugin test spawns two workers, delivers a `reload` `session_start` over an empty branch, and lists both; both refs close; the view references two ids and each record file holds its row; no `piher.subs` entry is appended | none |
| P2 | liveness is an observation: `status` leaves the durable shape, the GC stops writing rows, the zombie sweep and the bounded tail are deleted, and the user-facing texts describe the three predicates | documents written by the suite contain no status field; a worker whose pane is gone is listed as actionable and `send` revives it; a row older than eleven settlements survives a reload and closes | P1 |
| P3 | ownership: records carry their session, `list` shows another session's live task marked, and a dead foreign task disappears | two mounts sharing one repository directory and different session files: B lists A's live worker as foreign, B stops listing it once its pane is gone, and B's `close` makes A's next `list` drop it | P2 |
| P4 | `/piher-tree` is gone with its overlay, projection and port method; the widget hint names `subagent list` | the composed root registers no `piher-tree` command, no module imports the overlay, and the widget still renders one row per running worker | P2 |
| P5 | the ledger and the temporary trace are deleted, and the docs describe the single model | spawning and closing a task creates exactly the two documents (asserted by a test); the trace module and its tests are gone; the doc-anchors test passes with no stale anchor, and the final `rg` sweep is empty | P3, P4 |

## Log

L1. "entonces me huele a que lo correcto aqui seria un autocierre .... me esta llamando la atencion la
opcion 3 de quitar el concepto" — and after the options were weighed, the user chose the per-session
document over the ledger, then asked for the cleanest design: "y que es lo maas elegante usa skills de
ingeniaria disponibles sin importar que sea un refactor grande con tal de dar con la solucion mas limpia y
elegante".

L2. "si puedes pensar libre y proponer cambios rompientes" — free design, breaking changes authorized.

L3. `close` semantics settled by the user: "piens en close como la operacion del master para un agente que
ya no nececita ... no habria porque nececitar revivir algo que ya se le hizo close" → `closedAt` is
durable and final across sessions (S9).

L4. "que es un task en toda esta propuesta?" → one spawned subagent, not a tool call, `bg_job` outside
(S1, S2).

L5. "si estoy de acuerdo en renombrar a tasks y taskrow enlugar de sub, tambien limpiar los trace
temporales" → S20, S21.

L6. "/piher-tree ... sospecho podria no nececitarlo" and "lo que si no quiero que desaparezca es ... los que
salen de color blanco que dice a los agentes activos" → S18, S19.

L7. "no tengo la verdadera sesiones importantes puedes limpiar ledgers o cualquier cosa residual" → N1.

L8. Approval, verbatim: "apruebo el spec y el corte de fases, apruebo el u1, el u2 tambien tu supuesto esta
bien , u3 tambien esta bien tu supuesto s22 tambien de acuerdo , politica de entrega tambien esta bien".
U1, U2 and U3 became S23, S24 and S25; S22 (the three verification seams) stands as written. Nothing is
open: `spec-loop` can run in a clean session from the files in `docs/spec/` alone.

L9. S26 added before P1 (a precision of S11, not a new decision): an observation never authorizes an
action — `list` and every action probe core for the rows they touch, and only the printed state text comes
from the cache. It closes the one place a fresh implementer could have trusted a stale status.

P1 done: `a9cdb9c` (range `64786f5..a9cdb9c` on `master`), Risk: item 1 (S9/S25 review), `npm test`
460/460 green (~12 s, run by the parent on that commit), Route: delegated. `task-row.ts` + `task-store.ts`
replace `history-store.ts`, `subagent-registry-file.ts` and the branch snapshot; one correction round after
the review found `resume` reviving a closed-but-unconsumed record (S9), a `createdAt` overwritten by a
revive (S3/S10), and S25 unproven at the plugin seam.

P2 done: `04d8159` (range `8ffd6c0..04d8159`), Risk: item 2 (decision logic re-derived), `npm test` 461/461
green (~8.5 s, run by the parent on that commit), Route: delegated. `TaskEntry.status` and `TaskStatus` are
gone: every surface derives from `isClosed`/`isSpent`/`isActionable` plus a plugin-owned observation cache
that feeds only the printed state text (S11/S26), and every action probes core itself. The GC keeps
reclaiming panes, tabs and spaces from the watch snapshot, writes no document and ends no task; the zombie
sweep and `releaseRow` are deleted. `list` prints the contract's four state texts and line shape.
Correction round: `shouldClosePane` no longer blesses a close of an unlisted terminal, and the three
closed-task answers now say close is final instead of promising `resume`.

P3 done: `97a599e` (range `84985f3..97a599e`), Risk: item 3 (S24 cross-session read), `npm test` 462/462
green (~7 s, run by the parent on that commit), Route: delegated. Plan correction: P3's one-line outcome says
"records carry their session", and that is not implementable — S10 fixes the durable facts and has no owner
field, so ownership is derived instead: a task in this session's view is its own, an actionable record of the
repository the view does not name is another session's. `list` prints own rows then live foreign rows as
`[otra sesión] …`, a dead foreign row silently; every printed ref resolves for the actions; a foreign close
writes only that record. Correction round: the durable decisions became a read-through (`refreshFromRecord`
at the shared spine and in `list`), so S24's "final on its next read" holds without a reload; `retry` of a
closed or spent foreign row now reaches S2's new-task branch.

P4 done: `b48e3a0` (range `97a599e..b48e3a0`), Risk: none (pure removal; acceptance asserted by the
composition test), `npm test` 459/459 green (~7 s, run by the parent on that commit), Route: delegated.
`tree-overlay.ts`, the `piher-tree` command, its projection and `SubagentPort.listRows` are gone; the
resident widget keeps one line per running worker and its overflow hint names `subagent list`.
