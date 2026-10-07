/** Exercises the public MCP HTTP endpoint with real storage and job scheduling. */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createDispatchApp } from './mcp.js';
import { DispatchJobs } from './jobs.js';
import { FileStorage } from './storage.js';

interface RpcBody {
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
}

test('MCP tools create, run, inspect, and delete a one-time job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-mcp-'));
  const storage = new FileStorage(join(directory, 'config'), join(directory, 'data'));
  const submitted: string[] = [];
  const jobs = new DispatchJobs(storage, async (_sessionId, text) => { submitted.push(text); });
  await jobs.start();
  let listingFails = false;
  const { app, close } = createDispatchApp(jobs, async () => {
    if (listingFails) throw new Error('Claude listing failed');
    return [{
      session_id: 'session-1', name: 'Test', cwd: '/tmp', status: 'idle', availability: 'available',
    }];
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  async function call(method: string, params?: object): Promise<{ status: number; body: RpcBody }> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await response.text();
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const line = body.split('\n').find(part => part.startsWith('data: '));
      return { status: response.status, body: JSON.parse(line!.slice(6)) as RpcBody };
    }
    return { status: response.status, body: JSON.parse(body) as RpcBody };
  }

  try {
    const listed = await call('tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result?.tools?.map(tool => tool.name).sort(), [
      'create_job', 'delete_job', 'list_jobs', 'list_runs', 'list_sessions', 'run_job', 'update_job',
    ]);

    const sessions = await call('tools/call', { name: 'list_sessions', arguments: {} });
    assert.equal(JSON.parse(sessions.body.result!.content![0]!.text)[0].session_id, 'session-1');
    listingFails = true;
    const unavailableListing = await call('tools/call', { name: 'list_sessions', arguments: {} });
    assert.equal(unavailableListing.body.result?.isError, true);
    assert.match(unavailableListing.body.result!.content![0]!.text, /Claude listing failed/);
    listingFails = false;

    const created = await call('tools/call', { name: 'create_job', arguments: {
      trigger: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
      action: { session_id: 'session-1', text: 'wake up' },
    } });
    assert.equal(created.body.result?.isError, undefined);
    const job = JSON.parse(created.body.result!.content![0]!.text);
    assert.equal(job.action.text, 'wake up');

    const updated = await call('tools/call', { name: 'update_job', arguments: {
      id: job.id, name: 'Reminder', action: { session_id: 'session-1', text: 'updated message' },
    } });
    assert.equal(updated.body.result?.isError, undefined);
    assert.equal(JSON.parse(updated.body.result!.content![0]!.text).name, 'Reminder');

    const invalid = await call('tools/call', { name: 'create_job', arguments: {
      trigger: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
      action: { session_id: 'session-1', text: '' },
    } });
    assert.equal(invalid.body.result?.isError, true);

    const run = await call('tools/call', { name: 'run_job', arguments: { id: job.id } });
    assert.equal(JSON.parse(run.body.result!.content![0]!.text).result, 'submitted');
    assert.deepEqual(submitted, ['updated message']);

    const jobsResult = await call('tools/call', { name: 'list_jobs', arguments: {} });
    assert.deepEqual(JSON.parse(jobsResult.body.result!.content![0]!.text), []);

    const runs = await call('tools/call', { name: 'list_runs', arguments: { job_id: job.id } });
    assert.equal(JSON.parse(runs.body.result!.content![0]!.text).length, 1);

    const missing = await call('tools/call', { name: 'delete_job', arguments: { id: job.id } });
    assert.equal(missing.body.result?.isError, true);
  } finally {
    jobs.stop();
    await close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a configured token requires a matching bearer header', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-auth-'));
  const jobs = new DispatchJobs(new FileStorage(join(directory, 'config'), join(directory, 'data')), async () => {});
  await jobs.start();
  assert.throws(() => createDispatchApp(jobs, async () => [], ''), /token|empty/i);
  const { app, close } = createDispatchApp(jobs, async () => [], 'secret');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const request = (authorization?: string) => fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

  try {
    assert.equal((await request()).status, 401);
    assert.equal((await request('Bearer wrong')).status, 401);
    assert.equal((await request('Bearer secret')).status, 200);
  } finally {
    jobs.stop();
    await close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
