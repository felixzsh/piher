# Delegation state from the core, not from guesses

purpose: a `subagent` task's state, settlement and report come from herdr-core and from the worker
itself, so the extension stops reconstructing them from timers, pane text and transcripts — while the
worker stays a real pi session in a visible hc terminal.

done when: with the suite green and the settle-window/vacuum heuristics deleted, a session that spawns two
workers receives both settlements with no timer-driven poll and no `terminal.read`, each notice carrying
verbatim the text stored in `piher.rep.<address>`; and after `hc server restart`, `list` plus `output`
still return each report's full text from the core.

Ground: the design was agreed in the session that probed a live core (`hc 0.1.20`) on 2026-11-13; the
measurements are cited per requirement. The tool's existing promises and refusals are not restated here:
`docs/spec/contracts.md` is the contract for the `subagent` surface and survives unchanged (S13).
`docs/spec/spec.md` keeps the domain (task, generation, session view); this spec changes only where a
task's state comes from.

## Domain

- **S1.** A *task* is unchanged: `docs/spec/spec.md` S1–S4 (`taskId`, current generation, session view).
  What changes is the authority for its state.
- **S2.** The *core record* is authoritative: `status` (`idle|working|blocked|done|error`), `status_ms`,
  `turn`, `state`, `reason`, `statusMsg`, `labels`, `foreground`, `parent`, `exit_code`.
- **S3.** A worker's *address* (`HC_TERMINAL_ID`, e.g. `t1fk`) names its documents. It is not the task id:
  a revived task gets a new address, and the task id travels inside the document value.
- **S4.** *News* is the core's own vocabulary for "something happened to a child": a `status` or `turn`
  event, or a `terminal.wait` result whose `reason` is `status`, `exit`, `running` or `children`.
  (Measured: `{"reason":"status","status":"done","turn":1}`; events `{"type":"turn","data":{"state":"done","turn":3}}`.)

## Settlement

- **S5.** The master never derives "the worker finished" from a timer, from pane text, or by parsing the
  worker's transcript. Settlement is `turn` (monotonic per terminal, `Terminal.turn` "goes up each time the
  status leaves `working`") plus the worker's own report document. (User: "lo que hoy me cuestiono es si
  era más fácil y estoy dispuesto a un gran refactor de ser necesario".)
- **S6.** The worker writes its report document on **every** `agent_settled`, whether or not the master
  asked. Today the push exists but is gated on a pending request (`src/index.ts:252`,
  `pendingMachineRequest`), which is the reason a master-side guess had to exist at all.
- **S7.** A settlement delivery names the `turn` it belongs to and is delivered at most once per
  (`taskId`, `turn`). A second delivery of the same pair is a defect, not a preference.
- **S8.** The delivered text is the worker's own closing assistant text. When the worker ends without one,
  the document states the reason instead (`stopReason` / the existing "left no closing message" wording).

## Documents

- **S9.** Names: `piher.rep.<address>` and `piher.cmd.<address>`. Lowercase only, at most 32 characters,
  `[a-z0-9._-]`, starting with a letter or digit, never shaped like an id. (Measured refusal:
  `bad name "probe.a.b_Upper": use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like
  an id (t7)`.)
- **S10.** *(extended by S26 for the command value.)* `piher.rep` value:
  `{taskId, turn, stopReason, session, text, at}`. `piher.cmd` value:
  `{id, type: 'prompt'|'follow_up'|'interrupt', text, deliverAs}`.
- **S26.** The `piher.cmd` value also carries the `taskId` it is addressed to, and a worker refuses a
  command whose task id is not its own. A command document outlives a core restart and core terminal ids
  restart with the core, so address alone cannot identify the reader; without this, a leftover steer could
  be applied by an unrelated worker that later holds the same address. A send is also refused before any
  write when the text is empty or whitespace, or when its serialized value would exceed the core's 1 MiB
  ceiling (the size is named, nothing is written) — an oversized steer is refused, never fitted down to
  half an instruction.
- **S11.** Writes are compare-and-swap by `version`: a `conflict` is answered by `doc.get` and a retry,
  never by an unconditional overwrite. (Measured: `kind:"conflict"`,
  hint `read doc.get and retry with its version`.)
- **S12.** Documents live in the core, so neither a core restart nor a master restart loses a report:
  `terminal.get` plus `doc.get` reconstruct a task's state without the owning session. (Measured:
  `doc.set` → `hc server restart` → `doc.get` returned the same value at the same `version`; the same
  held across `server stop` + `server start`, each time with a new core pid and the same core id.)
- **S13.** The report is capped where it enters context at the existing cap; the document keeps the full
  text, within the core's 1 MiB per-document limit.
- **S23.** A `doc` event carries `name` and `version` only, never the value, and it is not delivered to a
  `children_of` or `label`-scoped subscription (documents are core-global). The trigger for reading a
  report is therefore the `turn`/`status` event, and the read is one `doc.get`. (Measured: `hc events
  --children-of` delivered `status` and `turn` for the worker and no `doc` event for a `doc.set` made at
  the same moment.)
- **S24.** `events.subscribe` takes over the connection it is sent on — the result's `channel` is `null`
  in plain mode and "this connection now carries only notifications" — so a session that both watches and
  issues commands holds two connections. (Measured write→`doc` event latency across two connections:
  2.2–12.7 ms over five writes; a 25 s subscription in an idle core saw 9 events and 1.7 KiB.)

## Delivery and control

- **S14.** The first task is handed over through the core (`terminal.run` with the task, or
  `terminal.send`); readiness is the core's `status` / `first_message.sent`, never a ping on a private
  socket.
- **S22.** *(superseded by S25 for delivery; kept visible as the record of what was agreed first.)* A
  `send` counts as delivered only when its own result says `started: true`. (Measured: a send
  issued right after `run --bg`, before the worker reported `idle`, returned
  `{"started":null,"status":null,"turn":0}` and the text stayed in the worker's composer unsubmitted —
  `turn` stayed 0 and `status` stayed `idle`; the identical send after `status: idle` returned
  `started: true` and the run ended `status:"done", turn:1`. Three of three immediate sends were lost as
  tasks this way.)
- **S25.** A first task counts as delivered when the send's own result says `started: true` **or** when the
  same result carries evidence that a turn began that had not begun before: `status` `working`, or a
  `turn` above the one read before the send. A result with no such evidence is not delivery: the text may
  still be sitting in the worker's input, so the retry submits it (`enter`) instead of pasting it again,
  and only a refusal that typed nothing (`status_mismatch`) is followed by a new paste. The core's
  `started` is `null` when the program does not report status, so `null` alone proves nothing in either
  direction; discarding a worker that did run its task is the failure this rule exists to prevent.
  (Adopted after the P2 review: the `turn` field the core returns is the fact that separates "never
  started" from "started and the status sample missed it".)
- **S15.** `send` keeps its steering semantics — delivered between tool calls, not behind the whole turn —
  through `piher.cmd.<address>` and the worker's own `events.subscribe` applying
  `pi.sendUserMessage(text, {deliverAs})`. `terminal.send` alone is not the steering channel: it pastes
  into the TUI, and the semantics belong to pi's input handling. (Measured: `send --if idle` refuses with
  `status_mismatch` when the worker is working; `--if working` accepts.)
- **S16.** `interrupt`, `close`, `resume`, `retry`, `list`, `output`, every refusal and its text are
  unchanged; `docs/spec/contracts.md` is the contract. `output` stays screen-based because
  `terminal.read` takes only `caller`, `lines`, `terminal` (no cursor), so its deltas remain — but they
  never feed a decision (S5).
- **S17.** What the core says about an ending is authoritative: `reason` (`killed`, `exit`, `lost`)
  decides how a worker ended. `exit_code` does not: a killed worker's record showed `exit_code: 0` with
  `reason:"killed"`.
- **S18.** A worker's session identity comes from the core's `hresume` label, written by the worker's own
  Herdr extension (measured value:
  `{"agent":"pi","session":"…","file":"…jsonl","cwd":"…","pid":…,"boot":"…"}`). The extension stops
  writing a private session label.

## Cleanliness

- **S19.** The extension opens no listener, and keeps no watchdog interval, pipe generation, takeover state
  or readiness ping. Nothing of the private socket survives.
- **S20.** `bg_job` keeps its own domain and tool contract; using `hc exec` under it is allowed when it
  changes no promise, and is otherwise out of scope.
- **S21.** The worker stays a real pi session in a core terminal: visible in Herdr, attachable, resumable
  after a core restart. (User: "me interesa mucho que esos subagentes se abran como subagentes de hc es
  decir que yo pueda ver en herdr app".)

## Non-goals

- **N1.** No `terminal` tool in this work — the priority is `subagent` and `bg_job` (user: "eventualmente
  expondré una tool `terminal` pero no es la prioridad"). No new tool actions at all.
- **N2.** No migration to `pi --mode rpc`: RPC is stdin/stdout JSONL, and a hc terminal's stdio is the
  PTY, so it cannot coexist with a visible pane.
- **N3.** No port of gentle-shell's model (in-process children, thread views, orchestrator discovery,
  review pipeline). The borrowed decision is one: a structured channel from the child.
- **N4.** No Windows-specific shims kept "just in case": the private socket's win32 branch dies with it.
- **N5.** No state migration: documents or pipe names written by an older build are not read.

## Open questions

| # | question | resolution |
| --- | --- | --- |
| U1 | From which hc version do `doc.get`/`doc.set` and `events.subscribe` exist, so the pin is honest? | **resolved**: present in `schema/hc.openrpc.json` at tag `v0.1.16`, the current pin. No bump needed |
| U2 | Does a worker's own `events.subscribe` (from inside its terminal) receive `status`/`turn`/`doc` promptly, and stay cheap enough to hold for the life of the session? | **resolved**: 2.2–12.7 ms write→event over five writes; 9 events and 1.7 KiB in 25 s of an idle core; a `doc.set` from inside a subscriber's own terminal reached it in the same millisecond window. Constraint found: the subscription takes over its connection (S24) |
| U3 | Is `terminal.send` reliable for the first task of a just-booted worker without an external wait? | **resolved, negative**: no. An immediate send returns `started: null`, leaves the text unsubmitted in the composer, and the worker never runs a turn (3/3). After the worker reports `idle`, the same send returns `started: true` and ends `turn: 1`. Hence S22: wait for readiness and gate on `started` |
| U4 | Do documents survive `hc server restart`? | **resolved, yes**: value and `version` survived `server restart` and a `stop` + `start` on a private core (`HC_SESSION=probe-spike`), with a new pid and the same core id |

## Seams where this is tested

- The plugin boundary: a spawned worker driven through the composition root, asserting the delivered
  notice text (S6–S8) and the absence of a listener (S19). One seam, highest available.
- The core itself, read-only, in a live check: `hc get <worker> --json` and `hc connect` for `doc.get`.
