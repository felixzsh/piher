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

Anything that compiles, builds, installs dependencies or runs a test suite belongs in a background
terminal (`hc run --bg …`, then `hc wait`), not in a blocking shell call. `bash` is for short,
interactive or order-dependent commands.
