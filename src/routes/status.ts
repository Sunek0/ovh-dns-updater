import type { FastifyPluginAsync } from 'fastify';
import {
  EVENT_ACTIONS,
  EventAction,
} from '../services/StateStore.js';
import { isMasterBearer } from '../utils/auth.js';
import { addApiResponseHeaders } from '../utils/http.js';

interface EventQuery {
  limit?: string;
  account?: string;
  domain?: string;
  type?: string;
}

const statusRoutes: FastifyPluginAsync = async fastify => {
  addApiResponseHeaders(fastify);

  fastify.addHook('onRequest', async (request, reply) => {
    if (!isMasterBearer(
      request.headers.authorization,
      fastify.config.security.apiKey,
    )) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/status', async () => {
    return fastify.stateStore.getSnapshot();
  });

  fastify.get<{ Querystring: EventQuery }>('/events', async (request, reply) => {
    const { limit: rawLimit, account, domain, type } = request.query;

    let limit: number | undefined;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return reply.code(400).send({ error: 'Invalid limit' });
      }
      limit = parsed;
    }

    if (
      type !== undefined &&
      type !== '' &&
      !EVENT_ACTIONS.includes(type as EventAction)
    ) {
      return reply.code(400).send({ error: 'Invalid event type' });
    }

    return fastify.stateStore.getEvents({
      limit,
      account: account || undefined,
      domain: domain || undefined,
      type: type ? type as EventAction : undefined,
    });
  });
};

export default statusRoutes;
