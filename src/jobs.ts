/** Owns Dispatch's live job schedule and records each attempted delivery. */

import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { FileStorage } from './storage.js';
import type { Action, Job, JobSummary, Run, Trigger } from './types.js';

type Submit = (sessionId: string, text: string) => Promise<void>;
type JobUpdate = { id: string; name?: string | null; trigger?: Trigger; action?: Action };
const missedRunReason = 'Missed scheduled time while Dispatch was stopped';

/** Coordinates durable jobs with Croner and one delivery at a time per job. */
export class DispatchJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly schedules = new Map<string, Cron>();
  private readonly inFlight = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly storage: FileStorage, private readonly submit: Submit) {}

  /** Loads saved jobs, records expired one-time jobs, and starts future schedules. */
  async start(): Promise<void> {
    await this.withWriteLock(async () => {
      if (this.started) return;
      const saved = await this.storage.loadJobs();
      const now = Date.now();
      const active: Job[] = [];
      const ids = new Set<string>();
      for (const job of saved) {
        validateJob(job, true);
        if (ids.has(job.id)) throw new Error(`Duplicate job ID: ${job.id}`);
        ids.add(job.id);
      }
      for (const job of saved) {
        if (job.trigger.kind === 'once' && Date.parse(job.trigger.at) <= now) {
          // A prior start may have logged the miss but failed before removing
          // the job from storage. Do not log the same missed firing twice.
          const lastRun = (await this.storage.listRuns(job.id, 1))[0];
          if (lastRun?.reason !== missedRunReason) {
            await this.storage.appendRun({
              at: new Date().toISOString(),
              job_id: job.id,
              session_id: job.action.session_id,
              result: 'failed',
              reason: missedRunReason,
            });
          }
        } else {
          active.push(job);
        }
      }
      if (active.length !== saved.length) await this.storage.saveJobs(active);
      this.jobs.clear();
      for (const job of active) this.jobs.set(job.id, job);
      this.started = true;
      for (const job of active) this.schedule(job);
    });
  }

  /** Stops future scheduled sends; a delivery already in progress may finish. */
  stop(): void {
    this.started = false;
    for (const schedule of this.schedules.values()) schedule.stop();
    this.schedules.clear();
  }

  /** Validates and stores a new job with a generated ID. */
  async createJob(input: Omit<Job, 'id'>): Promise<Job> {
    validateJob({ ...input, id: 'new' }, false);
    return this.withWriteLock(async () => {
      this.requireStarted();
      const job: Job = { id: randomUUID(), ...input };
      await this.storage.saveJobs([...this.jobs.values(), job]);
      this.jobs.set(job.id, job);
      this.schedule(job);
      return job;
    });
  }

  /** Changes supplied fields and replaces the job's schedule. */
  async updateJob(input: JobUpdate): Promise<Job> {
    if (input.name === undefined && input.trigger === undefined && input.action === undefined) {
      throw new Error('At least one job field must change');
    }
    return this.withWriteLock(async () => {
      this.requireStarted();
      const old = this.requireJob(input.id);
      if (old.trigger.kind === 'once' && this.inFlight.has(old.id)) {
        throw new Error('Cannot update a one-time job while it is running');
      }
      const job: Job = {
        id: old.id,
        ...(input.name === null ? {} : { name: input.name ?? old.name }),
        trigger: input.trigger ?? old.trigger,
        action: input.action ?? old.action,
      };
      validateJob(job, input.trigger === undefined);
      const updated = [...this.jobs.values()].map((saved) => saved.id === job.id ? job : saved);
      await this.storage.saveJobs(updated);
      this.cancelSchedule(job.id);
      this.jobs.set(job.id, job);
      this.schedule(job);
      return job;
    });
  }

  /** Removes a job without deleting its run history. */
  async deleteJob(id: string): Promise<{ deleted: true }> {
    return this.withWriteLock(async () => {
      this.requireStarted();
      this.requireJob(id);
      await this.storage.saveJobs([...this.jobs.values()].filter((job) => job.id !== id));
      this.cancelSchedule(id);
      this.jobs.delete(id);
      return { deleted: true };
    });
  }

  /** Lists active jobs with their next firing and most recent recorded run. */
  async listJobs(): Promise<JobSummary[]> {
    await this.writes;
    this.requireStarted();
    return Promise.all([...this.jobs.values()].map(async (job) => ({
      job,
      next_run_at: this.nextRun(job),
      last_run: (await this.storage.listRuns(job.id, 1))[0] ?? null,
    })));
  }

  /** Starts a delivery now; for a one-time job, this consumes its only firing. */
  async runJob(id: string): Promise<Run> {
    this.requireStarted();
    const job = this.requireJob(id);
    if (this.inFlight.has(id)) {
      const skipped: Run = {
        at: new Date().toISOString(),
        job_id: id,
        session_id: job.action.session_id,
        result: 'skipped',
        reason: 'Previous delivery is still in progress',
      };
      await this.withWriteLock(() => this.storage.appendRun(skipped));
      return skipped;
    }

    this.inFlight.add(id);
    if (job.trigger.kind === 'once') this.cancelSchedule(id);
    let run: Run;
    try {
      try {
        await this.submit(job.action.session_id, job.action.text);
        run = { at: new Date().toISOString(), job_id: id, session_id: job.action.session_id, result: 'submitted' };
      } catch (error) {
        run = {
          at: new Date().toISOString(), job_id: id, session_id: job.action.session_id,
          result: 'failed', reason: error instanceof Error ? error.message : String(error),
        };
      }
      await this.withWriteLock(async () => {
        await this.storage.appendRun(run);
        if (job.trigger.kind === 'once' && this.jobs.has(id)) {
          await this.storage.saveJobs([...this.jobs.values()].filter((saved) => saved.id !== id));
          this.jobs.delete(id);
        }
      });
      return run;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Returns durable runs, newest first, with optional filtering and limit. */
  async listRuns(jobId?: string, limit?: number): Promise<Run[]> {
    await this.writes;
    return this.storage.listRuns(jobId, limit);
  }

  private schedule(job: Job): void {
    const expression = job.trigger.kind === 'once' ? new Date(job.trigger.at) : job.trigger.cron;
    const fire = () => {
      if (this.started) void this.runJob(job.id).catch(reportScheduleError);
    };
    if (expression instanceof Date && expression.getTime() <= Date.now()) {
      // Saving a near-term job may cross its due time before Croner gets the timer.
      queueMicrotask(fire);
      return;
    }
    const schedule = new Cron(expression, fire);
    this.schedules.set(job.id, schedule);
  }

  private cancelSchedule(id: string): void {
    this.schedules.get(id)?.stop();
    this.schedules.delete(id);
  }

  private nextRun(job: Job): string | null {
    if (job.trigger.kind === 'once') {
      return this.inFlight.has(job.id) || Date.parse(job.trigger.at) <= Date.now()
        ? null : new Date(job.trigger.at).toISOString();
    }
    const calculation = new Cron(job.trigger.cron, { paused: true });
    try {
      return calculation.nextRun()?.toISOString() ?? null;
    } finally {
      calculation.stop();
    }
  }

  private requireStarted(): void {
    if (!this.started) throw new Error('Dispatch jobs have not started');
  }

  private requireJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  private async withWriteLock<T>(write: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await write();
    } finally {
      release();
    }
  }
}

function validateJob(job: Job, allowPastOnce: boolean): void {
  if (typeof job.id !== 'string' || !job.id) throw new Error('Job ID is required');
  if (job.name !== undefined && typeof job.name !== 'string') throw new Error('Job name must be text');
  if (!job.action || typeof job.action.session_id !== 'string' || !job.action.session_id.trim()) {
    throw new Error('Session ID is required');
  }
  if (typeof job.action.text !== 'string' || !job.action.text.trim()) throw new Error('Message text is required');
  validateTrigger(job.trigger, allowPastOnce);
}

function validateTrigger(trigger: Trigger, allowPastOnce: boolean): void {
  if (!trigger || typeof trigger !== 'object') throw new Error('Invalid trigger');
  if (trigger.kind === 'once') {
    const timestamp = parseOffsetDate(trigger.at);
    if (!allowPastOnce && timestamp <= Date.now()) throw new Error('One-time job must be in the future');
    return;
  }
  if (trigger.kind !== 'cron' || typeof trigger.cron !== 'string' || trigger.cron.trim().split(/\s+/).length !== 5) {
    throw new Error('Cron trigger must have five fields');
  }
  try {
    const calculation = new Cron(trigger.cron, { paused: true });
    try {
      if (!calculation.nextRun()) throw new Error('Cron expression has no future run');
    } finally {
      calculation.stop();
    }
  } catch (error) {
    throw new Error(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOffsetDate(value: string): number {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('One-time trigger needs an ISO 8601 date and time with offset');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zone] = match;
  const [year, month, day, hour, minute, second, millisecond] = [
    Number(yearText), Number(monthText), Number(dayText), Number(hourText),
    Number(minuteText), Number(secondText ?? 0), Number((fractionText ?? '').padEnd(3, '0')),
  ];
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const roundTrip = new Date(local);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute || roundTrip.getUTCSeconds() !== second) {
    throw new Error('Invalid one-time trigger date or time');
  }
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHour = Number(zone!.slice(1, 3));
    const offsetMinute = Number(zone!.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) throw new Error('Invalid time-zone offset');
    offsetMinutes = (zone![0] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  }
  return local - offsetMinutes * 60_000;
}

function reportScheduleError(error: unknown): void {
  console.error('Dispatch scheduled run failed:', error);
}
