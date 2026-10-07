/** Exposes Dispatch's job operations as local Streamable HTTP MCP tools. */

import { timingSafeEqual } from 'node:crypto';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import * as z from 'zod/v4';
import type { DispatchJobs } from './jobs.js';
import type { SessionSummary } from './types.js';

const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string() }),
  z.object({ kind: z.literal('cron'), cron: z.string() }),
]);
const actionSchema = z.object({ session_id: z.string().min(1), text: z.string().min(1) });
const idSchema = z.object({ id: z.string().min(1) });

/** Builds a local MCP app around the single process that owns Dispatch jobs. */
export function createDispatchApp(
  jobs: DispatchJobs,
  listSessions: () => Promise<SessionSummary[]>,
  token?: string,
): { app: Express; close: () => Promise<void> } {
  if (token === '') throw new Error('Dispatch token must not be empty');

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'dispatch', version: '0.1.0' });

    server.registerTool('list_sessions', {
      description: 'List local Claude Code sessions and whether their inboxes can be reached.',
      inputSchema: z.object({}),
    }, async () => respond(listSessions()));

    server.registerTool('create_job', {
      description: 'Schedule a message to one Claude Code session.',
      inputSchema: z.object({ name: z.string().optional(), trigger: triggerSchema, action: actionSchema }),
    }, async input => respond(jobs.createJob(input)));

    server.registerTool('update_job', {
      description: 'Change an existing scheduled message.',
      inputSchema: z.object({
        id: z.string().min(1), name: z.string().nullable().optional(),
        trigger: triggerSchema.optional(), action: actionSchema.optional(),
      }),
    }, async input => respond(jobs.updateJob(input)));

    server.registerTool('delete_job', {
      description: 'Delete a scheduled message and keep its past runs.',
      inputSchema: idSchema,
    }, async ({ id }) => respond(jobs.deleteJob(id)));

    server.registerTool('list_jobs', {
      description: 'List scheduled messages, their next run times, and last results.',
      inputSchema: z.object({}),
    }, async () => respond(jobs.listJobs()));

    server.registerTool('run_job', {
      description: 'Run a job now. A one-time job is consumed by this run.',
      inputSchema: idSchema,
    }, async ({ id }) => respond(jobs.runJob(id)));

    server.registerTool('list_runs', {
      description: 'List recent run outcomes, optionally filtered to one job.',
      inputSchema: z.object({ job_id: z.string().optional(), limit: z.number().int().positive().optional() }),
    }, async ({ job_id, limit }) => respond(jobs.listRuns(job_id, limit)));
    return server;
  });

  const app = createMcpExpressApp();
  const nodeHandler = toNodeHandler(handler);
  app.all('/mcp', (request, response, next) => {
    if (token !== undefined && !hasToken(request.headers.authorization, token)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    void nodeHandler(request, response, request.body).catch(next);
  });
  return { app, close: () => handler.close() };
}

async function respond(value: Promise<unknown>): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await value) }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function hasToken(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
