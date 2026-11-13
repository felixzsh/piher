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
