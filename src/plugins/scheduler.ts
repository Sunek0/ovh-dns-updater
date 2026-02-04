import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

// Simple background scheduler
const schedulerPlugin: FastifyPluginAsync = async (fastify, _opts) => {
  const INTERVAL = (fastify.config.scheduler?.interval || 600) * 1000;
  let intervalId: NodeJS.Timeout | undefined;

  // Cleanup must be registered during plugin registration, not deferred
  fastify.addHook('onClose', async () => {
    if (intervalId) {
      fastify.log.info('Stopping background scheduler');
      clearInterval(intervalId);
    }
  });

  // Start the scheduler after the server is fully booted
  fastify.addHook('onReady', async () => {
    // Small delay to ensure the event loop is free and server is listening
    setTimeout(() => {
      fastify.log.info(`Starting background scheduler (${INTERVAL}s)`);
      
      // Initial run immediately
      fastify.updaterService.syncAll().catch(err => {
        fastify.log.error({ err }, 'Initial scheduled sync failed');
      });

      intervalId = setInterval(() => {
        fastify.log.info('Running scheduled sync');
        fastify.updaterService.syncAll().catch(err => {
          fastify.log.error({ err }, 'Scheduled sync failed');
        });
      }, INTERVAL);
    }, 100);
  });
};

export default fp(schedulerPlugin);
