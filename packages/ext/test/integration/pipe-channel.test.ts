/** M11 pipe-channel transport (D45): deterministic naming, the JSON-lines request/response contract,
 * and its error paths. The round trip over a real socket IS the contract here — no in-process fakes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import * as net from 'node:net';
import * as fs from 'node:fs';
import {
  closePipeServer, ownsPipe, pipeNameCandidates, pipeNameFor, pipePathFor, pipeRequest, pipeRequestTo,
  releasePipe, startPipeServer, takeOverPipe,
} from '../../src/pipe-channel.ts';
import { jsonl } from '../test-utils.ts';

type Handler = Parameters<typeof startPipeServer>[1];
type FrameCase = { name: string; line: string; handler: Handler; message: RegExp };
type PeerCase = { name: string; timeout: number; match: RegExp; maxMs?: number; accept?: (s: net.Socket) => void };

const uniqueName = (prefix: string): string =>
  `piher-${prefix.replace(/[^\w]+/g, '-')}-${process.pid}-${Date.now()}`;

const okHandler: Handler = async (req) => ({ type: 'ok', id: req.id });

/** Binds `create(name)` on a fresh pipe name and runs `body`; a half-open socket would stall close()
 *  forever, so tracked sockets are destroyed first. `beforeBind` seeds the path. */
async function withServer<T>(prefix: string, create: (name: string) => net.Server, body: (name: string) => Promise<T>, beforeBind?: (name: string) => void): Promise<T> {
  const name = uniqueName(prefix);
  beforeBind?.(name);
  const server = create(name);
  const sockets = new Set<net.Socket>();
  server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  try {
    // `once` rejects on 'error', so a failed bind surfaces instead of hanging.
    if (!server.listening) await once(server, 'listening');
    return await body(name);
  } finally {
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Write one raw protocol line to `name` and resolve with the parsed reply frame. */
async function sendLine(name: string, line: string): Promise<Record<string, unknown>> {
  const sock = net.createConnection(pipePathFor(name));
  const done = Promise.withResolvers<string>();
  let buf = '';
  sock.setEncoding('utf8').on('data', (chunk) => { buf += chunk; });
  sock.on('end', () => done.resolve(buf)).on('error', done.reject).on('connect', () => { sock.write(line); });
  return JSON.parse((await done.promise).split('\n')[0] || 'null') as Record<string, unknown>;
}

test('pipe naming: one workspace-scoped digest name per pane', () => {
  const digest = (cwd: string) => pipeNameFor(cwd, 'w').split('-')[1]!;
  // Digest form: short, workspace-unique, paneId tail encoded like every other candidate.
  assert.match(pipeNameFor('F:\\piher', 'w6:p2C'), /^piher-[0-9a-f]{16}-w6-p2C$/);
  assert.notEqual(digest('F:\\piher'), digest('/home/u/proj'), 'workspaces must not collide');
  assert.deepEqual(pipeNameCandidates('F:\\piher', 'w6:p2C'), [pipeNameFor('F:\\piher', 'w6:p2C')]);
});

test('pipe naming: the primary socket path fits every unix sun_path (no silent truncation)', () => {
  const longCwd = process.platform === 'win32'
    ? 'C:\\Users\\runner\\AppData\\Local\\Temp\\a-workspace-name-long-enough-to-overflow-any-historical-encoding'
    : '/var/folders/h8/9t7dh7ls3jjczmzp0l8tq5500000gn/T/a-workspace-name-long-enough-to-overflow';
  const path = pipePathFor(pipeNameFor(longCwd, 'w1:p9'));
  if (process.platform !== 'win32') {
    assert.ok(path.length <= 100, `${path} would truncate sun_path and collide panes`);
  } else {
    assert.ok(path.startsWith('\\\\.\\pipe\\') && path.length < 200);
  }
});

test('pipePathFor: win32 namespace prefix, POSIX /tmp socket path', () => {
  const original = process.platform;
  const CASES: Array<[NodeJS.Platform, string, string]> = [
    ['win32', '\\\\.\\pipe\\already', '\\\\.\\pipe\\already'],
    ['win32', 'plain', '\\\\.\\pipe\\plain'],
    ['linux', 'test-pipe', '/tmp/test-pipe.sock'],
  ];
  try {
    for (const [platform, input, expected] of CASES) {
      Object.defineProperty(process, 'platform', { value: platform, writable: true });
      assert.equal(pipePathFor(input), expected, `${platform}: pipePathFor(${input})`);
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: original, writable: true });
  }
});

test('pipeRequest: round-trip dispatch of ping/prompt, error frames returned as-is', async () => {
  const seen: string[] = [];
  await withServer('roundtrip', (name) => startPipeServer(name, async (req) => {
    seen.push(req.type);
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'pong' };
    if (req.type === 'prompt') return { type: 'ok', id: req.id };
    return { type: 'error', id: req.id, message: 'Test error' };
  }), async (name) => {
    assert.deepEqual(await pipeRequest(name, { type: 'ping', id: 'p1' }), { type: 'ok', id: 'p1', detail: 'pong' });
    assert.equal((await pipeRequest(name, { type: 'prompt', id: 'p2', text: 'hi' })).type, 'ok');
    const denied = await pipeRequest(name, { type: 'role', id: 'p3', role: 'reviewer' }, 2000);
    assert.deepEqual(denied, { type: 'error', id: 'p3', message: 'Test error' });
    assert.deepEqual(seen, ['ping', 'prompt', 'role']);
  });
});

test('startPipeServer: bad frame / handler throw answer with error frames', async (t) => {
  const CASES: FrameCase[] = [
    { name: 'malformed line → bad frame', line: 'not-json\n', handler: okHandler, message: /^bad frame$/ },
    { name: 'handler throw → error frame with the message', line: `${jsonl({ type: 'ping', id: 't1' })}`,
      handler: async () => { throw new Error('handler exploded'); }, message: /handler exploded/ },
  ];
  for (const c of CASES) {
    await t.test(c.name, () => withServer(c.name, (name) => startPipeServer(name, c.handler), async (name) => {
      const reply = await sendLine(name, c.line);
      assert.equal(reply.type, 'error');
      assert.match(String(reply.message), c.message);
    }));
  }
});

test('pipe-channel: a rebind must close the old server to completion first', async () => {
  // The messaging channel of a worker is its only way in, and libuv unlinks a unix socket when its
  // server closes. Bind-then-close therefore deletes the entry the NEW server just created: the
  // listener stays open, every connect() gets ENOENT, and a live worker is unreachable with nothing in
  // any log. This pins the ordering that prevents it.
  const name = 'piher-test-rebind-order';
  const path = pipePathFor(name);
  const h: Handler = async () => ({ type: 'ok', id: 'x' });

  const first = startPipeServer(name, h);
  await once(first, 'listening');
  assert.ok(fs.existsSync(path), 'the first server owns the entry');
  await closePipeServer(first);
  assert.ok(!fs.existsSync(path), 'closing it removes the entry');

  const second = startPipeServer(name, h);
  await once(second, 'listening');
  assert.ok(fs.existsSync(path), 'the rebind left a reachable entry');

  // The trap itself, kept as a witness: a newer server bound before the older one closes loses its path.
  const third = startPipeServer(name, h);
  await once(third, 'listening');
  await closePipeServer(second);
  assert.ok(!fs.existsSync(path), 'libuv removed the newer entry — the reason the close is awaited first');
  await closePipeServer(third);
});

test('pipe ownership: the newest instance takes the pane over and the old server stops', async () => {
  // Exactly one server per pane. A second copy of the extension in the same pane (an installed package
  // plus the spawner's `-e`) or a reload must leave one server serving the path — and it must be the
  // newest one, because the previous instance's ctx is stale and answers every follow-up with an error.
  const name = 'piher-test-takeover';
  const path = pipePathFor(name);
  const pane = 't_takeover_pane';
  const h: Handler = async () => ({ type: 'ok', id: 'x' });

  let first: net.Server | null = null;
  const gen1 = await takeOverPipe(pane, async () => {
    if (first) await closePipeServer(first);
    first = null;
  });
  first = startPipeServer(name, h);
  await once(first, 'listening');
  assert.ok(ownsPipe(pane, gen1));
  assert.ok(fs.existsSync(path), 'the owner serves a reachable path');

  let second: net.Server | null = null;
  const gen2 = await takeOverPipe(pane, async () => {
    if (second) await closePipeServer(second);
    second = null;
  });
  assert.ok(gen2 > gen1, 'generations are monotonic, so "newest" is decidable');
  assert.equal(ownsPipe(pane, gen1), false, 'the previous owner steps aside');
  assert.ok(ownsPipe(pane, gen2));
  assert.equal(first, null, 'the previous server was closed: only one can serve the path');

  second = startPipeServer(name, h);
  await once(second, 'listening');
  const ping = await pipeRequest(name, { type: 'ping', id: 'p1' }, 2000);
  assert.equal(ping.type, 'ok', 'the new owner answers on the same path');
  assert.ok(fs.existsSync(path), 'the takeover left the entry in place');

  releasePipe(pane, gen2);
  assert.equal(ownsPipe(pane, gen2), false, 'shutdown releases the pane for the next instance');
  await closePipeServer(second);
});

test('pipe ownership: a registry left by an older build is discarded, not interpreted', async () => {
  // globalThis survives a reload, so the first rebind after an upgrade can find the previous build's
  // value there. The first version kept a Set of pane ids; reading it as a Map would throw exactly when
  // the channel matters most.
  const key = Symbol.for('piher.pipeServerOwner');
  const store = globalThis as unknown as Record<symbol, unknown>;
  store[key] = new Set(['t_legacy']);
  const pane = 't_legacy_pane';
  let closed = 0;
  const generation = await takeOverPipe(pane, async () => { closed += 1; });
  assert.ok(ownsPipe(pane, generation), 'the registry is rebuilt and usable');
  assert.equal(closed, 0, 'a foreign registry names no owner to close');
  releasePipe(pane, generation);
  assert.equal(ownsPipe(pane, generation), false);
});

test('pipe ownership: two module copies share the claim (duplicate load in one pane)', async () => {
  // The two copies of this module share no module state, so the registry lives on globalThis. Without
  // that, both copies bind the same socket and steal it from each other — the failure this prevents.
  const copySpecifier = '../../src/pipe-channel.ts?copy=2';
  const copy2 = await import(copySpecifier) as typeof import('../../src/pipe-channel.ts');
  const pane = 't_dup_pane';
  let closed = 0;
  const genA = await takeOverPipe(pane, async () => { closed += 1; });
  assert.ok(copy2.ownsPipe(pane, genA), 'the second copy sees the first copy\'s claim');
  const genB = await copy2.takeOverPipe(pane, async () => { closed += 1; });
  assert.equal(closed, 1, 'taking over closes the previous holder exactly once');
  assert.equal(ownsPipe(pane, genA), false, 'the first copy is no longer the owner');
  assert.ok(copy2.ownsPipe(pane, genB));
  copy2.releasePipe(pane, genB);
  assert.equal(copy2.ownsPipe(pane, genB), false);
});

test('startPipeServer: a bind failure is reported, not swallowed', async () => {
  // net.Server announces a failed bind on 'error' only. With no listener that error was invisible, so
  // a live worker could lose its whole channel and nothing anywhere said why (a master then waited the
  // full readiness budget for a pipe that would never exist).
  const errs: Error[] = [];
  // A name with a separator puts the socket under a directory that does not exist: bind fails ENOENT.
  const server = startPipeServer('piher-test/nodir-bind', async () => ({ type: 'ok', id: 'x' }), (e) => errs.push(e));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(errs.length, 1, 'one error, delivered to the caller');
  const code = (errs[0] as NodeJS.ErrnoException).code;
  assert.ok(code, `the failure carries its errno (got ${code})`);
  assert.match(errs[0]!.message, /nodir-bind/, 'the message names the socket that could not be bound');
  server.close();
});

test('pipeRequest: rejects on bad frame, silence, peer hangup and a missing peer', async (t) => {
  const CASES: PeerCase[] = [
    // Scripted raw peers: junk reply / silence / immediate hangup.
    { name: 'malformed response frame', timeout: 2000, match: /bad response frame/, accept: (s) => s.on('data', () => { s.end('not valid JSON\n'); }) },
    { name: 'no answer within the deadline', timeout: 150, match: /timeout/, accept: () => {} },
    { name: 'peer hangs up before answering', timeout: 5000, maxMs: 3000, match: /connection closed|EPIPE|ECONNRESET/, accept: (s) => { s.end(); } },
    { name: 'no server listening', timeout: 400, match: /ENOENT/ },
  ];
  for (const c of CASES) {
    await t.test(c.name, async () => {
      const started = Date.now();
      const run = async (name: string) => {
        await assert.rejects(() => pipeRequest(name, { type: 'ping', id: 'x' }, c.timeout), c.match);
        // A hangup must reject at once rather than wait out the 5s deadline.
        if (c.maxMs) assert.ok(Date.now() - started < c.maxMs, 'must reject on disconnect, not on timeout');
      };
      await (c.accept
        ? withServer(c.name, (name) => net.createServer(c.accept!).listen(pipePathFor(name)), run)
        : run(uniqueName(c.name)));
    });
  }
});

test('pipeRequestTo: the candidate list is tried in order and the last error propagates', async (t) => {
  const cwd = 'F:\\piher';
  const paneId = `w-test:${process.pid}`;
  const names = pipeNameCandidates(cwd, paneId);
  assert.equal(names.length, 1);
  const answering: Handler = async (req) => ({ type: 'ok', id: req.id, detail: 'primary' });
  await t.test('reaches the server listening on the primary name', () =>
    withServer('primary', () => startPipeServer(names[0]!, answering), async () => {
      assert.deepEqual(await pipeRequestTo(cwd, paneId, { type: 'ping', id: 'p1' }, 2000),
        { type: 'ok', id: 'p1', detail: 'primary' });
    }));
  await t.test('no name listening throws the connection error', () =>
    assert.rejects(() => pipeRequestTo(`/no-such-${process.pid}`, 'w0:p0', { type: 'ping', id: 'x' }, 400)));
});

test('startPipeServer (F04): POSIX unlinks a stale socket file before listen', async () => {
  if (process.platform === 'win32') return; // Windows pipes live in the kernel namespace: no stale file
  await withServer('stale', (name) => startPipeServer(name, okHandler), async (name) => {
    const res = await pipeRequest(name, { type: 'ping', id: 'after-stale' }, 2500);
    assert.equal(res.type, 'ok', 'a stale socket file must not break listen');
  }, (name) => {
    // A crashed peer: Node's own close() removes the real socket file, so a placeholder stands in.
    fs.writeFileSync(pipePathFor(name), '');
  });
});

test('startPipeServer (F04): a failed listen reaches onError and never kills the process', async () => {
  // An 'error' event with no listener would take the extension host down, so a failed bind must reach
  // onError while a listener-less server stays alive. The address is squatted: POSIX a directory
  // (unlink-proof → EADDRINUSE), Windows a live server holding the name (FIRST_PIPE_INSTANCE).
  const name = uniqueName('badpath');
  const socketPath = pipePathFor(name);
  const squatter = net.createServer(() => {});
  if (process.platform === 'win32') await new Promise<void>((r) => squatter.listen(socketPath, () => r()));
  else fs.mkdirSync(socketPath, { recursive: true });
  try {
    const bound = Promise.withResolvers<Error | null>();
    startPipeServer(name, okHandler, bound.resolve).on('listening', () => bound.resolve(null));
    const seen = await bound.promise;
    assert.ok(seen, 'a failed listen must surface through onError (or a throw)');
    assert.match(String((seen as Error & { code?: string }).code ?? ''), /EADDRINUSE/);
    // Without onError, src's built-in sink must swallow it — the crash would only show once the event
    // fires, and it fires asynchronously, so real time is the only observable here.
    startPipeServer(name, okHandler);
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(socketPath, { recursive: true, force: true });
  }
});
