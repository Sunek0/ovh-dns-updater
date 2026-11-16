import Fastify, {
  FastifyInstance,
  FastifyServerOptions,
  LogController,
} from 'fastify';
import type { AppConfig } from './types.js';
import servicesPlugin from './plugins/services.js';
import schedulerPlugin from './plugins/scheduler.js';
import apiRoutes from './routes/api.js';
import statusRoutes from './routes/status.js';
import uiRoutes from './routes/ui.js';

export interface BuildServerOptions {
  /** Override the Fastify logger, mainly for tests. */
  logger?: FastifyServerOptions['logger'];
}

export async function buildServer(
  config: AppConfig,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const prettyLogs =
    process.env.NODE_ENV !== 'production' || process.env.LOG_PRETTY === 'true';

  const defaultLogger: FastifyServerOptions['logger'] = {
    level: config.server.logLevel,
    ...(prettyLogs
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  };

  const fastify = Fastify({
    logger: options.logger ?? defaultLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.server.trustProxy,
  });

  if (config.security.allowLegacyGlobalAccountTokens) {
    fastify.log.warn(
      'security.allowLegacyGlobalAccountTokens is enabled: account tokens can trigger global syncs',
    );
  }

  await fastify.register(servicesPlugin, { appConfig: config });

  if (config.scheduler.enabled) {
    await fastify.register(schedulerPlugin);
  }

  if (config.ondemand.enabled) {
    await fastify.register(apiRoutes, { prefix: '/api' });
  }

  if (config.ui.enabled) {
    await fastify.register(statusRoutes, { prefix: '/api' });
    await fastify.register(uiRoutes);
  }

  fastify.get('/health', async () => ({ status: 'ok' }));

  return fastify;
}
