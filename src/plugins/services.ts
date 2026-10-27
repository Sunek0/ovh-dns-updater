// Plugin to register services
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { AppConfig } from '../types.js';
import { IpService } from '../services/IpService.js';
import { StateStore } from '../services/StateStore.js';
import { UpdaterService } from '../services/UpdaterService.js';

interface ServicesPluginOptions {
  appConfig: AppConfig;
}

// Declaration merging
declare module 'fastify' {
  export interface FastifyInstance {
    config: AppConfig;
    updaterService: UpdaterService;
    stateStore: StateStore;
  }
}

const servicesPlugin: FastifyPluginAsync<ServicesPluginOptions> = async (fastify, opts) => {
  const appConfig = opts.appConfig;
  fastify.decorate('config', appConfig);

  const stateStore = new StateStore({
    historySize: appConfig.ui.historySize,
    refreshSeconds: appConfig.ui.refreshSeconds,
    schedulerEnabled: appConfig.scheduler.enabled,
    schedulerIntervalSeconds: appConfig.scheduler.interval,
    ondemandEnabled: appConfig.ondemand.enabled,
    // Only copy non-sensitive account information into the observability store.
    accounts: appConfig.accounts
      .filter(account => account.enabled !== false)
      .map(account => ({ id: account.id, domains: account.domains })),
  });
  fastify.decorate('stateStore', stateStore);

  const ipService = new IpService(
    appConfig.ipProviders,
    fastify.log,
    30000,
    report => stateStore.recordIpDetection(report),
  );
  const updaterService = new UpdaterService(
    appConfig,
    ipService,
    fastify.log,
    stateStore,
  );

  fastify.decorate('updaterService', updaterService);
};

export default fp(servicesPlugin);
