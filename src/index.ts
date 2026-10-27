import Fastify, { LogController } from 'fastify';
import { loadConfig } from './config.js';
import servicesPlugin from './plugins/services.js';
import schedulerPlugin from './plugins/scheduler.js';
import apiRoutes from './routes/api.js';

const start = async () => {
  let appConfig;
  try {
    appConfig = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const loggerLevel = appConfig.server.logLevel;

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
    await fastify.register(servicesPlugin, { appConfig });

    if (appConfig.scheduler.enabled) {
      await fastify.register(schedulerPlugin);
    }

    // Routes
    if (appConfig.ondemand.enabled) {
      await fastify.register(apiRoutes, { prefix: '/api' });
    }
    
    fastify.get('/health', async () => ({ status: 'ok' }));

    // Start
    const port = appConfig.server.port;
    const host = appConfig.server.host;
    
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
