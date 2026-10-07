/** Filesystem tests for private, durable job and run storage. */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { FileStorage } from './storage.js';
import type { Job, Run } from './types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storageFixture(): Promise<{ storage: FileStorage; configDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-storage-'));
  temporaryRoots.push(root);
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  return { storage: new FileStorage(configDir, dataDir), configDir, dataDir };
}

const job: Job = {
  id: 'job-1',
  trigger: { kind: 'once', at: '2026-10-06T09:00:00-07:00' },
  action: { session_id: 'session-1', text: 'Check in' },
};

const runs: Run[] = [
  { at: '2026-10-05T16:00:00.000Z', job_id: 'job-1', session_id: 'session-1', result: 'failed', reason: 'Session offline' },
  { at: '2026-10-05T17:00:00.000Z', job_id: 'job-2', session_id: 'session-2', result: 'submitted' },
  { at: '2026-10-05T18:00:00.000Z', job_id: 'job-1', session_id: 'session-1', result: 'submitted' },
];

test('saves and loads jobs in a private config directory', async () => {
  const { storage, configDir, dataDir } = await storageFixture();
  assert.deepEqual(await storage.loadJobs(), []);

  await storage.saveJobs([job]);
  assert.deepEqual(await new FileStorage(configDir, dataDir).loadJobs(), [job]);
  assert.deepEqual(JSON.parse(await readFile(join(configDir, 'jobs.json'), 'utf8')), [job]);
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(configDir, 'jobs.json'))).mode & 0o777, 0o600);

  await storage.saveJobs([]);
  assert.deepEqual(await storage.loadJobs(), []);
});

test('concurrent job saves retain the last requested snapshot', async () => {
  const { storage } = await storageFixture();
  const largeJob: Job = { ...job, action: { ...job.action, text: 'x'.repeat(2_000_000) } };

  await Promise.all([storage.saveJobs([largeJob]), storage.saveJobs([job])]);

  assert.deepEqual(await storage.loadJobs(), [job]);
});

test('appends runs and returns newest entries with filtering and a limit', async () => {
  const { storage, dataDir } = await storageFixture();
  assert.deepEqual(await storage.listRuns(), []);

  for (const run of runs) await storage.appendRun(run);

  assert.deepEqual(await storage.listRuns(), [...runs].reverse());
  assert.deepEqual(await storage.listRuns('job-1', 1), [runs[2]]);
  assert.deepEqual(await storage.listRuns(undefined, 2), [runs[2], runs[1]]);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dataDir, 'runs.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dataDir, 'runs.jsonl'), 'utf8')).trimEnd().split('\n').length, 3);
});

test('concurrent run appends keep request order', async () => {
  const { storage } = await storageFixture();

  await Promise.all(runs.map((run) => storage.appendRun(run)));

  assert.deepEqual(await storage.listRuns(), [...runs].reverse());
});

test('rejects corrupt stored jobs and runs with file context', async () => {
  const { storage, configDir, dataDir } = await storageFixture();
  await storage.saveJobs([job]);
  await writeFile(join(configDir, 'jobs.json'), '[{"id":"missing fields"}]');
  await assert.rejects(storage.loadJobs(), /jobs\.json.*invalid|invalid.*jobs\.json/i);

  await storage.appendRun(runs[0]!);
  await writeFile(join(dataDir, 'runs.jsonl'), `${JSON.stringify(runs[0])}\n{"result":"impossible"}\n`);
  await assert.rejects(storage.listRuns(), /runs\.jsonl.*line 2|line 2.*runs\.jsonl/i);
});

test('preserves complete runs after an interrupted append', async () => {
  const { storage, dataDir } = await storageFixture();
  await storage.appendRun(runs[0]!);
  await appendFile(join(dataDir, 'runs.jsonl'), '{"at":"unfinished');

  assert.deepEqual(await storage.listRuns(), [runs[0]]);

  await storage.appendRun(runs[1]!);
  assert.deepEqual(await storage.listRuns(), [runs[1], runs[0]]);
  assert.equal((await readFile(join(dataDir, 'runs.jsonl'), 'utf8')).split('\n').filter(Boolean).length, 2);
});
