# Domain and storage model

One row type, two documents, and a status that is observed rather than stored.

## Entities

| entity | identity | lifetime | owned by |
|---|---|---|---|
| task | `taskId` (uuid, minted at spawn) | until `close`; a record file may outlive it | whoever spawned it |
| generation | `paneId` | one pane/transcript; replaced on revive | the task |
| session view | `sessionId` | the session; copied by a fork | the session |

A task is `unresolved` until it is closed. A report is `undelivered` until the master consumes it. Those
two facts — plus identity and the current generation — are the whole domain; everything else a surface
shows is derived.

## Row

```ts
type TaskRow = {
  taskId: string;
  description: string;
  kind: string;                       // role profile the worker was launched with
  lifecycle: 'one-shot' | 'persistent';
  cwd: string;
  worktree?: WorktreeRecord;          // the checkout the spawn created, if any
  createdAt: number;
  closedAt: number | null;            // S9: the master's final word
  gen: {
    paneId: string;
    slug: string;
    tabId: string;
    tabName: string;
    sessionFile: string | null;       // the worker's transcript: resume needs it to exist
    launchCommand: string[];
    startedAt: number;
    consumedAt: number | null;        // S10: the report reached the master
    reportDelivered: { fingerprint: string; at: number } | null;
  };
};
```

Not stored anywhere: terminal status, agent status, elapsed time, whether the pane exists. Those are read
from core when a surface needs them (`observed`), which is why no reload can restore a lie, and why a stale
observation can only mislabel a row — every action probes core itself (**S26**).

## Documents

```
<repo>/.piher/tasks/<taskId>.json       { "version": 1, "rows": [ TaskRow ] }
<sessionDir>/piher/<sessionId>/tasks.json   { "version": 1, "taskIds": [ string ] }
```

- The repository is resolved the way the ledger resolved it: from the session's checkout to its main
  working tree, so every worktree of a repository shares one task directory.
- `<sessionDir>` is the directory of the session transcript; the state lives beside it, under `piher/`.
- A record file holds one row inside a `rows` array: the same envelope as the view, parsed by the same
  reader, with exactly one element — the task's current answer.

## Predicates

```
isClosed(row)     = row.closedAt !== null
isSpent(row)      = row.lifecycle === 'one-shot' && row.gen.consumedAt !== null
isActionable(row) = !isClosed(row) && !isSpent(row)
```

Every surface answers from these three. There is no fourth state.

## Operations

| operation | reads | writes |
|---|---|---|
| spawn | — | record, view |
| send (steer) | record, core status | record (nothing unless the turn changes it) |
| send (revive) | record, core status | record (new generation), view unchanged |
| settle / report delivered | — | record (`consumedAt`, fingerprint) |
| close | record, core status | record (`closedAt`) |
| retry (same task) | record | record |
| retry (new task) | record | new record, view |
| resume | record | record (new generation) |
| list | view, records, core status | — |

The view changes only when a task is created or adopted; every other operation touches one record.

## Restore, fork, resume

- **Restore** (`session_start`): read the view, then each referenced record, drop closed rows, and re-probe
  nothing — liveness arrives from core on the next observation.
- **Fork** (`reason: fork`): copy the parent's view document once, before the restore reads it. Records are
  shared, not copied: the fork continues the same tasks.
- **Resume**: one record by `taskId`. Refuse `closedAt !== null`; refuse a missing transcript with the path
  it expected.
- **No transcript path**: the session keeps its view in memory and still writes records under the
  repository, so those tasks stay resumable and closable; there is nothing to restore and nothing to seed
  (**S25**).

## Concurrency

One writer per document. Two sessions of the same repository write different record files, so they never
clobber each other. The single cross-session write is another session's `close`: one record, final by
definition (**S24**).
