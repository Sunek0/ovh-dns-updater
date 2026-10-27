import type { FastifyPluginAsync } from 'fastify';
import {
  EVENT_ACTIONS,
  type EventAction,
  type EventFilter,
  type StateChangeListener,
  type StatusEvent,
  type StatusSnapshot,
} from '../services/StateStore.js';
import { isMasterBearer } from '../utils/auth.js';
import { addApiResponseHeaders } from '../utils/http.js';

interface EventQuery {
  limit?: string;
  account?: string;
  domain?: string;
  type?: string;
}

interface BootstrapPayload {
  snapshot: StatusSnapshot;
  events: StatusEvent[];
  total: number;
}

type StreamUpdatePayload = BootstrapPayload;

const STREAM_DEBOUNCE_MS = 150;
const STREAM_HEARTBEAT_MS = 20_000;

function parseEventFilter(query: EventQuery): {
  filter: EventFilter;
  error?: string;
} {
  let limit: number | undefined;
  if (query.limit !== undefined && query.limit !== '') {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { filter: {}, error: 'Invalid limit' };
    }
    limit = parsed;
  }

  if (
    query.type !== undefined &&
    query.type !== '' &&
    !EVENT_ACTIONS.includes(query.type as EventAction)
  ) {
    return { filter: {}, error: 'Invalid event type' };
  }

  return {
    filter: {
      limit,
      account: query.account || undefined,
      domain: query.domain || undefined,
      type: query.type ? query.type as EventAction : undefined,
    },
  };
}

function matchesEventFilter(event: StatusEvent, filter: EventFilter): boolean {
  if (filter.account && event.accountId !== filter.account) return false;
  if (filter.domain && event.domain !== filter.domain) return false;
  if (filter.type && event.action !== filter.type) return false;
  return true;
}

const statusRoutes: FastifyPluginAsync = async fastify => {
  addApiResponseHeaders(fastify);

  const activeStreams = new Set<() => void>();

  fastify.addHook('onClose', async () => {
    for (const close of [...activeStreams]) {
      close();
    }
    activeStreams.clear();
  });

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
    const parsed = parseEventFilter(request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: parsed.error });
    }

    return fastify.stateStore.getEvents(parsed.filter);
  });

  fastify.get<{ Querystring: EventQuery }>('/stream', async (request, reply) => {
    const parsed = parseEventFilter(request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: parsed.error });
    }

    const filter = parsed.filter;
    const store = fastify.stateStore;
    const response = reply.raw;

    reply.hijack();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive',
    });
    response.flushHeaders();

    let closed = false;
    let blocked = false;
    let dirty = false;
    let flushScheduled = false;
    let flushTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const pendingEvents: StatusEvent[] = [];
    const pendingEventLimit = Math.min(filter.limit ?? 100, 1000);

    const cleanup = () => {
      if (closed) return;
      closed = true;

      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      unsubscribe?.();
      unsubscribe = undefined;
      activeStreams.delete(cleanup);

      if (!response.writableEnded) {
        try {
          response.end();
        } catch {
          // The socket may already be gone.
        }
      }
    };

    const writeEvent = (event: string, data: unknown): boolean => {
      if (closed || response.writableEnded || response.destroyed) {
        return true;
      }
      return response.write(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };

    const flush = () => {
      flushScheduled = false;
      flushTimer = undefined;
      if (closed) return;
      if (blocked) {
        dirty = true;
        return;
      }

      // Live events are kept chronologically by the store; the API and the UI
      // use newest-first ordering.
      const events = pendingEvents.splice(0, pendingEvents.length).reverse();
      let payload: StreamUpdatePayload;
      try {
        payload = {
          snapshot: store.getSnapshot(),
          events,
          total: store.getEvents({ ...filter, limit: 1 }).total,
        };
      } catch (err) {
        fastify.log.error({ err }, 'Failed to build SSE update');
        cleanup();
        return;
      }

      if (!writeEvent('update', payload)) {
        blocked = true;
      }
    };

    const scheduleFlush = () => {
      if (closed) return;
      if (blocked) {
        dirty = true;
        return;
      }
      if (flushScheduled) return;

      flushScheduled = true;
      flushTimer = setTimeout(flush, STREAM_DEBOUNCE_MS);
    };

    const onStateChange: StateChangeListener = event => {
      if (event && matchesEventFilter(event, filter)) {
        if (pendingEvents.length >= pendingEventLimit) {
          pendingEvents.shift();
        }
        pendingEvents.push(event);
      }
      scheduleFlush();
    };

    unsubscribe = store.subscribe(onStateChange);
    activeStreams.add(cleanup);

    response.on('drain', () => {
      blocked = false;
      if (closed) return;
      if (dirty) {
        dirty = false;
        scheduleFlush();
      }
    });
    response.on('close', cleanup);
    response.on('error', cleanup);
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    try {
      const initial = store.getEvents(filter);
      const bootstrap: BootstrapPayload = {
        snapshot: store.getSnapshot(),
        events: initial.events,
        total: initial.total,
      };
      if (!writeEvent('bootstrap', bootstrap)) {
        blocked = true;
      }
    } catch (err) {
      fastify.log.error({ err }, 'Failed to send SSE bootstrap');
      cleanup();
      return;
    }

    if (closed) return;

    heartbeatTimer = setInterval(() => {
      if (closed || blocked) return;
      if (!writeEvent('heartbeat', { time: new Date().toISOString() })) {
        blocked = true;
      }
    }, STREAM_HEARTBEAT_MS);
  });
};

export default statusRoutes;
