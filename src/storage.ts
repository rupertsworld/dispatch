/** Private filesystem storage for jobs and their append-only run history. */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, Run } from './types.js';

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

/** Persists jobs as one atomic JSON snapshot and runs as newline-delimited JSON. */
export class FileStorage {
  private readonly jobsPath: string;
  private readonly runsPath: string;
  private pendingJobSave: Promise<void> = Promise.resolve();
  private pendingRunAppend: Promise<void> = Promise.resolve();

  constructor(private readonly configDir: string, private readonly dataDir: string) {
    this.jobsPath = join(configDir, 'jobs.json');
    this.runsPath = join(dataDir, 'runs.jsonl');
  }

  /** Returns saved jobs, or an empty list before the first save. */
  async loadJobs(): Promise<Job[]> {
    let content: string;
    try {
      content = await readFile(this.jobsPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`${this.jobsPath} contains invalid JSON`, { cause: error });
    }
    if (!Array.isArray(parsed) || !parsed.every(isJob)) {
      throw new Error(`${this.jobsPath} contains invalid job data`);
    }
    return parsed;
  }

  /** Replaces the jobs snapshot without exposing a partly written file. */
  async saveJobs(jobs: Job[]): Promise<void> {
    // Capture this call's state before another request can mutate the array.
    const content = `${JSON.stringify(jobs)}\n`;
    const save = this.pendingJobSave.then(() => this.saveJobsDirect(content));
    this.pendingJobSave = save.catch(() => {});
    return save;
  }

  private async saveJobsDirect(content: string): Promise<void> {
    await ensurePrivateDirectory(this.configDir);
    const temporaryPath = join(this.configDir, `.jobs-${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, 'wx', privateFileMode);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.jobsPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  /** Adds a run to the log without rewriting earlier history. */
  async appendRun(run: Run): Promise<void> {
    const append = this.pendingRunAppend.then(() => this.appendRunDirect(run));
    this.pendingRunAppend = append.catch(() => {});
    return append;
  }

  private async appendRunDirect(run: Run): Promise<void> {
    await ensurePrivateDirectory(this.dataDir);
    const file = await open(this.runsPath, 'a+', privateFileMode);
    try {
      await file.chmod(privateFileMode);
      // A crash may leave a partial last line. Remove it before the next append
      // so two JSON objects cannot be joined into one unreadable line.
      await removeUnterminatedTail(file);
      await file.writeFile(`${JSON.stringify(run)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  /** Returns the most recent runs first, optionally restricted to one job. */
  async listRuns(jobId?: string, limit = 100): Promise<Run[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Run limit must be a positive integer');
    }

    let content: string;
    try {
      content = await readFile(this.runsPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    // Only newline-terminated records are complete. An interrupted final write
    // can be ignored while earlier history stays available.
    const lastCompleteLineEnd = content.lastIndexOf('\n');
    if (lastCompleteLineEnd < 0) return [];
    const lines = content.slice(0, lastCompleteLineEnd).split('\n');
    const selected: Run[] = [];
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`${this.runsPath} has invalid JSON on line ${index + 1}`, { cause: error });
      }
      if (!isRun(parsed)) {
        throw new Error(`${this.runsPath} has invalid run data on line ${index + 1}`);
      }
      if (jobId === undefined || parsed.job_id === jobId) selected.push(parsed);
      if (selected.length === limit) return selected;
    }
    return selected;
  }
}

async function removeUnterminatedTail(file: FileHandle): Promise<void> {
  const { size } = await file.stat();
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - 4096);
    const buffer = Buffer.alloc(cursor - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) {
      const completeSize = start + newline + 1;
      if (completeSize < size) await file.truncate(completeSize);
      return;
    }
    cursor = start;
  }
  if (size > 0) await file.truncate(0);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: privateDirectoryMode });
  await chmod(path, privateDirectoryMode);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isJob(value: unknown): value is Job {
  if (!isRecord(value) || !isNonemptyString(value.id)) return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  if (!isRecord(value.action) || !isNonemptyString(value.action.session_id) || !isNonemptyString(value.action.text)) return false;
  if (!isRecord(value.trigger)) return false;
  if (value.trigger.kind === 'once') return isNonemptyString(value.trigger.at);
  if (value.trigger.kind === 'cron') return isNonemptyString(value.trigger.cron);
  return false;
}

function isRun(value: unknown): value is Run {
  return isRecord(value)
    && isNonemptyString(value.at)
    && isNonemptyString(value.job_id)
    && isNonemptyString(value.session_id)
    && (value.result === 'submitted' || value.result === 'failed' || value.result === 'skipped')
    && (value.reason === undefined || typeof value.reason === 'string');
}
