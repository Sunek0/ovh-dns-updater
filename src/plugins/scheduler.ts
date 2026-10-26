import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

// Simple background scheduler
const schedulerPlugin: FastifyPluginAsync = async (fastify, _opts) => {
  const configuredInterval = fastify.config.scheduler?.interval ?? 600;
  const INTERVAL = configuredInterval * 1000;

  if (!Number.isFinite(INTERVAL) || INTERVAL <= 0) {
    throw new Error('scheduler.interval must be a positive number of seconds');
  }

  let intervalId: NodeJS.Timeout | undefined;
  let startupTimeoutId: NodeJS.Timeout | undefined;
  let syncInProgress = false;

  const runScheduledSync = async (label: string) => {
    if (syncInProgress) {
      fastify.log.warn('Previous scheduled sync is still running, skipping this run');
      return;
    }

    syncInProgress = true;
    try {
      await fastify.updaterService.syncAll();
    } catch (err) {
      fastify.log.error({ err }, label);
    } finally {
      syncInProgress = false;
    }
  };

  // Cleanup must be registered during plugin registration, not deferred
  fastify.addHook('onClose', async () => {
    if (startupTimeoutId) {
      clearTimeout(startupTimeoutId);
    }
    if (intervalId) {
      fastify.log.info('Stopping background scheduler');
      clearInterval(intervalId);
    }
  });

  // Start the scheduler after the server is fully booted
  fastify.addHook('onReady', async () => {
    // Small delay to ensure the event loop is free and server is listening
    startupTimeoutId = setTimeout(() => {
      fastify.log.info(`Starting background scheduler (${INTERVAL / 1000}s)`);
      
      // Initial run immediately
      void runScheduledSync('Initial scheduled sync failed');

      intervalId = setInterval(() => {
        fastify.log.info('Running scheduled sync');
        void runScheduledSync('Scheduled sync failed');
      }, INTERVAL);
    }, 100);
  });
};

export default fp(schedulerPlugin);
