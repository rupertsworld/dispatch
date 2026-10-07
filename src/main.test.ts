/** Exercises the actual Dispatch process over HTTP without installing MCP in Claude Code. */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the server starts without a token and retains jobs across process restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-process-'));
  const fakeClaude = join(root, 'claude');
  await writeFile(fakeClaude, '#!/bin/sh\nprintf "[]\\n"\n');
  await chmod(fakeClaude, 0o755);
  const port = await unusedPort();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ''}`,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    DISPATCH_CONFIG_DIR: join(root, 'config'),
    DISPATCH_DATA_DIR: join(root, 'data'),
    DISPATCH_PORT: String(port),
  };
  delete environment.DISPATCH_TOKEN;
  delete environment.DISPATCH_BROWSER_ORIGIN;
  let child: ChildProcess | undefined;

  try {
    child = await startDispatch(environment);
    const tools = await call(port, 'tools/list');
    assert.equal(tools.status, 200);
    assert.equal(tools.body.result.tools.length, 7);

    const sessions = await call(port, 'tools/call', { name: 'list_sessions', arguments: {} });
    assert.deepEqual(JSON.parse(sessions.body.result.content[0]!.text), []);

    const immediate = await fetch(`http://127.0.0.1:${port}/sessions/missing-session/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello Claude' }),
    });
    assert.equal(immediate.status, 503);
    assert.match((await immediate.json() as { error: string }).error, /matching Claude session record/);

    const created = await call(port, 'tools/call', { name: 'create_job', arguments: {
      trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
      action: { session_id: 'future-session', text: 'Remember this' },
    } });
    const job = JSON.parse(created.body.result.content[0]!.text);
    assert.ok(job.id);

    await stopDispatch(child);
    child = await startDispatch(environment);
    const persisted = await call(port, 'tools/call', { name: 'list_jobs', arguments: {} });
    assert.equal(JSON.parse(persisted.body.result.content[0]!.text)[0].job.id, job.id);
  } finally {
    if (child) await stopDispatch(child);
    await rm(root, { recursive: true, force: true });
  }
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function startDispatch(environment: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: projectDir,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Dispatch did not start: ${stderr}`));
    }, 10_000);
    const onExit = () => {
      clearTimeout(timer);
      reject(new Error(`Dispatch exited before listening: ${stderr}`));
    };
    child.once('exit', onExit);
    child.stderr!.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.includes('Dispatch listening on')) {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(child);
      }
    });
  });
}

async function stopDispatch(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function call(port: number, method: string, params?: object): Promise<{
  status: number;
  body: { result: { tools: unknown[]; content: Array<{ text: string }> } };
}> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    : JSON.parse(text);
  return { status: response.status, body: payload };
}
