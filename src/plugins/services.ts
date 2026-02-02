// Plugin to register services
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import config from 'config';
import { AppConfig } from '../types.js';
import { IpService } from '../services/IpService.js';
import { UpdaterService } from '../services/UpdaterService.js';

// Declaration merging
declare module 'fastify' {
  export interface FastifyInstance {
    config: AppConfig;
    updaterService: UpdaterService;
  }
}

const servicesPlugin: FastifyPluginAsync = async (fastify, _opts) => {
  const appConfig = config.util.toObject() as AppConfig;
  fastify.decorate('config', appConfig);

  const ipService = new IpService(appConfig.ipProviders, fastify.log);
  const updaterService = new UpdaterService(appConfig, ipService, fastify.log);

  fastify.decorate('updaterService', updaterService);
};

export default fp(servicesPlugin);
