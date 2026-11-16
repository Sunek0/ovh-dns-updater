import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './app.js';
import { formatConfigError, loadConfig } from './config.js';
import type { AppConfig } from './types.js';

const SHUTDOWN_TIMEOUT_MS = 8_000;

export async function start(): Promise<void> {
  let appConfig: AppConfig;
  try {
    appConfig = loadConfig();
  } catch (err) {
    console.error(formatConfigError(err));
    process.exit(1);
  }

  let app: FastifyInstance | undefined;

  try {
    const runningApp = await buildServer(appConfig);
    app = runningApp;

    const { port, host } = appConfig.server;
    runningApp.log.debug({ port, host }, 'Attempting to start server');

    const address = await runningApp.listen({ port, host });
    runningApp.log.info({ address }, 'Server listening');

    const shutdown = async (signal: NodeJS.Signals) => {
      runningApp.log.info({ signal }, 'Shutting down');

      const timeout = setTimeout(() => {
        runningApp.log.error(
          { timeoutMs: SHUTDOWN_TIMEOUT_MS },
          'Graceful shutdown timed out, forcing exit',
        );
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      timeout.unref();

      try {
        await runningApp.close();
        clearTimeout(timeout);
        process.exit(0);
      } catch (err) {
        clearTimeout(timeout);
        runningApp.log.error(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          'Graceful shutdown failed',
        );
        process.exit(1);
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app?.log.error({ error: message }, 'Startup failed');
    // The pretty-print transport runs in a worker and can lose its buffer when
    // process.exit() runs immediately. Keep the startup failure visible.
    console.error(message);
    process.exit(1);
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  start().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
