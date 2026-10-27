import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerToken, safeEqual } from '../utils/auth.js';
import { isValidIPv4 } from '../utils/ip.js';
import { summarizeAccountResult } from '../utils/results.js';

export const RATE_LIMITS = {
  publicIp: { max: 30, timeWindow: '1 minute' },
  sync: { max: 10, timeWindow: '1 minute' },
  accountSync: { max: 10, timeWindow: '1 minute' },
  checkip: { max: 30, timeWindow: '1 minute' },
  setip: { max: 10, timeWindow: '1 minute' },
} as const;

const apiRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  await fastify.register(rateLimit, { global: false });

  // Auth hook
  fastify.addHook('onRequest', async (request, reply) => {
    // Endpoints requiring authentication
    const routeUrl = request.routeOptions.url ?? '';
    const isProtected =
      routeUrl.startsWith('/api/sync') ||
      routeUrl.startsWith('/api/accounts') ||
      routeUrl.includes('/api/:token/');

    if (!isProtected) return;

    const expectedApiKey = fastify.config.security.apiKey;
    const headerToken = extractBearerToken(request.headers.authorization);

    // 1. Bearer token: only the master API key is accepted in a header.
    if (safeEqual(headerToken, expectedApiKey)) {
      request.auth = { kind: 'master' };
      return;
    }

    // 2. Path token (legacy support for Mikrotik).
    const pathToken = (request.params as { token?: string } | undefined)?.token;
    if (pathToken) {
      if (safeEqual(pathToken, expectedApiKey)) {
        request.auth = { kind: 'master' };
        return;
      }

      const account = fastify.config.accounts.find(
        candidate =>
          candidate.enabled !== false &&
          candidate.token !== undefined &&
          safeEqual(candidate.token, pathToken),
      );

      if (account) {
        // Temporary escape hatch for deployments that still rely on a single
        // account token triggering a global sync.
        if (fastify.config.security.allowLegacyGlobalAccountTokens) {
          request.auth = { kind: 'master' };
          return;
        }

        if (fastify.updaterService.hasAccount(account.id)) {
          request.auth = { kind: 'account', accountId: account.id };
          return;
        }
      }
    }

    return reply.code(401).send({ error: 'Unauthorized' });
  });

  const handleAccountSync = async (
    request: FastifyRequest,
    reply: FastifyReply,
    accountId: string,
    providedIp?: string,
  ) => {
    try {
      const { ip, result } = await fastify.updaterService.syncAccount(accountId, providedIp);
      return {
        ip,
        results: { [accountId]: summarizeAccountResult(result) },
        details: { [accountId]: result },
      };
    } catch (err) {
      request.log.error({ err, accountId }, 'Account sync failed');
      return reply.code(502).send({ error: 'Account sync failed' });
    }
  };

  fastify.get('/public-ip', {
    config: { rateLimit: RATE_LIMITS.publicIp },
  }, async (req, _res) => {
    req.log.info('Received public-ip request');
    const ip = await fastify.updaterService.getPublicIp();
    return { ip };
  });

  fastify.post('/sync', {
    config: { rateLimit: RATE_LIMITS.sync },
  }, async (req, reply) => {
    if (req.auth?.kind === 'account') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    req.log.info('Received sync all request');
    const result = await fastify.updaterService.syncAll(true);
    return result;
  });

  fastify.post<{ Params: { id: string } }>('/accounts/:id/sync', {
    config: { rateLimit: RATE_LIMITS.accountSync },
  }, async (req, reply) => {
    if (req.auth?.kind === 'account') {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    if (!fastify.updaterService.hasAccount(req.params.id)) {
      return reply.code(404).send({ error: 'Account not found' });
    }

    req.log.info(`Received sync request for account: ${req.params.id}`);
    const { ip, result } = await fastify.updaterService.syncAccount(req.params.id);
    return {
      message: 'Synced',
      ip,
      results: { [req.params.id]: summarizeAccountResult(result) },
      details: { [req.params.id]: result },
    };
  });

  fastify.get<{ Params: { token: string } }>('/:token/checkip', {
    config: { rateLimit: RATE_LIMITS.checkip },
  }, async (req, reply) => {
    if (req.auth?.kind === 'account') {
      return handleAccountSync(req, reply, req.auth.accountId);
    }

    req.log.info('Received checkip request');
    const result = await fastify.updaterService.syncAll(false);
    return result;
  });

  fastify.get<{ Params: { token: string; ip: string } }>('/:token/setip/:ip', {
    config: { rateLimit: RATE_LIMITS.setip },
  }, async (req, reply) => {
    if (!isValidIPv4(req.params.ip)) {
      return reply.code(400).send({ error: 'Invalid IPv4 address' });
    }

    if (req.auth?.kind === 'account') {
      return handleAccountSync(req, reply, req.auth.accountId, req.params.ip);
    }

    req.log.info(`Received setip request with IP: ${req.params.ip}`);
    const result = await fastify.updaterService.syncAll(true, req.params.ip);
    return result;
  });
};

export default apiRoutes;
