import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isMasterBearer, safeEqual } from '../utils/auth.js';
import { addApiResponseHeaders } from '../utils/http.js';
import { isValidIPv4 } from '../utils/ip.js';
import { summarizeAccountResult } from '../utils/results.js';

export const RATE_LIMITS = {
  publicIp: { max: 30, timeWindow: '1 minute' },
  sync: { max: 10, timeWindow: '1 minute' },
  accountSync: { max: 10, timeWindow: '1 minute' },
  checkip: { max: 30, timeWindow: '1 minute' },
  setip: { max: 10, timeWindow: '1 minute' },
} as const;

const PUBLIC_ROUTES = new Set(['/api/public-ip']);

const apiRoutes: FastifyPluginAsync = async (fastify, _opts) => {
  addApiResponseHeaders(fastify);
  await fastify.register(rateLimit, { global: false });

  // Default-deny: every route registered by this plugin requires auth unless
  // it is explicitly listed as public. This avoids new management routes
  // accidentally shipping unprotected.
  fastify.addHook('onRequest', async (request, reply) => {
    const routeUrl = request.routeOptions.url ?? '';
    if (PUBLIC_ROUTES.has(routeUrl)) return;

    const expectedApiKey = fastify.config.security.apiKey;

    // 1. Bearer token: only the master API key is accepted in a header.
    if (isMasterBearer(request.headers.authorization, expectedApiKey)) {
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
      request.log.error(
        {
          accountId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Account sync failed',
      );
      return reply.code(502).send({ error: 'Account sync failed' });
    }
  };

  const handleGlobalSync = async (
    request: FastifyRequest,
    reply: FastifyReply,
    force: boolean,
    providedIp?: string,
  ) => {
    try {
      return providedIp === undefined
        ? await fastify.updaterService.syncAll(force)
        : await fastify.updaterService.syncAll(force, providedIp);
    } catch (err) {
      request.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Global sync failed',
      );
      return reply.code(502).send({ error: 'Sync failed' });
    }
  };

  fastify.get('/public-ip', {
    config: { rateLimit: RATE_LIMITS.publicIp },
  }, async (req, reply) => {
    req.log.info('Received public-ip request');
    try {
      const ip = await fastify.updaterService.getPublicIp();
      return { ip };
    } catch (err) {
      req.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Public IP detection failed',
      );
      return reply.code(502).send({ error: 'IP detection failed' });
    }
  });

  fastify.post('/sync', {
    config: { rateLimit: RATE_LIMITS.sync },
  }, async (req, reply) => {
    req.log.info('Received sync all request');
    return handleGlobalSync(req, reply, true);
  });

  fastify.post<{ Params: { id: string } }>('/accounts/:id/sync', {
    config: { rateLimit: RATE_LIMITS.accountSync },
  }, async (req, reply) => {
    if (!fastify.updaterService.hasAccount(req.params.id)) {
      return reply.code(404).send({ error: 'Account not found' });
    }

    req.log.info({ accountId: req.params.id }, 'Received account sync request');
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
    return handleGlobalSync(req, reply, false);
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

    req.log.info({ ip: req.params.ip }, 'Received setip request');
    return handleGlobalSync(req, reply, true, req.params.ip);
  });
};

export default apiRoutes;
