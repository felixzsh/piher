# Settlement trace (temporary)

One line per decision in the path "a subagent finishes → its last message reaches the master", on both
sides of the delegation. It exists to answer, after a real failure, **which condition broke** instead of
"no notice arrived".

**TEMPORARY**: it ships enabled so a failure leaves evidence. Remove `src/trace.ts` and its call sites
once the settlement failure is fixed for good.

## Where

| | |
|---|---|
| Default file | `~/.pi/agent/piher/trace.log` (created on first write) |
| Override | `PIHER_TRACE=/some/file.log` |
| Silence | `PIHER_TRACE=off` |
| Rotation | at 4 MB the file becomes `trace.log.1` (one generation, then overwritten) |
| Tests | silent unless `PIHER_TRACE` names a file |

Every line starts with `<iso time> <pid> <role> <event>`, where `role` is `master` or `worker` — the
worker is the pi process piher launched as a delegated session. Two processes therefore share the file,
and the order of their lines is the story.

## Events

### The worker side (it is the one that knows its turn ended)

| Event | Fields | Answers |
|---|---|---|
| `settle` | `aborted lastStopReason isSubagent lifecycle pushed hasRequest` | did pi's `agent_settled` reach the extension, and did a push follow |
| `push-skip` | `why=no-request` | the request that arrived over the pipe was not armed, so nothing to answer |
| `push-skip` | `why=aborted-or-error aborted lastStopReason` | the turn ended by abort/error, and a settlement is withheld on purpose |
| `push-skip` | `why=no-text request since file hasFile` | the worker could not derive a closing text from its own transcript |
| `push-try` | `request since file textLen to` | it is about to push this text to that pipe |
| `push-ok` | `request to` | the push left; the master should now record `reply` |
| `push-failed` | `request to error` | the pipe refused it — the poller is now the only hope |

### The master side (pipe fast path)

| Event | Fields | Answers |
|---|---|---|
| `reply` | `pane request textLen claimed sessionFile` | the worker's push arrived; `claimed=false` means another path already owned this settlement |

### The master side (poller, the fallback)

| Event | Fields | Answers |
|---|---|---|
| `poll-start` | `pane since request cwd file watchReady watchConnected row` | was a watcher even running for this pane, and from which boundary |
| `poll` | `pane state textLen pend act ended window since request file watch row` | what one tick saw: the exact inputs of the settlement decision |
| `no-candidate` | same as `poll` | why this tick could not settle: no text, a pending tool, no activity, or a terminal that is not idle |
| `park` | `pane ms wokeByEvent seen version` | `wokeByEvent=false` means core sent no event and the loop woke on its own interval |
| `settle-candidate` | `pane tick closingLen pend act window` | the decision to settle, and whether the settle window opened or finalized |
| `claim` | `pane key claimed closingLen` | `claimed=false` means someone else owns this notice key (dedupe) |
| `inject-ok` / `inject-failed` | `pane request closingLen` / `… error` | the notice entered the buffer, or was refused |
| `consumed` | `pane via poll-settle\|poll-timeout request` | the row left `running` |
| `timeout` | `pane request idleMs lateTextLen latePend lateAct file` | the 300 s verdict, and what the boundary-free re-read found before it |
| `poll-exit` | `pane reason request` | why the loop stopped: `settled`/`consumed`/`closed`/`row-gone` |

### Around it

| Event | Fields | Answers |
|---|---|---|
| `resolve-session` | `pane cwd preferred reported candidates count` | which transcript this pane may be read from, and where each candidate came from |
| `pipe-listen` | `ok path` / `ok=false why=no-pane-id` / `ok=false path code error` | this pane's message channel: bound, never attempted (no address), or failed to bind — the failure that used to be silent |
| `pipe-rebind` | `pane path` | a second `session_start` replaced an existing server: the moment a channel can be lost |
| `pipe-vanish` | `pane path` | the socket path disappeared while the listener stayed open — every new `connect()` gets ENOENT; the worker rebinds |
| `pipe-rebind` (without a following `pipe-vanish`) | `pane path` | a session_start (a `/reload`, a revive) replaced the server: the ordered close is what keeps the new entry alive |
| `pipe-unreachable` | `pane path listening error` | a live pane did not take a request; `listening=false` means its extension host is not running and nothing was delivered |
| `observe-fallback` | `pane source=getTerminal\|unavailable state status` / `… error` | the children snapshot lacked the pane, so core was asked directly — or could not be asked at all |
| `probe` | `pane paneExists agentStatus` | the liveness/status core reports, the same answer `hc` gives |
| `gc-view` | `panes running watch` | piher's own view each sweep: every running row with the status core reports for it (`absent` = core does not know that terminal) |
| `recover` | `via running rearmed panes` | which running rows got a watcher back at session start |
| `registry-rebuild` | `via source=file\|branch before restored rows` | what a session start/adopt left in the registry: `source=file` is the session's own document (the normal case), `branch` the legacy branch entries, and only `before=0` means the instance is new — the state where a bounded restore used to drop rows |
| `registry-seed` | `from to` | a fork copied its parent's registry document, so it starts with the state it branched from |
| `gc-release` | `pane via taskId` | housekeeping moved a row out of `running` (`gc` / `zombie-sweep`) |
| `notice-buffered` | `pane queued contentLen` | the master was mid-turn, so the notice waits |
| `notice-sent` / `notice-requeued` | `pane contentLen` / `… error` | delivered immediately, or kept for the next flush |
| `notice-flushed` / `notice-flush-failed` | `mode count contentLen` | the buffered batch left, or was refused and put back |

## Reading a failure

Pick the pane (e.g. `t187`) and read its lines in order:

```sh
grep 'pane=t187' ~/.pi/agent/piher/trace.log
```

| What you see | What it means |
|---|---|
| `settle` then `push-skip why=no-text` | the worker finished but could not read its own closing text — the `file` field names the transcript it tried |
| `settle` then `push-failed` | the pipe to the master is broken; `to` names it |
| no `settle` at all | pi's `agent_settled` never reached the worker's extension |
| `reply claimed=false` | the push arrived but another path had already claimed that settlement |
| `poll-start` missing | no watcher ever ran for that pane: the row was never armed |
| `poll` ticks with `act=false textLen=null` and a `file` that is not the worker's | the poller is reading the wrong transcript |
| `poll` ticks with `act=true` but repeated `no-candidate` | the settlement predicate is refusing a worker that did produce output |
| `park wokeByEvent=false` over and over | core is not sending status events for that pane |
| `notice-buffered` and never `notice-flushed` | the master never finished a turn, so the batch stayed queued |
| `gc-release` while the agent was still working | housekeeping ended a row it should have left alone |
| `gc-view` shows `t187:done` while the row is `running` | piher's own view disagrees with core: the desync is on the reading side, not the event side |
| `observe-fallback source=unavailable` repeated | core cannot be asked about that pane, so every state read is blind |
| `pipe-listen ok=false` (worker side) | the worker has no message channel at all: every `send` to it is undeliverable |
| `pipe-rebind` followed by no `pipe-listen ok` | the replacement bind failed: the channel existed and was lost |
| `pipe-vanish` | something outside piher removed the socket path: the worker healed itself on the next check |
