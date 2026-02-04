import { FastifyPluginAsync } from 'fastify';

const apiRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  
  // Auth hook
  fastify.addHook('onRequest', async (request, reply) => {
    // Endpoints requiring authentication
    const isProtected = 
      request.routeOptions.url?.startsWith('/api/sync') || 
      request.routeOptions.url?.startsWith('/api/accounts') ||
      request.routeOptions.url?.includes('/api/:token/');

    if (isProtected) {
      const expectedToken = fastify.config.security.adminToken;
      
      // 1. Try Authorization Header (Bearer)
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        if (token === expectedToken) return;
      }

      // 2. Try Path Parameter (Legacy support for Mikrotik)
      const pathToken = (request.params as any)?.token;
      if (pathToken) {
          // Check if it matches admin token OR any account token
          if (pathToken === expectedToken) return;
          const account = fastify.config.accounts.find(a => a.token === pathToken);
          if (account) return;
      }

      // 3. Unauthorized if neither matches
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/public-ip', async (_req, _res) => {
    const ip = await fastify.updaterService.getPublicIp();
    return { ip };
  });

  fastify.post('/sync', async (_req, _res) => {
    const result = await fastify.updaterService.syncAll(true);
    return result;
  });

  fastify.post<{ Params: { id: string } }>('/accounts/:id/sync', async (req, _res) => {
    const ip = await fastify.updaterService.syncAccount(req.params.id);
    return { message: 'Synced', ip };
  });

  fastify.get<{ Params: { token: string } }>('/:token/checkip', async (_req, _res) => {
    const result = await fastify.updaterService.syncAll(false);
    return result;
  });

  fastify.get<{ Params: { token: string; ip: string } }>('/:token/setip/:ip', async (req, _res) => {
    const result = await fastify.updaterService.syncAll(true, req.params.ip);
    return result;
  });
};

export default apiRoutes;
