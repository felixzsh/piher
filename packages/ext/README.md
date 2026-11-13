# piher

The pi extension behind **piher**: it registers the `subagent` and `bg_job` tools and runs what they
start as [herdr-core](https://herdr.dev/) (`hc`) terminals, which the optional **Herdr app** shows as
spaces, tabs and panes.

A subagent is a separate pi session in its own terminal — its own context, visible in the app, and
attachable by a human at any time. Inside a core terminal (`HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`)
both tools are live; outside one they are not registered, and the extension only replays what a
transcript already recorded.

## Install

```sh
curl -fsSL https://releases.herdr.dev/core/install.sh | sh   # herdr-core, required for the tools
pi install npm:piher                                        # this package
```

`pi update --extensions` updates it, `pi remove npm:piher` removes it. Without `hc` the package still
loads and both tools answer with that install command instead of running anything.

## What it registers

| Surface | Names |
|---|---|
| Tools | `subagent` (`spawn`, `send`, `retry`, `output`, `list`, `interrupt`, `resume`, `close`, `help`), `bg_job` (`start`, `status`, `log`, `stop`, `list`) |
| Commands | `/piher-role`, `/piher-config`, `/piher-locks` |
| Skill | `piher-tools` — when to delegate, what a prompt must contain, the answer-or-`BLOCKED:` report contract |
| Session entries | `piher.delegation`, `piher.settlement`, `piher.role-manifest`, `piher.job-exit`, `piher.config-guide` |
| Terminal labels | `piher.lock.<hash>` (piher's own); `hresume` is the worker's, written by its Herdr extension |

## Package contents

```
src/          # the extension
src/roles/    # bundled role manifests (master, worker-default)
schemas/      # role-manifest JSON schema
skills/       # the shipped skill
test/         # node --test suites
```

## Requirements

- Node ≥ 22
- pi ≥ 1.4.0 (`@earendil-works/pi-coding-agent`) — its native OSC 7501 reporter is the only status source
- herdr-core `hc` ≥ 0.1.16 — required for both tools
- Herdr app (optional) — display only

## Development

```sh
npm install --ignore-scripts      # from the repository root
npm test                          # typecheck + node --test
```

The repository README covers the architecture, roles, the task documents, configuration and the
plugin-conflict rules.

## License

MIT
