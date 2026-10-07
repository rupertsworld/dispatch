/** Integration tests for Claude session discovery and inbox socket submission. */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { listSessions, submitMessage } from './claude.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(listing: unknown, record?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-claude-'));
  temporaryDirectories.push(directory);
  const configDir = join(directory, 'claude');
  await mkdir(join(configDir, 'sessions'), { recursive: true });
  const claudeBinary = join(directory, 'fake-claude');
  await writeFile(claudeBinary, `#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') !== 'agents --json') process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(listing))});\n`);
  await chmod(claudeBinary, 0o755);
  if (record) await writeFile(join(configDir, 'sessions', `${record.pid}.json`), JSON.stringify(record));
  return { configDir, claudeBinary, timeoutMs: 3_000 };
}

async function currentProcessStart(): Promise<string> {
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ps', ['-p', String(process.pid), '-o', 'lstart=']);
    return stdout.trim();
  }
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

async function listen(socketPath: string, onData?: (data: string) => void): Promise<void> {
  const server = createServer(socket => {
    if (onData) socket.on('data', data => onData(data.toString()));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

test('lists a live session and submits the complete JSONL user frame to its socket', async () => {
  const sessionId = 'aa11bb22-cc33-dd44-ee55-ff6677889900';
  const listing = [{ sessionId, name: 'Working agent', cwd: '/project', state: 'idle' }];
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-socket-'));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, 'inbox.sock');
  const frames: string[] = [];
  let frameReceived!: () => void;
  const received = new Promise<void>(resolve => { frameReceived = resolve; });
  await listen(socketPath, data => { frames.push(data); frameReceived(); });
  const options = await fixture(listing, {
    sessionId, pid: process.pid, procStart: await currentProcessStart(), messagingSocketPath: socketPath,
  });

  assert.deepEqual(await listSessions(options), [{
    session_id: sessionId, name: 'Working agent', cwd: '/project', status: 'idle', availability: 'available',
  }]);
  await submitMessage(sessionId, 'Hello\nthere', options);
  await received;

  assert.equal(frames.length, 1);
  assert.ok(frames[0]!.endsWith('\n'));
  const frame = JSON.parse(frames[0]!);
  assert.match(frame.msg_id, /^[0-9a-f-]{36}$/);
  delete frame.msg_id;
  assert.deepEqual(frame, {
    msgV: 1, type: 'user', message: { role: 'user', content: 'Hello\nthere' },
    priority: 'next', session_id: sessionId,
  });
});

test('reports a stale process record as unavailable and refuses submission', async () => {
  const sessionId = 'stale-session';
  const options = await fixture([{ sessionId, name: null, cwd: null, status: 'running' }], {
    sessionId, pid: process.pid, procStart: '1', messagingSocketPath: '/tmp/no-socket.sock',
  });
  const sessions = await listSessions(options);
  assert.equal(sessions[0]?.availability, 'unavailable');
  assert.match(sessions[0]?.reason ?? '', /process/i);
  await assert.rejects(submitMessage(sessionId, 'hello', options), /process/i);
});

test('reports an unreachable socket and refuses submission', async () => {
  const sessionId = 'offline-session';
  const options = await fixture([{ sessionId, state: 'running' }]);
  await writeFile(join(options.configDir, 'sessions', `${process.pid}.json`), JSON.stringify({
    sessionId, pid: process.pid, procStart: await currentProcessStart(),
    messagingSocketPath: join(options.configDir, 'missing.sock'),
  }));
  const sessions = await listSessions(options);
  assert.equal(sessions[0]?.availability, 'unavailable');
  assert.match(sessions[0]?.reason ?? '', /socket/i);
  await assert.rejects(submitMessage(sessionId, 'hello', options), /socket/i);
});

test('only submits to a matching session record and errors when Claude listing fails', async () => {
  const options = await fixture([{ sessionId: 'listed-session' }], {
    sessionId: 'other-session', pid: process.pid, procStart: await currentProcessStart(),
    messagingSocketPath: '/tmp/unused.sock',
  });
  const sessions = await listSessions(options);
  assert.equal(sessions[0]?.availability, 'unavailable');
  await assert.rejects(submitMessage('listed-session', 'hello', options), /session record/i);
  await assert.rejects(listSessions({ ...options, claudeBinary: '/no/such/claude' }), /claude agents --json/i);
});

test('uses a live record when another file has a stale record for the same session', async () => {
  const sessionId = 'resumed-session';
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-socket-'));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, 'inbox.sock');
  const frames: string[] = [];
  let frameReceived!: () => void;
  const received = new Promise<void>(resolve => { frameReceived = resolve; });
  await listen(socketPath, data => { frames.push(data.toString()); frameReceived(); });
  const options = await fixture([{ sessionId }], {
    sessionId, pid: process.pid, procStart: '1', messagingSocketPath: join(directory, 'stale.sock'),
  });
  await writeFile(join(options.configDir, 'sessions', 'live.json'), JSON.stringify({
    sessionId, pid: process.pid, procStart: await currentProcessStart(), messagingSocketPath: socketPath,
  }));

  assert.equal((await listSessions(options))[0]?.availability, 'available');
  await submitMessage(sessionId, 'hello', options);
  await received;
  assert.equal(JSON.parse(frames[0]!).message.content, 'hello');
});

test('refuses to choose between two live sockets for the same session', async () => {
  const sessionId = 'ambiguous-session';
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-socket-'));
  temporaryDirectories.push(directory);
  const firstSocket = join(directory, 'first.sock');
  const secondSocket = join(directory, 'second.sock');
  await listen(firstSocket);
  await listen(secondSocket);
  const processStart = await currentProcessStart();
  const options = await fixture([{ sessionId }], {
    sessionId, pid: process.pid, procStart: processStart, messagingSocketPath: firstSocket,
  });
  await writeFile(join(options.configDir, 'sessions', 'second.json'), JSON.stringify({
    sessionId, pid: process.pid, procStart: processStart, messagingSocketPath: secondSocket,
  }));

  const sessions = await listSessions(options);
  assert.equal(sessions[0]?.availability, 'unavailable');
  assert.match(sessions[0]?.reason ?? '', /multiple live/i);
  await assert.rejects(submitMessage(sessionId, 'hello', options), /multiple live/i);
});

test('fails the listing when Claude returns an agent without a conversation ID', async () => {
  const options = await fixture([{ name: 'Malformed agent' }]);
  await assert.rejects(listSessions(options), /without a sessionId/i);
});
