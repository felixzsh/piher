# AGENTS.md — machine and repository notes for agents working here

## git over SSH: a non-ASCII Windows username breaks `$HOME` in git-bash

**Symptom**: `git fetch/push` fails with `Host key verification failed` or
`Permission denied (publickey)`, and `ssh -v` shows `$HOME` expanded to a mangled GBK path:

```
debug1: identity file /c/Users/\322\266\360\251\323\356/.ssh/id_rsa type -1   # -1 = key not found
debug1: load_hostkeys: fopen /c/Users/\322\266\360\251\323\356/.ssh/known_hosts: No such file
```

**Cause**: the Windows account name is non-ASCII, so git-bash's `ssh` expands `$HOME` with the wrong
encoding. `~/.ssh/id_rsa` exists and cannot be read.

**Workaround** — an ASCII-path copy of the key, deleted right after use:

```sh
mkdir -p /f/.tmp-ssh && cp ~/.ssh/id_rsa ~/.ssh/id_rsa.pub /f/.tmp-ssh/
git -c core.sshCommand="ssh -i F:/.tmp-ssh/id_rsa \
  -o UserKnownHostsFile=F:/.tmp-ssh/known_hosts \
  -o StrictHostKeyChecking=accept-new" push origin master
rm -rf /f/.tmp-ssh   # delete the key copy immediately
```

Note: `ssh-keyscan -p 443 ssh.github.com` also fails here (KEX negotiation:
`unsupported KEX method sntrup761…`), so let `StrictHostKeyChecking=accept-new` record the host key
on the first connection. A permanent fix is an explicit absolute `IdentityFile` /
`UserKnownHostsFile` for `[ssh.github.com]:443` in `~/.ssh/config`.

## pi configuration: the authoritative file is `~/.pi/agent/settings.json`

There is also a top-level `~/.pi/settings.json`, and **pi does not read it** (`PI_CODING_AGENT_DIR`
defaults to `~/.pi/agent`). Changing the default provider/model only in the top-level file leaves new
pi sessions on the old model. Keep both files mirrored.

## Relay-model reliability (this network)

The glm-family models behind the `zai-coding-cn` and `opencode-go` relays **stall at random in the
middle of a tool-call argument stream**: the pi spinner freezes on the tool name with `working`, the
tool never executes, the session `.jsonl` ends mid-string inside the arguments, and the process keeps
one TCP connection open. Suspect the model before the extension code; `opencode-go/kimi-k2.7-code`
was stable in practice (switchable per spike through the `D98_MODEL` variable). To recover an
interrupted pi session, send ESC to the pane (`pane.send_keys {keys:["escape"]}`) and resend.

## Long commands

Anything that compiles, builds, installs dependencies or runs a test suite goes to `bg_job` — or, when
the role forbids it (a worker's manifest denies `bg_job`), to an `hc` terminal (`hc run --bg …`, then
`hc wait`) — never to a blocking shell call. `bash` is for short, interactive or order-dependent
commands.

## Tests: two tiers, and the rule for when to run which

The suite has two tiers. Pick by the size of the change, never by habit — running the full suite
after a one-line edit wastes the most expensive resource in the loop.

| Command | What runs | Time |
|---|---|---|
| `node --test --test-force-exit test/<file>.test.ts` | one suite you know you touched | ~1 s |
| `npm run test:fast` | `packages/ext/test/*.test.ts` — pure planners, roles, config catalog, renderers, transcript folding (318 tests) | ~4 s |
| `npm run test:integration` | `packages/ext/test/integration/*.test.ts` — boots the extension, real git worktrees, installer subprocesses, core-client sockets (121 tests) | ~9 s |
| `npm test` | `tsc --noEmit` + both tiers (439 tests) | ~20 s |

Rules:

- **A small edit runs the file you touched, or `test:fast`.** Never the full suite: a string, a
  comment or one function does not justify 20 s.
- **`npm test` is for a change that crosses modules, and before every commit and push.** That is
  where `typecheck` lives too.
- `test/integration/` is the tier for anything that spawns a process, starts a socket, touches a real
  git worktree or boots the composition root. A new suite with those properties belongs there, and
  the fast tier stays fast because of it.
- **Never remove `--test-force-exit` from the scripts.** Without it, the spawn harness in
  `worktree.test.ts` leaves a readiness wait pending and the process idles for the full 90 s
  `PIHER_READY_TIMEOUT_MS` after the last test — the suite looked 100 s long for that reason alone.
- `--test-timeout` (30 s fast, 120 s integration) is what turns a hang into a failure instead of a
  blocked terminal.
- Do not add real sleeps to a test to satisfy a timer. Set the budget the code reads
  (`PIHER_SETTLE_WINDOW_MS`, `PIHER_READY_TIMEOUT_MS`, …) to something small in the harness instead.
- Anything long goes to `bg_job` (or an `hc` terminal when the role forbids it), never to a blocking
  shell call.
