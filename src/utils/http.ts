import type { FastifyInstance } from 'fastify';

/** Applies the security/caching headers required by every JSON API route. */
export function addApiResponseHeaders(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
}
