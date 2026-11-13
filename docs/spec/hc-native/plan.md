# Plan — delegation state from the core

spec: `docs/spec/hc-native/spec.md` · tool contracts (unchanged): `docs/spec/contracts.md` · domain:
`docs/spec/spec.md`

base: `master` @ `d415839` · push: **no** · parallel: **no** (one checkout, phases sequential) ·
red-at-end: **not allowed** (a phase that leaves the suite red is not accepted)

Delivery policy confirmed by the user before P1, together with the spec and this split: base `master`,
no push, no parallel phases, every phase boundary green. Base SHA
`d41583914ea8bf51d2232336c984f3261b5d6071`. Nothing here is provisional; `spec-loop` starts from this
file alone.

checks (once, run at every phase boundary):

```sh
npm test                      # from the repo root: tsc --noEmit + the whole suite
rg -n "pipe-channel|PIPE_WATCHDOG_MS|settleWindowStartedAt|planVacuumTick|isSettlementCandidate|deriveSubSessionState|piher\.session" packages/ext/src
# the sweep above must be empty at P5 and must only shrink phase by phase; every hit at a phase
# boundary is named in the phase's acceptance line or it is leftovers
```

## Non-goals

- No `terminal` tool, no new actions, no `bg_job` feature work (spec N1, S20).
- No `pi --mode rpc` (spec N2), no gentle-shell port (spec N3).
- No migration of older state; no compatibility read of documents an older build wrote (spec N5).

## Unknowns

| # | question | resolved by | answer |
| --- | --- | --- | --- |
| U1 | earliest hc version with `doc.get/set` + `events.subscribe` | schema at each tag | present at `v0.1.16`, the current pin; no bump |
| U4 | documents survive `hc server restart` | spike, private core | yes: value and `version` survived `restart` and `stop`+`start` (new pid, same core id) |
| U2 | the worker's own `events.subscribe` is prompt and cheap | spike, throwaway node client | 2.2–12.7 ms write→event; 9 events / 1.7 KiB in 25 s; subscription takes over its connection (spec S24) |
| U3 | `terminal.send` reaches a just-booted worker without a wait | spike, 3 immediate + 2 gated sends | no: `started: null`, text unsubmitted, `turn` stays 0 (3/3); after `idle`, `started: true` and `turn: 1` (2/2). Hence spec S22 |

Everything below ran against `hc 0.1.20`; the probe scripts live in `/tmp` and nothing from them lands in `packages/`.

## Phases

| Phase | Outcome (one line) | Acceptance (can fail) | blocked_by |
| --- | --- | --- | --- |
| P1 | the worker writes `piher.rep.<address>` on every settle, and the master delivers that document on the `turn` event, deduped by (`taskId`, `turn`) — the poller still runs but can no longer deliver a notice a document already delivered | with the settle window set beyond the test budget so the heuristic cannot fire, a plugin test's spawned worker delivers its settlement with the exact text stored in `piher.rep.<address>`, and a second `turn` for the same value delivers nothing twice | none |
| P2 | the first task waits for the core's readiness and is believed only when the send's own result says it started: no pipe ping, no `/tmp` socket, and a send that did not start a turn is retried | a spawn whose worker never serves a pipe still receives its task and increases `turn`; a send whose result is `started: null` is retried and the test sees the turn happen; no `/tmp/piher-*` socket appears for that worker | P1 |
| P3 | `send` steers through the core: the master writes `piher.cmd.<address>` and the worker applies `sendUserMessage(text, {deliverAs})` | a `send` issued while the worker is mid-tool-call reaches it after that tool result and before the next model call, the tool result reports delivery, and the test observes no connection to a pipe name | P1 |
| P4 | the heuristic settlement dies: settle window, vacuum, `isSettlementCandidate`, `hasPendingToolCall`, master-side transcript derivation and the poller's blocked-gate dedupe are deleted, and a lost or finished pane is reported from native events | the named symbols and their options are gone (`rg` sweep clean for them), the suite is green with `PIHER_SETTLE_WINDOW_MS`/`PIHER_POLL_INTERVAL_MS` removed, and a worker whose transcript file is deleted mid-run still settles with the document's text | P1 |
| P5 | nothing of the private socket survives: `pipe-channel.ts`, the 10 s watchdog, takeover/generations, the readiness ping and the `piher.session` label are gone, and `hresume` is the session source | a suite run spawns a worker whose master opens no listener (no `/tmp/piher-*` socket exists and no `session_start` server is registered), and `output` plus `resume` still resolve the worker's session from `hresume` | P2, P3, P4 |

## Delivery policy, settled here or asked in the run

The four header values are asked once, with this plan. Once agreed, the orchestrator decides the rest
from evidence and does not come back to ask.

## Log

L1. "primreo arma el spec" — asking for the contract and the split of the refactor agreed in the previous
messages: "lo que si siento que le falta a gentle shell es esa integracion con hc … estoy dispuesto a
simplificar aun mas mi codigo es decir refactor completo si aprovechar lo que ya da pi es mejor pero me
interesa mucho que esos subagentes se abran como subagentes de hc es decir que yo pueda ver en herdr app",
"prefiero una herramienta limpia tool para pi tipo simplemente subagent, que sea una tool tal cual", and
"considera que eventualmente expondré una tool \"terminal\" pero no es la prioridad … la prioridad es la
herramienta subagent y bg_job".
L2. Policy and route, before P1: base `master` @ `d41583914ea8bf51d2232336c984f3261b5d6071`, no push, no
parallel phases, red-at-end not allowed. `Route: delegated` (P1 spans four or more files of the spawn and
settlement path and its acceptance needs the full suite plus a real spawn).
L3. **P1 done**: `659d04c` (two correction commits over `522810b`), Risk: item 4 (delivery dedupe, claim
latch and CAS writes across two writers), `tsc` clean + `npm test` **487/487** on that SHA, Route:
delegated. Two reviews, both REJECT: the first raised 8 findings (7 corrected, 1 discarded as
pre-existing double-mount shape), the second found 4 still open on the same paths plus a question about a
stale `turn` read — all five corrected, with settlement identity moved from (`taskId`, `turn`) to the
document instance (`address`, `at`). No third review: the phase's budget is two. Residuals recorded, not
hidden: a settle whose document write fails on an already-consumed row reaches the master only on the
next request; the consumed-row reader does not survive a master restart (P4's event-driven re-arm owns
it); a `522810b`-era document with `text: null` still renders "Reason: stop"; a document-write failure is
logged worker-side only. The suite failure the P1 worker called pre-existing was mine: the role switch to
deepseek left `~/.config/herdr-core/templates/*.md` stale, regenerated outside the repo.
L4. **P2 done**: `c54328c` (two correction commits over `d0f5735`; `0e0d22d` is the docs-only S25
commit), Risk: item 3 (`CoreClientLike.send` changed its return contract), `tsc` clean + `npm test`
**518/518** on `0e0d22d` (docs-only delta over the code commit), Route: delegated. Two reviews, both
REJECT: 8 findings then 6; 12 corrected, and two triaged out — the paste for a `done` worker stays
ungated (the core's gate has no `done`; low impact) and S22's older wording was superseded rather than
edited. The spec gained **S25** (delivery believed by `started: true` **or** a turn that began where none
had), with S22 kept visible as superseded. Residuals: the gate, the reclaim and the retire/keep split are
proven against the fake core at the plugin seam, not against a live `hc`; a kept failure on a `blocked`
pane waits for a person by design (its silence budget does not consume it).
L5. **P3 done**: `a839500` (+ `25abcef`) with `4286801` carrying the docs-only S26 commit, Risk: item 4
(concurrency and delivery claims on a control channel; `CoreClientLike` also gained `watchDocuments`, item
3), `tsc` clean + `npm test` **540/540** on `4286801`, Route: delegated. Two reviews, both REJECT (9 items,
then 8); 15 items corrected across three rounds, none triaged out. The ack of a steer is now the *version
the absence landed at*: a delete bumps the version, **measured** on `hc 0.1.20` (`set(v2, null) → 3`,
`get → {null, 3}`) after the reviewer read the schema prose the other way — the measurement is quoted in
the code and pinned by a test. `replaced` was deleted rather than reworded: no read can prove a steer was
*not* applied, so the ambiguous interleaving is `unsettled` and never invites a second delivery. The spec
gained **S26** (the command value carries the task id; an identity-less worker refuses every command; an
empty or oversized message is refused before any write). Residuals: the steer ordering rests on pi's
`deliverAs:'steer'` contract, not on a live `hc` run; `unsettled` does not re-arm, deliberately. The P3
worker rewrote the branch so my uncommitted S26 edit fell out of history; I re-committed it as `4286801`
and the text is byte-identical.
L6. **P4 done**: `0cb7779` (`5b8a4ae`+`8344d22`, then `e5d36b1` and `0cb7779` for the corrections;
`3fcf959`, `adf1438` ride along), Risk: item 3 (two documented `PIHER_*` knobs removed — a
config-contract change), `tsc` clean + `npm test` **545/545** on `0cb7779`, Route: delegated. Two
reviews: REJECT (8 findings, none triaged out) then **APPROVE** with 5 new ones, of which the two this
phase's own fixes introduced were corrected and three were triaged out with reasons (dead latch plumbing —
P5 deletes `index-pipe`; a 30 s lag on a buffered notice; `list` still reading `idle` for a channel-less
row, which needs a new durable field and would open S10's fact set in the last phase). Deleted:
`planSettleWindowTick`, `isSettlementCandidate` (with the `terminalIdle` concession), the master-side
transcript derivation, the blocked-gate dedupe, the settle-claim latch in the poller, and both knobs;
`session-tail.ts` now answers only "what did the turn say". Restored after the review: every settle with a
channel writes a document (S6/S8, including `text:null, stopReason:null`), the two silence-budget endings
`settled-without-report` vs `silence-timeout`, a reader that survives a budget-ended row, and
`reattributeStaleSessionFile`. The docs guard was narrowed to the two phase-log files, so
`docs/spec/contracts.md` is guarded again. **Q1 answered from pi's documents**, not from code:
`agent_settled` means no remaining automatic work, and queued steering counts as remaining work, so an
empty interim settle cannot fire between a finished turn and a steer's turn (`docs/json.md:48`,
`docs/extensions.md:336`); recorded where the empty settle is written. Residuals: the seam is the fake
core, not a live `hc`; a channel-less worker's row still reads `idle` in `list`; `config-catalog` now
names any unregistered `PIHER_*` and sweeps the whole source tree.
L7. **P5 done**: `511da5a` (`2e796b9` + `ed949b9` + `511da5a` for the corrections; `3a43fe5` is the
docs-only commit), Risk: item 4 + item 3 (the settle boundary collapsed to a process fact, and `interrupt`
plus the session resolution of `output`/`resume` changed behaviour), `tsc` clean + `npm test`
**535/535** on `511da5a`, Route: delegated. Two reviews, both REJECT, then two correction rounds verified by
the parent — the phase's review budget is two, and the second round's 8 findings were closed without a third
review, which this line records rather than disguises. Deleted: `pipe-channel.ts`, `index-pipe.ts` and its
test, `PIPE_WATCHDOG_MS` with the healing interval, takeover/generations, the settle fast-path push,
`pendingMachineRequest`, the settle-claim latch, the `piher.session` label and `PIHER_PIPE_TRACE`; the
plan's boundary sweep is **0**, repo-wide. What the two corrections established: ownership is now a fact
piher wrote into the core — the `piher.task` label set at spawn must name the task, and an address or a
missing `parent` is never evidence of ownership (S18/S26); a session is only written into a record when it
is an existing `.jsonl`; the resume refusal has three shapes and asserts only what its read established;
`turnStartedAt` is defined for a turn that began before the mount; and the "never PTY injection" claim is
gone from the README and the decision notes, because `terminal.interrupt` presses the stop key in that pane.
Residuals: the seam is the fake core, not a live `hc`; a channel-less worker's row still reads `idle`;
`send` to a vanished pane still revives without a session.
L8. **Post-run correction**: `4759f02` (parent `2c83642`), Risk: item 3 + item 6 (the resume contract
and the refusal family changed; no test covered the record path that carried the defect), `tsc` clean +
`npm test` **538/538** on that SHA, Route: delegated. Not part of the accepted run: a demo `reviewer`
spawned after L7 read `511da5a` statically and found that `resume` skipped its `.jsonl` validation
when the record already carried the value — `index.ts:246` fills a document's `session` with
`report.file ?? (sessionId || null)` (a bare id when the worker had no readable `hresume` at settle) and
`subagent-poller.ts:319` writes it into the record raw — so `reviveEntry` dropped `--resume` and the
tool answered "session restored" over a fresh conversation. Fixed by validating the record value like any
other candidate and by trying the record, the label and the document in order; `getTaskIdForPane` absent
now yields a new `unestablished` report instead of `not-ours`. The three new tests fail on `2c83642`.
Residuals: the `unestablished` refusal is pinned at the unit level only (the plugin wires the index, so
no end-to-end path reaches it); an undecided address may not borrow the newest session files; a terminal
from an older build still loses its live `hresume` report because the ownership gate needs the
`piher.task` label only a spawn writes — that needs a label rewritten on adopt/restore, which was
explicitly out of scope here.
L9. **Post-run correction (the settlement promise)**: `bbb5cd0` + `e58db82` + `73cc5af` (parent
`c68846d`), Risk: item 6 (three states where a worker's outcome never reached the master, with no
public contract changed), `tsc` clean + `npm test` **541/541** on `73cc5af`, Route: delegated. Not part
of the accepted run: a read-only audit of the token mechanics — spawned to answer "is piher cheaper for
the master, and where does the saving not fire" — enumerated twelve gaps by `path:line`; the three that
defeat S5-S8 were fixed here and the rest are listed below rather than kept quietly. **G1** — a
disconnected watch counted as a heartbeat: `observe()` returned `state:null` and `planSilenceTick`
refreshed `lastActivityAt` on every tick, so the silence budget never expired and no notice ever fired;
`observe()` now reports `blind` separately, blindness never refreshes activity, and an expired budget
under it is its own action with its own notice (`formatBlindWatchNotice`: the core did not answer, so
this is not the task's result), said once per blind episode and **without consuming the row**, because
blindness establishes nothing about the worker. **G2** — an unarmed watch was a `console.error`:
`startPoller`'s boolean was discarded, so a spawn whose settlement watch never took its pane produced no
settlement ever; the spawn now arms through one helper and says so when it fails
(`formatWatchNotArmedNotice`, folded into the kept-failure notice, whose promise of a silence budget now
depends on whether a watch armed). **G10** — a report was unreachable once its pane was gone: `output`
read only the pane, so a consumed one-shot's report could not be read through the tool at all; on a pane
read failure it now answers from `piher.rep.<address>`, headed `source: report document (… not a pane
read)`, and records the delivery exactly as the transcript path does. Each fix is pinned by a test that
fails on `c68846d` (verified by stashing the source): the poller's old "a disconnected watch never
settles" test pinned the very behaviour G1 fixed and now asserts more, not less. Residuals: the blind
path is proven against a fake watch and a virtual clock, not a real socket drop; a watch that goes blind
after its row was consumed still gets no blind notice. The gone pane is not a residual any more: after a
`/reload`, `output` on a one-shot whose terminal had been reclaimed (absent from `hc ls --all`) answered
`source: report-document`, `status: settled`, `reportDelivered: true` and the child's 52-byte closing
message — the document read live, not the scripted error the tests use. Open from the same audit, not this unit: settlements collapse to
three notices and point the master at transcripts (`NOTICE_MAX_SHOWN`), settlement is suppressed until
the master's next turn after an abort, a settle that writes no document waits out the whole budget,
`output` cannot read a document whose record was swept, and a per-notice cap is no session-wide budget.
L10. **Benchmark, layer 1 (the channel, not the master)**: `(this commit)` (parent `28cbf19`), Risk: none —
a test, no behaviour touched, `npm test` **549/549** on it, Route: parent. `test/settlement-transport.test.ts`
measures one thing: with `collapseNotices` and the body distribution measured over 187 real settlements
(median 374 B, p90 8.108 B), how many reports a single delivery carries, and what a byte-budgeted
candidate would cost instead. At N=10 with median bodies, today delivers **1.739 B carrying 3 of 10**; the
candidate carries **10 of 10 in 4.081 B**; with p90 bodies the candidate is **902 B of rows, 0 bodies and
10 pointers**. The test asserts what the numbers hide: today is cheap *because* it drops seven reports
(assert the gap is the withheld text, not efficiency), the withheld reports are absent rather than
summarised, and every candidate pointer names the `agentId` in the exact call that recovers it. Base
check: raising `NOTICE_MAX_SHOWN` to 4 turns exactly the three "today" tests red and leaves the candidate
tests green — the separation the file exists to prove. Not measured, and why: **attention** needs the
fan-out first. With 3 of 10 delivered, a wrong decision is explained by lost information rather than by
attention, so layer 3 (same 10 rows in one message vs ten spaced messages, scored against two planted
blockers) waits for S27 to land. Layer 2 — ten real explorers settling while the master is busy — also
pending, and it does not need new code.
L11. **Benchmark, layer 2 (ten real spawns) and the invariants list**: `(this commit)` (parent
`516402f`), Risk: none — no behaviour touched, suite green with nine **skipped** invariant tests,
Route: parent. Ten `explorer` spawns in one batch, each a one-line question, plus a 75 s blocking call
as the master's "busy" control — the user's normal case: spawn, then keep working. Facts: ten events
(eight settlements, two boot failures) reached the master as **one** delivery of **2.194 B** carrying
**3 of 10 verbatim** and **7 withheld reports**, for **one** turn spent learning that. Layer 1 had
predicted 1.739 B and 3 of 10 for median bodies, so the pure function models the channel faithfully.
The surprise is not the channel: **2 of 10 spawns were reported as "failed to start"**, and one of them
(`t1hr`) had already answered correctly — `packages/ext/src/session-tail.ts` has 217 lines, visible in
its own pane buffer — so the readiness gate lost a child that finished before it was observed ("exited
before its agent reported ready (waited 0s)"). In a ten-worker wave that is a **20% false failure
rate**, and it is worse than the collapse: the notice says "spawn it again" over completed work. Both
defects are now written as criteria rather than intentions — `docs/spec/hc-native/invariants.md`
(E1-E12, with E3/E4/E7 recorded as closed and why) and `test/open-invariants.test.ts`, where a skipped
test is an open invariant carrying its evidence, so the definition of done exists before the fixes.
Not measured: attention still needs the fan-out, because 7 of 10 reports never arrived.
L12. **E2/E9/E12 closed — a child that answered is not a failed start**: `fdbe126` (parent `0e3fb34`),
Risk: item 6 (the boot's verdict changed: a start that cannot be confirmed now asks the settlement
channel before it may be called a failure), `tsc` clean + `npm test` **559 tests, 553 pass, 6 skipped,
0 fail** on that SHA; the same command on `0e3fb34` gives 558/549/9, so the unit adds four passing tests
and closes three invariants without a single red. The defect, measured in L11: of ten spawns in one
batch, two were reported to the master as failed starts, and one of them (`t1hr`) had already answered
correctly. The fix: a boot that never confirmed its delivery reads `piher.rep.<pane>` and judges it with
the same `planReportDelivery` the settlement watch uses, against its own `spawnedAt` with the same
slack (`REQUEST_BOUNDARY_SLACK_MS`, now exported so the two readers cannot diverge). A report naming
the task inside that window means the spawn **settled**: the row is kept, the watch is armed at
`spawnedAt`, and the report arrives as an ordinary settlement; if the watch cannot arm, the notice says
it settled, points at `output`, and says **not to spawn it again**. No document keeps the old failure
verbatim, cause and advice included. The investigation answered the odd detail: `(waited 0s)` is not a
shared budget — each boot owns its `deadline`, and the second `waitReady` starts a fresh clock whose
first probe already finds `state: finished`; the race is the late submit (`started: null`, turn 0), the
`resubmit` verdict, and the 500 ms retry sleep in which the child answers and exits. Rejected: teaching
`planTaskSend`/`planReadyAttempt` to read the `turn` — a turn proves neither that an answer exists nor
that a crash did not happen during boot, and would still leave the master without a report. Unproven:
the fixture's late submit is a 20 ms timer against the core's real Enter cost (the live burst's 0.3 s
child fits, but no live burst has been re-run since the fix); a child that ran a turn and left **no**
document is still judged a boot failure, which is literally true but would read better as the
`settled-without-report` ending at boot — a follow-up, not this unit.
L13. **External review (README-level) and what it changed**: no SHA of its own — this line records a
review of the architecture by another model that read the README, not the source, and the triage that
kept it honest. Adopted as written: (a) a **cursor with ack and a snapshot revision** as the design of
E5 — delivery stays a notice, the guarantee becomes a durable cursor a restarted master resumes from;
(b) a **load simulator** as the closing harness — thirty stub workers that die, lag, duplicate and
block, asserting one `reported` event per task, no `send` without a terminal state, and a snapshot that
never contradicts the journal. Folded into decisions already taken: structured results with `verdict`
and `artifacts`/`details_path` belong to the role-output contract, and its "groups per phase" is E1's
aggregate delivery under another name. Recorded as a scale gap: **provider rate limits (429)** are
handled nowhere, which matters at 30 and not at 10. Rejected with reasons, so nobody re-litigates them:
a scheduler with a queue (the premise is false — `SUBAGENT_CONCURRENCY` admits pane creation through a
semaphore that already queues, and ten spawns in one batch all started), nine states with leases (a
second source of truth that can contradict the core's), a single-writer storage rewrite (one file per
task is already one file per task; the contention is git, not JSON), and putting the journal before any
measurement (its own simulator section argues the opposite). One correction of ours it earned: the
first task still enters by `terminal.send`, so the boot race was fixed at the symptom (ask the document
before calling a boot a failure, L12); routing the brief through the mailbox is the structural fix to
return to if the race reappears.
L14. **Live re-run after L12, and why E1 must start with durability**: `16af9bc` + this line, parent
`fdbe126`, Risk: none (a measurement), Route: parent. Ten `explorer` spawns in one batch with a 75 s
blocking control, run after a `/reload` so the process carried the L12 fix: **zero false boot failures**
(against two in L11), ten settlements, no failure notice at all, which closes L12's residual "no live
burst has been re-run". Transport unchanged: one delivery of **889 B carrying 3 of 10**, seven withheld —
cheaper than L11's 2.194 B only because two failure diagnostics no longer exist. New fact for the next
unit, verified in source and not by inference: `handOver` calls `injectNotice(...)` and then
`consume(now())` (`subagent-poller.ts:319-325`) while the notice buffer holds only RAM (no `writeFile` in
`index-notices.ts`), so a `/reload` or a crash during a busy flush **loses the notice permanently while
the row is already consumed on disk** — a silent, durable lie that `list` repeats. That is worse than
the collapse, which at least says what it withheld. So E1 is not "rows by bytes": it is a durable ledger
with `deliveredSeq` written only after pi accepts, a cursor that re-delivers after any restart, and
then the budgeted row delivery on top. The budget without the ledger would make the loss prettier.
L15. **E1a — the durable ledger, and delivery recorded only after pi accepted**: `0062166` (parent
`b46e445`), Risk: item 5 (the meaning and write moment of `consumedAt` changed: it now says "the report
reached the master", not "the notice entered a buffer"), `tsc` clean + `npm test` **576 tests, 570 pass,
6 skipped, 0 fail** on that SHA, Route: delegated. The ledger is
`<repo>/.piher/tasks/settlement-<sessionId>.jsonl`: append-only, one writer, one JSON fact per line
`{seq, at, taskId, pane, turn, kind, group?, payloadRef?}`, `seq` from 1, tolerant of a torn tail. The
cursor is a separate `<ledger>.jsonl.seq` written tmp+rename, because appending acks would need a kind
outside the frozen enum and would mix bookkeeping into the facts. The ordering is the whole fix: the fact
is appended **before** it is announced, and the delivery is recorded **only** after pi accepted the
message — row `consumedAt` first, then the cursor, because a crash between the two leaves a record the
replay recognises as its own duplicate, while the reverse would leave a cursor hiding an undelivered
settlement. `consumedAt` now carries the settlement's own `at`, which makes `(taskId, at)` the
idempotency key with no extra durable state; `awaitingAccept` keeps a pending notice from being killed
by the silence budget or re-announced from its own document. Deliberately not stored: the report body —
the event carries `payloadRef = piher.rep.<pane>` and replay reads the document only when it still names
exactly this `(taskId, at)`, otherwise the notice says the document is gone and names the `output` call.
The unit also had to fix four test fixtures whose fakes pushed the text and never claimed pi accepted
it, i.e. they asserted a delivery they had not made; every assertion they guarded is unchanged. Unproven:
the live replay after a real `/reload` (proven against a fake host only), and `spawned | booted |
steered | closed` exist in the format but nothing emits them yet. E1 stays open: durability is done,
delivery and `inbox` are not.
L16. **E1b and E13: every settlement gets a row, and a working child is ready**: `39c63e1` + `aabc8a5`
(E1b) and `a33b116` (E13), parent `ef393ea`, Risk: item 5 + item 3 (the delivery format changed and a
readiness verdict changed), `tsc` clean + `npm test` **597 tests, 591 pass, 6 skipped, 0 fail** on
`aabc8a5`, Route: two workers in parallel on disjoint files. Measured by the parent, not only claimed:
N=10 with median bodies delivers **10 of 10 in 4,090 B**; N=10 with p90 bodies delivers **10 rows, 0
bodies, 1,027 B and one batch pointer** — against 1,739 B carrying **3 of 10** on the base. `collapseNotices`
and `NOTICE_MAX_SHOWN` are deleted rather than kept as dead code, and their test was replaced by the
byte-budget ones. The delivery rule: a row per settlement (`id · description · outcome · size`), the
body budgeted first-fit in arrival order (4 KB, `PIHER_NOTICE_BODY_BUDGET_BYTES`), a withheld body
replaced by the exact `output` call, and one `reports { ids }` line for all of them so N pointers no
longer cost N turns. A lone settlement keeps its text and its card byte for byte. E13: `planReadyAttempt`
now accepts **working** or `turn >= 1` as readiness (blocked and error still outrank it), and the boot
failure text may not claim "did not take its first message" when the pane has a turn — the live defect
of L14. The brief reaching a busy child is proven **queued**, not dropped, in a harness that models pi's
queue. Incident, recorded because it happened: E1b's `git commit --amend` briefly rewrote E13's commit;
the worker reset to it and the parent verified `a33b116` still holds exactly its three files (292/35).
Residuals: no live master run of a ten-settlement batch; `reports` is untested against a real core's
`docGet`; the `timeout` readiness verdict is now unreachable through the core's vocabulary and is kept
only as the wait loop's terminator; E1 still needs `inbox`, E6 still needs a session-wide budget, and
the review's critical finding (a deferred acceptance stamping a row it no longer owns) is still open.
L17. **The review's critical and two majors, closed — and the 44-minute hang**: `bb90406` (M1) +
`db18021` (C1) + `1f16d42` (M2), parent `1ce8c8c`, plus `4abba7f` (the wall clock and the long-command
rule), Risk: item 5 (who owns a row at acceptance time, and what a cursor means), `tsc` clean +
`npm test` **600 tests, 594 pass, 6 skipped, 0 fail** on `1f16d42`, verified by the parent. All three
findings were confirmed, none refuted. **C1**: `acceptSettlement` re-resolved the row at flush time and
stamped `consumedAt` with an `at` that predated a steer, then reclaimed a one-shot pane the steer was
running; now the acceptance carries the `PaneRequest` it was judged against and mutates the row only
while `requestByPane.get(pane).id` is still that one — the steer registers a new request, so the old
acceptance no longer owns the row, while the **delivery is still recorded** because pi did read the
notice. The map is not cleared on dispose, so a normal acceptance is unaffected. **M1**: `markDelivered`
was a high-water mark, so accepting seq 2 while 1 was pending hid 1 forever; the cursor now crosses only
the contiguous prefix, at the cost that an acceptance made above a gap by a dead process is not
remembered and re-delivers (at-least-once, normally suppressed by the row). **M2**: the replay loop
injected per event with `triggerTurn`, so a restart cost one turn per settlement; it now plans one batch
with the live path's `planNoticeBatch`. **The hang, for the record**: a worker spent 44 minutes in a
single `node --test` that never terminated — its own fixture deferred *every* acceptance, so the steer's
settlement was never accepted and the poll loop parked forever, and it ran the file without
`--test-timeout`, so the run blocked instead of failing. The parent reproduced it (179 s, `Promise
resolution is still pending but the event loop has already resolved`) and added the protections that
make it impossible to lose another hour: `npm test` is wrapped in `timeout 240` (`4abba7f`), so the
suite fails at four minutes naming the file (measured: `EXIT=124`, 239.9 s), and one rule in the global
instructions, the repo's `AGENTS.md` and the worker template — any command that may take a while goes to
`bg_job`, and a test that takes long is unacceptable except for a full suite, an e2e or a complete
integration pass. Unproven: no live master run of C1 (the steer sequence is a scripted harness), no real
core behind the replay batch, a buffered multi-pane replay does not mark its panes GC-exempt, and
`reports` against a real `docGet` is still untested. Still open from the review: the six minor findings.
L18. **Capacity, measured (the number the external review asked for)**: no code change, parent-level
measurement. Live `pi` worker processes on this machine: **median 212 MB RSS, mean 210 MB, max 228 MB**.
Projection: **20 workers ≈ 4.1 GB**, **40 workers ≈ 8.2 GB**, against **15 GB total and 6 GB available**
here. So the physical ceiling of this box is about twenty to twenty-five workers, which is exactly the
peak the target scenario asks for; forty does not fit here regardless of design. This is the number the
capacity line should print when it becomes visible (P9), and it is the fact behind "the physics is not
piher's to fix, only to make visible". Not measured: the core's own event fan-out at N=30 — the code
holds one unfiltered `events.subscribe` per worker, so the cost is O(N) per element event by
construction, but no instrumented run has counted it yet.
L19. **The review's five cheap minors, closed**: `bc3094d` (parent `c577de8`), Risk: item 5 (the ledger's
duplicate bound and the ownership of a cursor step), `tsc` clean + `npm test` **607 tests, 601 pass,
6 skipped, 0 fail** on that SHA, verified by the parent. All five confirmed; one mechanism refuted.
**#7**: the replay named only the pane, and a reused address resolves to whatever task owns it now — the
notice and the batch row now name `task <taskId>` and flag a moved address. **#8**: the `pane-gone` and
silence-budget facts carried no `payloadRef`, so a replay said "the report document is no longer
readable" where the original said the pane was gone or that no report came; the replay now branches on
the event's `kind`, and a replayed `pane-gone` row reports `closed`, as the live delivery does. **#9**: the
review's mechanism was wrong — the cursor cannot exceed the new file's `lastSeq` — but the harm is real
and worse to reason about: a stale seq is *equal* to a new-file seq, so `markDelivered(oldSeq)` marked a
fresh fact accepted and crossed it without a delivery. Fixed with an `epoch()` bumped on every
load/repoint and ignored when stale; the row's `consumedAt` is still written because pi did read the
notice. **#10**: the buffer acknowledged a collapsed batch notice by notice, so a crash between handlers
re-delivered the rest of a message pi had read as one; `openBatch()` now defers the cursor write to the
end of the batch, so one delivery is one step and the documented bound is the real one. **#11**: the
fallback without a send method acknowledged unconditionally; now it returns early, while a host that
does send still records acceptance. Two existing replay assertions were tightened for the new header,
none loosened. Residual: the wiring line in `index.ts`
(`subagentPort.current?.openDeliveryBatch?.() ?? null`) has no test of its own — if the port member were
renamed, #10 would silently regress to per-notice marking — and the fork case (#6) remains out of scope
by decision, so it is the only review finding still open.
