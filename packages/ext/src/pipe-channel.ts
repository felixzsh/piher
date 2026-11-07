/**
 * M11 separates the human/machine channels (D45–D47) by having the pi extension create its own
 * Windows named pipe.
 *
 *  - Controller (client): one connection per request, matching the herdr client;
 *  - Child pane (server): when PIHER_SUBAGENT=1, the extension starts a server at session_start
 *    and injects prompt/follow_up through pi.sendUserMessage (visible in TUI);
 *  - Completion data is not sent back; authoritative state lives in herdr, session JSONL, and
 *    history (D47).
 *
 * Only pure transport-layer logic here; index.ts performs pi injection in the server callback.
 */
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

function encodePaneId(paneId: string): string {
  return String(paneId).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** POSIX sun_path caps at ~104-108 bytes and libuv silently truncates longer paths, which would
 *  collide every pane of a workspace onto one socket under long TMPDIRs (macOS /var/folders).
 *  The workspace therefore rides as a 16-hex digest instead of its path. */
function workspaceDigest(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/** Pipe name: workspace-scoped + paneId, short enough for every socket namespace. */
export function pipeNameFor(cwd: string, paneId: string): string {
  return `piher-${workspaceDigest(cwd)}-${encodePaneId(paneId)}`;
}

/** The names a client tries in order; one today, and the list keeps that a transport detail. */
export function pipeNameCandidates(cwd: string, paneId: string): string[] {
  return [pipeNameFor(cwd, paneId)];
}

/** Windows named-pipe address in the kernel namespace, not a filesystem path. */
export function pipePathFor(name: string): string {
  return process.platform === 'win32'
    ? (name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`)
    : `/tmp/${name}.sock`;
}

/** Pipe message in the JSON-lines protocol; one connection carries one request and response. */
export type PipeRequest =
  | { type: 'ping'; id: string }
  | {
      type: 'prompt' | 'follow_up';
      id: string;
      text: string;
      /** D49: reply follows the sender's pipe name, avoiding hard-coded controller/child roles. */
      from?: string | null;
      /** B3: deliver follow_up as steer so it arrives between tool calls within seconds. Missing/false keeps
       * queue semantics (delivered when the run ends); the initial prompt stays queued while continuations steer. */
      steer?: boolean;
    }
  | { type: 'interrupt'; id: string }
  | {
      /** P0 (RFC §4.4): master switches a worker's role; the worker applies the manifest swap and
       * replies ok/error. Mixed-version peers answer `unknown type role`, which the master surfaces. */
      type: 'role';
      id: string;
      role: string;
    }
  | {
      /** D50: fast-path settlement reply from child to requester, with summary and session path for progressive disclosure. */
      type: 'reply';
      id: string;
      paneId: string;
      text: string | null;
      sessionFile: string | null;
    };

export type PipeResponse =
  | { type: 'ok'; id: string; detail?: string }
  | { type: 'error'; id: string; message: string };

/** Response side of the protocol (`ok` / `error`): requests never use these tags, so this is a sound
 * discriminator when narrowing a parsed line at the answering end. */
function isPipeResponse(value: PipeRequest | PipeResponse): value is PipeResponse {
  return value.type === 'ok' || value.type === 'error';
}

function parsePipeLine(line: string): PipeRequest | PipeResponse | null {
  const t = (line ?? '').trim();
  if (!t) return null;
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object' && typeof obj.type === 'string') return obj as PipeRequest | PipeResponse;
  } catch {
  }
  return null;
}

/** One connection, one request: connect → write JSON line → wait for JSON line → close. Timeout /
 * connect failure / bad frame throw (caller retries). */
export function pipeRequest(
  pipeName: string,
  payload: PipeRequest,
  timeoutMs = 8000,
): Promise<PipeResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(pipePathFor(pipeName));
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(`pipe ${pipeName}: ${payload.type} timeout`));
      }
    }, timeoutMs);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      sock.destroy();
      const parsed = parsePipeLine(buf.slice(0, i));
      if (!parsed || !isPipeResponse(parsed)) {
        reject(new Error(`pipe ${pipeName}: bad response frame`));
        return;
      }
      resolve(parsed);
    });
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    sock.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`pipe ${pipeName}: connection closed`));
      }
    });
  });
}

export async function pipeRequestTo(
  cwd: string,
  paneId: string,
  payload: PipeRequest,
  timeoutMs = 8000,
): Promise<PipeResponse> {
  const names = pipeNameCandidates(cwd, paneId);
  let lastErr: unknown;
  for (const name of names) {
    try {
      return await pipeRequest(name, payload, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`pipe ${names[0] ?? paneId}: unreachable`);
}

type PipeMessageHandler = (req: PipeRequest) => Promise<PipeResponse>;

/** One pipe server per pane, across module copies. A pane can load piher twice (an installed package
 *  plus the `-e` the spawner passes), and two servers on one socket path steal it from each other: the
 *  loser's requests reach whichever instance bound last — and after a reload that is the instance whose
 *  ctx is stale, so every follow-up comes back as "ctx is stale after session replacement or reload".
 *  The registry lives on globalThis because two copies of this module share no module state. */
const PIPE_OWNER_KEY = Symbol.for('piher.pipeServerOwner');
const PIPE_GENERATION_KEY = Symbol.for('piher.pipeServerGeneration');

interface PipeOwner {
  readonly generation: number;
  /** Shuts the previous owner's server down; awaited before the new one binds. */
  readonly close: () => Promise<void>;
}

function ownerRegistry(): Map<string, PipeOwner> {
  const store = globalThis as unknown as Record<symbol, unknown>;
  const existing = store[PIPE_OWNER_KEY];
  // globalThis outlives a reload, so the value may belong to an older build with another shape (the
  // first version kept a Set of pane ids). Interpreting it would throw on the first rebind after an
  // upgrade, so an unknown shape is discarded rather than trusted.
  if (existing instanceof Map) return existing as Map<string, PipeOwner>;
  const fresh = new Map<string, PipeOwner>();
  store[PIPE_OWNER_KEY] = fresh;
  return fresh;
}

/** Become the pane's channel owner, closing whoever held it first. Last writer wins on purpose: after
 *  a reload the newest instance is the one with a live ctx, and the previous one must stop answering.
 *  Closing before binding also keeps the socket entry alive (libuv unlinks on close). */
export async function takeOverPipe(paneId: string, close: () => Promise<void>): Promise<number> {
  const store = globalThis as unknown as Record<symbol, number | undefined>;
  store[PIPE_GENERATION_KEY] = (store[PIPE_GENERATION_KEY] ?? 0) + 1;
  const generation = store[PIPE_GENERATION_KEY];
  const previous = ownerRegistry().get(paneId);
  if (previous) {
    try {
      await previous.close();
    } catch {
      /* the previous owner is already gone: the bind below is the only thing left to do */
    }
  }
  ownerRegistry().set(paneId, { generation, close });
  return generation;
}

/** Still the owner? A watchdog must stop healing a channel someone else took over. */
export function ownsPipe(paneId: string, generation: number): boolean {
  return ownerRegistry().get(paneId)?.generation === generation;
}

export function releasePipe(paneId: string, generation: number): void {
  if (ownsPipe(paneId, generation)) ownerRegistry().delete(paneId);
}

/** Close a pipe server and wait for the close to complete, so its entry is gone before the next bind.
 *  Binding first and closing second is the trap: libuv unlinks the path on close, and it would remove
 *  the entry the new server just created — a listener nobody can connect to. */
export function closePipeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Server: one line in → handler → one line out → close. Returns the server (caller closes it). */
export function startPipeServer(
  pipeName: string,
  handler: PipeMessageHandler,
  onError?: (err: Error) => void,
): net.Server {
  const socketPath = pipePathFor(pipeName);
  // POSIX leaves the UNIX domain socket behind after a crash, and the next listen fails with
  // EADDRINUSE unless it is unlinked before bind (Windows named pipes need no unlink). Best-effort:
  // if unlink fails, listen reports the real error through onError.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* see above: listen surfaces the actionable error */
    }
  }
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const parsedLine = parsePipeLine(line);
      if (!parsedLine || isPipeResponse(parsedLine)) {
        sock.end(JSON.stringify({ type: 'error', id: '', message: 'bad frame' }) + '\n');
        return;
      }
      const req: PipeRequest = parsedLine;
      void handler(req)
        .then((res) => {
          sock.end(JSON.stringify(res) + '\n');
        })
        .catch((err: unknown) => {
          sock.end(JSON.stringify({
            type: 'error',
            id: req.id,
            message: String((err as Error)?.message ?? err),
          }) + '\n');
        });
    });
    sock.on('error', () => {
      /* client disconnect: silent */
    });
  });
  if (onError) {
    server.on('error', onError);
  } else {
    // Always attach a listener: an EventEmitter 'error' with no listener throws and would take the
    // whole extension host down on a transient listen failure; pass onError to observe it (F04).
    server.on('error', () => { /* swallowed by design; pass onError to observe */ });
  }
  // No 'close' handler removes the entry: libuv already unlinks a unix socket when its server closes
  // (verified: listen + close leaves no file). That is also why a rebind MUST close the old server to
  // completion first — closing it after the new one bound deletes the NEW entry, leaving a live
  // listener that no connect() can reach. See closePipeServer.
  server.listen(socketPath);
  return server;
}
