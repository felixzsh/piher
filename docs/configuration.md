# Configuration

Two planes, and nothing else: **roles** (per file) and **env** (`PIHER_*`).

## Start here

```text
/piher-config            # plane index; hands a guided change to the agent
/piher-config show all   # effective value + where it came from, per key
/piher-config show roles # the role plane only
/piher-config show env   # the env plane only
/piher-config check      # validation across both planes
/piher-config doc        # write the current state to a report file
```

The command is **read-only**: it writes no configuration file. A change is made by the agent with
ordinary `edit`/`write` after it explains the effect, shows the diff and gets a confirmation — and
write locks apply as usual.

## The two planes

| Plane | Where it lives | Applies |
|---|---|---|
| `roles` | `<cwd>/.piher/roles/<name>.json`, then `~/.pi/agent/piher/roles/<name>.json`, then the bundled `src/roles/` | at the next spawn that names the role |
| `env` | the process environment | to new processes only |

Precedence inside the roles plane is the order above: the first layer that has the file wins, and a
malformed file is an error at the layer that holds it — piher never falls through to a lower layer
silently. `master` and `worker-default` are reserved: they are read from the bundle only, so a stray
file cannot hijack them.

The env plane is one registry (`packages/ext/src/options.ts`): a knob has one name, one default, and
one set of bounds, shared by the runtime and by this catalog. `PIHER_SUBAGENT`, `PIHER_DELEGATION`,
`PIHER_ROLE_MANIFEST` and `PIHER_ROLE_BASE` are not options: they are contracts handed to a child at
spawn.

## Which plane do I edit?

| I want to… | Plane | How | When it applies |
|---|---|---|---|
| Add a constrained worker profile | `roles` | Write `<repo>/.piher/roles/<name>.json` (schema: `packages/ext/schemas/role-manifest.schema.json`) | the next spawn that names it |
| Pin a model or thinking level to a role | `roles` | `model: "provider/model"`, `thinking: "low"` in the manifest | the next spawn |
| Make a role clean itself up | `roles` | `lifecycle: "one-shot"` | at that worker's settlement |
| Keep a role out of the model-facing list | `roles` | `modelInvocable: false` (still launchable by name) | immediately |
| Change a timeout, window or GC cadence | `env` | Export the `PIHER_*` variable | new pi processes |
| Choose where job logs are written | `env` | `PIHER_JOBS_DIR` (default: system temp `piher-jobs`) | new pi processes |
| Make a write conflict block instead of warn | `env` | `PIHER_WRITE_LOCK=1` | new pi processes |
| Change pi's own compaction | — | pi's `/settings`; piher neither reads nor proxies it | new session |

Every knob with its default is listed in the repository README's configuration table.

## Let the agent drive a change (recommended)

`/piher-config` with no arguments prints the plane index and injects a fixed procedure for the model:
read the effective value and its source, point at the documentation for that plane, explain the
effect and its cost, offer candidate values, ask what the person wants to achieve, show the diff and
how it takes effect, wait for confirmation, apply it with `edit`/`write`, then re-read with
`/piher-config check`.

Configuration touches cost (tokens), safety (keys leaving the machine) and lifecycle (hot reload vs a
new process), so a guided, constrained path is less error-prone than raw JSON — while the command
itself stays read-only and the actual write still goes through the normal tools and locks.

## Safety and troubleshooting

- **The command never dumps `process.env`**: it reads only the keys the catalog registers, and
  secret-shaped keys render as `***`.
- **"I changed it and nothing happened"** — `check` first: an out-of-bounds value is reported and the
  runtime falls back to the default. Then confirm whether a new process is needed; env is read once at
  start.
- **"The role is not applied"** — `show roles` prints every layer it looked at; `check` lists broken
  JSON and ignored built-in homonyms.
- **"A write was blocked"** — `/piher-locks` names every holder; the same table is in the
  `piher.lock.<hash>` labels (`hc get <terminal> --json`).

## Related

| Document | Content |
|---|---|
| [decisions.md](decisions.md) | The design decision index, each row anchored to the code |
| [role-manifest.schema.json](../packages/ext/schemas/role-manifest.schema.json) | The role contract: keys and types |
| [INSTALL.md](INSTALL.md) | Install, use, compatibility matrix |
