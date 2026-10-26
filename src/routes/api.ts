import { FastifyPluginAsync } from 'fastify';
import { isValidIPv4 } from '../utils/ip.js';

const apiRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  
  // Auth hook
  fastify.addHook('onRequest', async (request, reply) => {
    // Endpoints requiring authentication
    const isProtected = 
      request.routeOptions.url?.startsWith('/api/sync') || 
      request.routeOptions.url?.startsWith('/api/accounts') ||
      request.routeOptions.url?.includes('/api/:token/');
    if (isProtected) {
      const expectedApiKey = fastify.config.security.apiKey;
      
      // 1. Try Authorization Header (Bearer)
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        if (token === expectedApiKey) return;
      }

      // 2. Try Path Parameter (Legacy support for Mikrotik)
      const pathToken = (request.params as any)?.token;
      if (pathToken) {
          // Check if it matches admin token OR any account token
          if (pathToken === expectedApiKey) return;
          const account = fastify.config.accounts.find(a => a.token === pathToken);
          if (account) return;
      }

      // 3. Unauthorized if neither matches
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/public-ip', async (req, _res) => {
    req.log.info('Received public-ip request');
    const ip = await fastify.updaterService.getPublicIp();
    return { ip };
  });

  fastify.post('/sync', async (req, _res) => {
    req.log.info('Received sync all request');
    const result = await fastify.updaterService.syncAll(true);
    return result;
  });

  fastify.post<{ Params: { id: string } }>('/accounts/:id/sync', async (req, reply) => {
    if (!fastify.updaterService.hasAccount(req.params.id)) {
      return reply.code(404).send({ error: 'Account not found' });
    }

    req.log.info(`Received sync request for account: ${req.params.id}`);
    const ip = await fastify.updaterService.syncAccount(req.params.id);
    return { message: 'Synced', ip };
  });

  fastify.get<{ Params: { token: string } }>('/:token/checkip', async (req, _res) => {
    req.log.info(`Received checkip request`);
    const result = await fastify.updaterService.syncAll(false);
    return result;
  });

  fastify.get<{ Params: { token: string; ip: string } }>('/:token/setip/:ip', async (req, reply) => {
    if (!isValidIPv4(req.params.ip)) {
      return reply.code(400).send({ error: 'Invalid IPv4 address' });
    }

    req.log.info(`Received setip request with IP: ${req.params.ip}`);
    const result = await fastify.updaterService.syncAll(true, req.params.ip);
    return result;
  });
};

export default apiRoutes;
