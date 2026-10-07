/**
 * Discovers Claude Code sessions and writes user messages to their local inbox sockets.
 * Claude's session registry and inbox frame are private interfaces, so all assumptions
 * about them live here and are checked again for every submission.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionSummary } from './types.js';

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 2_000;
const defaultListingTimeoutMs = 10_000;

/** Local paths and command settings, overridable for integration tests. */
export interface ClaudeAdapterOptions {
  configDir?: string;
  claudeBinary?: string;
  timeoutMs?: number;
}

interface SessionRecord {
  sessionId: string;
  pid: number;
  procStart: string;
  messagingSocketPath: string;
}

/** Lists Claude agents with live inbox availability, without retaining socket paths. */
export async function listSessions(options: ClaudeAdapterOptions = {}): Promise<SessionSummary[]> {
  const [agents, records] = await Promise.all([listClaudeAgents(options), readSessionRecords(options)]);
  return Promise.all(agents.map(async agent => {
    const sessionId = agent.sessionId;
    const { reason } = await findLiveRecord(records.get(sessionId), options.timeoutMs);
    return {
      session_id: sessionId,
      name: optionalString(agent.name),
      cwd: optionalString(agent.cwd),
      status: optionalString(agent.status) ?? optionalString(agent.state),
      availability: reason ? 'unavailable' : 'available',
      ...(reason ? { reason } : {}),
    } satisfies SessionSummary;
  }));
}

/** Submits one JSONL user frame to the current live record for a conversation ID. */
export async function submitMessage(
  sessionId: string,
  text: string,
  options: ClaudeAdapterOptions = {},
): Promise<void> {
  const records = await readSessionRecords(options);
  const { record, reason } = await findLiveRecord(records.get(sessionId), options.timeoutMs);
  if (reason) throw new Error(reason);

  const frame = JSON.stringify({
    msgV: 1,
    msg_id: randomUUID(),
    type: 'user',
    message: { role: 'user', content: text },
    priority: 'next',
    session_id: sessionId,
  }) + '\n';
  try {
    await writeSocket(record!.messagingSocketPath, frame, options.timeoutMs);
  } catch (error) {
    throw new Error(`Inbox socket submission failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function listClaudeAgents(options: ClaudeAdapterOptions): Promise<Array<Record<string, unknown> & { sessionId: string }>> {
  let output: string;
  try {
    const result = await execFileAsync(options.claudeBinary ?? 'claude', ['agents', '--json'], {
      timeout: options.timeoutMs ?? defaultListingTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    output = result.stdout;
  } catch (error) {
    throw new Error(`claude agents --json failed: ${errorMessage(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error('claude agents --json returned invalid JSON', { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array');
  if (!parsed.every((agent): agent is Record<string, unknown> & { sessionId: string } =>
    isRecord(agent) && typeof agent.sessionId === 'string' && agent.sessionId.length > 0)) {
    throw new Error('claude agents --json returned an agent without a sessionId');
  }
  return parsed;
}

async function readSessionRecords(options: ClaudeAdapterOptions): Promise<Map<string, SessionRecord[]>> {
  const directory = join(options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw new Error(`Could not read Claude session records: ${errorMessage(error)}`, { cause: error });
  }

  const records = new Map<string, SessionRecord[]>();
  await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (isSessionRecord(parsed)) {
        const candidates = records.get(parsed.sessionId) ?? [];
        candidates.push(parsed);
        records.set(parsed.sessionId, candidates);
      }
    } catch (error) {
      // Claude can replace or remove a record during a directory scan. Treat a
      // malformed or disappearing record as unavailable, rather than trusting it.
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error;
    }
  }));
  return records;
}

async function findLiveRecord(
  candidates: SessionRecord[] | undefined,
  timeoutMs?: number,
): Promise<{ record?: SessionRecord; reason: string | null }> {
  if (!candidates?.length) return { reason: 'No matching Claude session record' };

  let liveRecord: SessionRecord | undefined;
  let unavailableReason: string | null = null;
  for (const candidate of candidates) {
    const reason = await validateRecord(candidate) ?? await checkSocket(candidate.messagingSocketPath, timeoutMs);
    if (reason) {
      unavailableReason ??= reason;
      continue;
    }
    if (liveRecord && (liveRecord.pid !== candidate.pid || liveRecord.messagingSocketPath !== candidate.messagingSocketPath)) {
      return { reason: 'Multiple live Claude session records match this conversation ID' };
    }
    liveRecord = candidate;
  }
  return liveRecord ? { record: liveRecord, reason: null } : { reason: unavailableReason };
}

async function validateRecord(record: SessionRecord | undefined): Promise<string | null> {
  if (!record) return 'No matching Claude session record';
  if (process.platform === 'darwin') return validateMacProcess(record);
  if (process.platform !== 'linux') return 'Process identity checks are unavailable on this platform';

  try {
    const stat = await readFile(`/proc/${record.pid}/stat`, 'utf8');
    // The command field is parenthesized and may contain spaces. Field 22 is
    // starttime; after the closing parenthesis, it is element 19 (zero-based).
    const processStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (processStart === record.procStart) return null;
    return 'Claude session process no longer matches its record';
  } catch (error) {
    if (isMissingFile(error)) return 'Claude session process is no longer running';
    throw new Error(`Could not check Claude session process: ${errorMessage(error)}`, { cause: error });
  }
}

async function validateMacProcess(record: SessionRecord): Promise<string | null> {
  // macOS has no /proc starttime. Compare the exact `ps` start string only;
  // if Claude stores another representation, fail closed until it is verified.
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(record.pid), '-o', 'lstart='], {
      timeout: defaultTimeoutMs,
    });
    return stdout.trim() === record.procStart
      ? null
      : 'Claude session process no longer matches its record';
  } catch (error) {
    if (isRecord(error) && error.code === 1) return 'Claude session process is no longer running';
    throw new Error(`Could not check Claude session process: ${errorMessage(error)}`, { cause: error });
  }
}

async function checkSocket(socketPath: string, timeoutMs?: number): Promise<string | null> {
  try {
    await writeSocket(socketPath, undefined, timeoutMs);
    return null;
  } catch (error) {
    return `Inbox socket is unavailable: ${errorMessage(error)}`;
  }
}

function writeSocket(socketPath: string, frame?: string, timeoutMs = defaultTimeoutMs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      if (frame === undefined) socket.end();
      else socket.end(frame);
    });
    socket.once('finish', () => {
      settled = true;
      socket.unref();
      resolve();
    });
    socket.on('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.once('timeout', () => socket.destroy(new Error(`socket timed out after ${timeoutMs} ms`)));
    socket.once('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('socket closed before the write completed'));
      }
    });
  });
}

function isSessionRecord(value: unknown): value is SessionRecord {
  return isRecord(value)
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
    && typeof value.procStart === 'string' && value.procStart.length > 0
    && typeof value.messagingSocketPath === 'string' && value.messagingSocketPath.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
