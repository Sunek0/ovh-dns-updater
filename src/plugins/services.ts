// Plugin to register services
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { AppConfig } from '../types.js';
import { IpService } from '../services/IpService.js';
import { UpdaterService } from '../services/UpdaterService.js';

interface ServicesPluginOptions {
  appConfig: AppConfig;
}

// Declaration merging
declare module 'fastify' {
  export interface FastifyInstance {
    config: AppConfig;
    updaterService: UpdaterService;
  }
}

const servicesPlugin: FastifyPluginAsync<ServicesPluginOptions> = async (fastify, opts) => {
  const appConfig = opts.appConfig;
  fastify.decorate('config', appConfig);

  const ipService = new IpService(appConfig.ipProviders, fastify.log);
  const updaterService = new UpdaterService(appConfig, ipService, fastify.log);

  fastify.decorate('updaterService', updaterService);
};

export default fp(servicesPlugin);
