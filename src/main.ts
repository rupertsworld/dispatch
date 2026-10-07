#!/usr/bin/env node
/** Starts the persistent local MCP server and its job scheduler. */

import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listSessions, submitMessage } from './claude.js';
import { DispatchJobs } from './jobs.js';
import { createDispatchApp } from './mcp.js';
import { FileStorage } from './storage.js';

async function main(): Promise<void> {
  const token = process.env.DISPATCH_TOKEN;
  if (token === '') throw new Error('DISPATCH_TOKEN must not be empty');

  const configDir = process.env.DISPATCH_CONFIG_DIR
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'dispatch');
  const dataDir = process.env.DISPATCH_DATA_DIR
    ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'dispatch');
  const port = Number(process.env.DISPATCH_PORT ?? 17865);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DISPATCH_PORT must be an integer from 1 to 65535');
  }

  const jobs = new DispatchJobs(new FileStorage(configDir, dataDir), submitMessage);
  await jobs.start();
  const { app, close } = createDispatchApp(jobs, listSessions, token);
  const server = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    jobs.stop();
    await close();
    throw error;
  }
  console.error(`Dispatch listening on 127.0.0.1:${port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    jobs.stop();
    await close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  const onSignal = () => void shutdown().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
