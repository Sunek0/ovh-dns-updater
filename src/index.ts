import Fastify, { LogController } from 'fastify';
import config from 'config';
import { AppConfig } from './types.js';
import servicesPlugin from './plugins/services.js';
import schedulerPlugin from './plugins/scheduler.js';
import apiRoutes from './routes/api.js';

const start = async () => {
  const appConfig = config.util.toObject() as AppConfig;
  const loggerLevel = appConfig.server?.logLevel || 'info';

  const fastify = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
      level: loggerLevel,
    },
    logController: new LogController({ disableRequestLogging: true }),
  });

  if (appConfig.security.allowLegacyGlobalAccountTokens) {
    fastify.log.warn(
      'security.allowLegacyGlobalAccountTokens is enabled: account tokens can trigger global syncs',
    );
  }

  try {
    // Custom Plugins
    await fastify.register(servicesPlugin);
    
    if (appConfig.scheduler?.enabled !== false) {
      await fastify.register(schedulerPlugin);
    }

    // Routes
    if (appConfig.ondemand?.enabled !== false) {
      await fastify.register(apiRoutes, { prefix: '/api' });
    }
    
    fastify.get('/health', async () => ({ status: 'ok' }));

    // Start
    const port = Number(appConfig.server.port) || 3000;
    const host = appConfig.server.host || '0.0.0.0';
    
    fastify.log.debug({ port, host }, 'Attempting to start server');
    const address = await fastify.listen({ port, host });

    fastify.log.info(`Server listening at ${address}`);

    const shutdown = async (signal: NodeJS.Signals) => {
      fastify.log.info({ signal }, 'Shutting down');
      try {
        await fastify.close();
        process.exit(0);
      } catch (err) {
        fastify.log.error(err);
        process.exit(1);
      }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
