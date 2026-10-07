/** Integration tests for job scheduling, delivery outcomes, and durable history. */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DispatchJobs } from './jobs.js';
import { FileStorage } from './storage.js';
import type { Job } from './types.js';

const fixtures: Array<{ root: string; jobs: DispatchJobs }> = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ root, jobs }) => {
    jobs.stop();
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture(submit: (sessionId: string, text: string) => Promise<void> = async () => {}): Promise<{
  jobs: DispatchJobs;
  storage: FileStorage;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-jobs-'));
  const storage = new FileStorage(join(root, 'config'), join(root, 'data'));
  const jobs = new DispatchJobs(storage, submit);
  fixtures.push({ root, jobs });
  await jobs.start();
  return { jobs, storage, root };
}

function futureDate(milliseconds = 3_600_000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function onceInput(at = futureDate()): Omit<Job, 'id'> {
  return {
    name: 'Reminder',
    trigger: { kind: 'once', at },
    action: { session_id: 'session-1', text: 'Check in' },
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('Expected scheduled outcome did not appear');
}

test('manual run submits once, records the result, and consumes a one-time job', async () => {
  const submitted: Array<[string, string]> = [];
  const { jobs, storage } = await fixture(async (sessionId, text) => { submitted.push([sessionId, text]); });
  const job = await jobs.createJob(onceInput());

  assert.ok(job.id);
  assert.deepEqual((await jobs.listJobs()).map((summary) => summary.next_run_at), [new Date(job.trigger.kind === 'once' ? job.trigger.at : '').toISOString()]);

  const run = await jobs.runJob(job.id);
  assert.equal(run.job_id, job.id);
  assert.equal(run.session_id, 'session-1');
  assert.equal(run.result, 'submitted');
  assert.deepEqual(submitted, [['session-1', 'Check in']]);
  assert.deepEqual(await jobs.listJobs(), []);
  assert.deepEqual(await storage.loadJobs(), []);
  assert.deepEqual(await jobs.listRuns(), [run]);
});

test('failed manual delivery still consumes a one-time job', async () => {
  const { jobs, storage } = await fixture(async () => { throw new Error('Session offline'); });
  const job = await jobs.createJob(onceInput());

  const run = await jobs.runJob(job.id);
  assert.equal(run.result, 'failed');
  assert.match(run.reason ?? '', /Session offline/);
  assert.deepEqual(await jobs.listJobs(), []);
  assert.deepEqual(await storage.loadJobs(), []);
  assert.deepEqual(await jobs.listRuns(job.id), [run]);
});

test('manual run cancels an imminent one-time firing', async () => {
  let submissions = 0;
  const { jobs } = await fixture(async () => { submissions++; });
  const job = await jobs.createJob(onceInput(futureDate(300)));

  assert.equal((await jobs.runJob(job.id)).result, 'submitted');
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(submissions, 1);
  assert.equal((await jobs.listRuns(job.id)).length, 1);
});

test('create and update reject invalid input and preserve unchanged fields', async () => {
  const { jobs } = await fixture();
  await assert.rejects(jobs.createJob(onceInput('2026-02-30T10:00:00Z')), /date|time|trigger/i);
  await assert.rejects(jobs.createJob(onceInput('2030-01-01T10:00:00')), /offset|time|trigger/i);
  await assert.rejects(jobs.createJob(onceInput('2020-01-01T00:00:00Z')), /future|past/i);
  await assert.rejects(jobs.createJob({ ...onceInput(), action: { session_id: '', text: 'Hi' } }), /session/i);
  await assert.rejects(jobs.createJob({ ...onceInput(), trigger: { kind: 'cron', cron: '* * * * * *' } }), /cron|five/i);
  await assert.rejects(jobs.createJob({ ...onceInput(), trigger: { kind: 'cron', cron: '90 * * * *' } }), /cron|invalid/i);

  const job = await jobs.createJob({ ...onceInput(), trigger: { kind: 'cron', cron: '*/5 * * * *' } });
  await assert.rejects(jobs.updateJob({ id: job.id }), /change|field/i);
  await assert.rejects(jobs.updateJob({ id: 'missing', name: 'Renamed' }), /job|unknown|found/i);
  const updated = await jobs.updateJob({ id: job.id, name: null, action: { session_id: 'session-2', text: 'New text' } });
  assert.equal(updated.name, undefined);
  assert.deepEqual(updated.trigger, job.trigger);
  assert.deepEqual(updated.action, { session_id: 'session-2', text: 'New text' });
  assert.ok(Date.parse((await jobs.listJobs())[0]!.next_run_at!) > Date.now());
});

test('startup records overdue one-time jobs as failed and resumes cron at a future time', async () => {
  const { jobs, storage, root } = await fixture();
  jobs.stop();
  const overdue: Job = { id: 'overdue', ...onceInput('2020-01-01T00:00:00Z') };
  const recurring: Job = { id: 'recurring', trigger: { kind: 'cron', cron: '* * * * *' }, action: overdue.action };
  await storage.saveJobs([overdue, recurring]);

  const restarted = new DispatchJobs(storage, async () => { assert.fail('Missed jobs must not be replayed'); });
  fixtures.push({ root, jobs: restarted });
  await restarted.start();

  const summaries = await restarted.listJobs();
  assert.deepEqual(summaries.map(({ job }) => job.id), ['recurring']);
  assert.ok(Date.parse(summaries[0]!.next_run_at!) > Date.now());
  const runs = await restarted.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.job_id, 'overdue');
  assert.equal(runs[0]!.result, 'failed');
  assert.match(runs[0]!.reason ?? '', /missed|down|overdue/i);
  assert.deepEqual((await storage.loadJobs()).map(({ id }) => id), ['recurring']);
});

test('retrying startup after a job snapshot failure does not duplicate a missed run', async () => {
  class FailingStorage extends FileStorage {
    failNextSave = false;

    override async saveJobs(jobs: Job[]): Promise<void> {
      if (this.failNextSave) {
        this.failNextSave = false;
        throw new Error('Snapshot failed');
      }
      await super.saveJobs(jobs);
    }
  }

  const root = await mkdtemp(join(tmpdir(), 'dispatch-jobs-'));
  const storage = new FailingStorage(join(root, 'config'), join(root, 'data'));
  await storage.saveJobs([{ id: 'overdue', ...onceInput('2020-01-01T00:00:00Z') }]);
  const jobs = new DispatchJobs(storage, async () => { assert.fail('Overdue job must not be submitted'); });
  fixtures.push({ root, jobs });

  storage.failNextSave = true;
  await assert.rejects(jobs.start(), /Snapshot failed/);
  assert.equal((await storage.listRuns('overdue')).length, 1);
  assert.equal((await storage.loadJobs()).length, 1);

  await jobs.start();
  assert.deepEqual(await jobs.listJobs(), []);
  assert.equal((await jobs.listRuns('overdue')).length, 1);
  assert.deepEqual(await storage.loadJobs(), []);
});

test('startup rejects duplicate job IDs before recording any missed runs', async () => {
  const { jobs, storage } = await fixture();
  jobs.stop();
  await storage.saveJobs([
    { id: 'duplicate', ...onceInput('2020-01-01T00:00:00Z') },
    { id: 'duplicate', ...onceInput('2020-01-01T00:00:00Z') },
  ]);

  await assert.rejects(jobs.start(), /Duplicate job ID/);
  assert.deepEqual(await storage.listRuns(), []);
});

test('scheduled delivery failure is logged and removes its one-time job', async () => {
  const { jobs } = await fixture(async () => { throw new Error('Session offline'); });
  const job = await jobs.createJob(onceInput(futureDate(350)));

  await eventually(async () => (await jobs.listRuns(job.id)).length === 1);
  const [run] = await jobs.listRuns(job.id);
  assert.equal(run!.result, 'failed');
  assert.match(run!.reason ?? '', /Session offline/);
  assert.deepEqual(await jobs.listJobs(), []);
});

test('overlapping runs skip the second delivery and recurring jobs remain scheduled', async () => {
  let started!: () => void;
  let finish!: () => void;
  const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
  const deliveryFinished = new Promise<void>((resolve) => { finish = resolve; });
  let submits = 0;
  const { jobs } = await fixture(async () => { submits++; started(); await deliveryFinished; });
  const job = await jobs.createJob({ trigger: { kind: 'cron', cron: '* * * * *' }, action: { session_id: 'session-1', text: 'Hi' } });

  const first = jobs.runJob(job.id);
  await deliveryStarted;
  const skipped = await jobs.runJob(job.id);
  assert.equal(skipped.result, 'skipped');
  assert.match(skipped.reason ?? '', /progress|running|overlap/i);
  assert.equal(submits, 1);
  finish();
  assert.equal((await first).result, 'submitted');
  assert.equal((await jobs.listJobs())[0]!.job.id, job.id);
  assert.equal((await jobs.listJobs())[0]!.last_run?.result, 'submitted');
  assert.deepEqual((await jobs.listRuns(job.id, 1)).map(({ result }) => result), ['submitted']);
  assert.deepEqual((await jobs.listRuns(job.id)).map(({ result }) => result), ['submitted', 'skipped']);

  assert.deepEqual(await jobs.deleteJob(job.id), { deleted: true });
  assert.deepEqual(await jobs.listJobs(), []);
  assert.equal((await jobs.listRuns(job.id)).length, 2);
  await assert.rejects(jobs.deleteJob(job.id), /job|unknown|found/i);
});
