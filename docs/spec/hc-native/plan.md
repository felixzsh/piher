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
