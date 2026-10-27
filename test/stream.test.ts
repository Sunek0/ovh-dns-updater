import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import statusRoutes from '../src/routes/status.js';
import { StateStore } from '../src/services/StateStore.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

interface SseFrame {
  event: string;
  data: any;
}

interface SseReader {
  nextFrame: (timeoutMs?: number) => Promise<SseFrame>;
  close: () => Promise<void>;
}

const config: any = {
  security: {
    apiKey: 'master-token',
    allowLegacyGlobalAccountTokens: false,
  },
  accounts: [{
    id: 'acc1',
    enabled: true,
    credentials: {
      endpoint: 'ovh-eu',
      appKey: 'secret',
      appSecret: 'secret',
      consumerKey: 'secret',
    },
    domains: [{ name: 'example.com', subdomains: ['@', 'www'] }],
  }],
};

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (dataLines.length === 0) return null;

  return {
    event,
    data: JSON.parse(dataLines.join('\n')),
  };
}

function createSseReader(body: ReadableStream<Uint8Array>): SseReader {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  return {
    async nextFrame(timeoutMs = 3000): Promise<SseFrame> {
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseFrame(raw);
          if (frame) return frame;
          continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error('Timed out waiting for an SSE frame');
        }

        let timeout: NodeJS.Timeout | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Timed out waiting for an SSE frame')),
            remaining,
          );
        });

        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([reader.read(), timedOut]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }

        if (result.done) {
          throw new Error('SSE stream ended unexpectedly');
        }

        buffer += decoder.decode(result.value, { stream: true });
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed after aborting the fetch.
      }
    },
  };
}

describe('SSE stream', () => {
  let app: FastifyInstance;
  let store: StateStore;
  let baseUrl: string;
  const controllers: AbortController[] = [];
  const readers: SseReader[] = [];

  beforeEach(async () => {
    store = new StateStore({
      now: () => NOW,
      historySize: 20,
      schedulerEnabled: false,
      ondemandEnabled: true,
      accounts: [{ id: 'acc1', domains: config.accounts[0].domains }],
    });

    app = fastify();
    app.decorate('config', config);
    app.decorate('stateStore', store);
    await app.register(statusRoutes, { prefix: '/api' });
    await app.listen({ port: 0, host: '127.0.0.1' });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not expose a TCP address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const controller of controllers) {
      controller.abort();
    }
    for (const reader of readers) {
      await reader.close();
    }
    controllers.length = 0;
    readers.length = 0;
    await app.close();
  });

  async function openStream(query = '', apiKey = 'master-token') {
    const controller = new AbortController();
    controllers.push(controller);

    const response = await fetch(`${baseUrl}/api/stream${query}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    const reader = createSseReader(response.body);
    readers.push(reader);
    return { response, reader, controller };
  }

  it('rejects connections without the master API key', async () => {
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { Accept: 'text/event-stream' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('validates stream filters before opening the connection', async () => {
    const response = await fetch(`${baseUrl}/api/stream?type=nope`, {
      headers: { Authorization: 'Bearer master-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid event type' });
  });

  it('sends a bootstrap, then snapshot updates and new events', async () => {
    store.recordIpCheck({ trigger: 'startup', ip: '1.1.1.1' });
    store.recordRecordResult({
      trigger: 'startup',
      at: NOW,
      accountId: 'acc1',
      domain: 'example.com',
      subdomain: '',
      targetIp: '1.1.1.1',
      result: {
        domain: 'example.com',
        subdomain: '',
        status: 'updated',
        records: [{ recordId: 1, previousTarget: '0.0.0.1', status: 'updated' }],
      },
    });

    const { response, reader } = await openStream();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const bootstrap = await reader.nextFrame();
    expect(bootstrap.event).toBe('bootstrap');
    expect(bootstrap.data.snapshot.currentIp).toBe('1.1.1.1');
    expect(bootstrap.data.events).toHaveLength(1);
    expect(bootstrap.data.events[0]).toEqual(expect.objectContaining({
      action: 'updated',
      fqdn: 'example.com',
    }));
    expect(bootstrap.data.total).toBe(1);

    store.recordIpCheck({ trigger: 'ondemand', ip: '2.2.2.2' });

    const update = await reader.nextFrame();
    expect(update.event).toBe('update');
    expect(update.data.snapshot.currentIp).toBe('2.2.2.2');
    expect(update.data.events).toEqual([
      expect.objectContaining({
        action: 'public_ip_changed',
        oldValue: '1.1.1.1',
        newValue: '2.2.2.2',
      }),
    ]);
    expect(update.data.total).toBe(2);
  });

  it('filters the bootstrap and live events by type', async () => {
    store.recordRecordResult({
      trigger: 'startup',
      at: NOW,
      accountId: 'acc1',
      domain: 'example.com',
      subdomain: '',
      targetIp: '1.1.1.1',
      result: {
        domain: 'example.com',
        subdomain: '',
        status: 'updated',
        records: [{ recordId: 1, previousTarget: '0.0.0.1', status: 'updated' }],
      },
    });
    store.recordRecordResult({
      trigger: 'startup',
      at: NOW,
      accountId: 'acc1',
      domain: 'example.com',
      subdomain: 'www',
      targetIp: '1.1.1.1',
      result: {
        domain: 'example.com',
        subdomain: 'www',
        status: 'failed',
        error: 'OVH failed',
      },
    });

    const { reader } = await openStream('?type=error&limit=10');
    const bootstrap = await reader.nextFrame();

    expect(bootstrap.data.events).toHaveLength(1);
    expect(bootstrap.data.total).toBe(1);
    expect(bootstrap.data.events[0].action).toBe('error');

    store.recordRecordResult({
      trigger: 'scheduler',
      at: NOW,
      accountId: 'acc1',
      domain: 'example.com',
      subdomain: '',
      targetIp: '1.1.1.1',
      result: {
        domain: 'example.com',
        subdomain: '',
        status: 'unchanged',
        records: [{ recordId: 1, previousTarget: '1.1.1.1', status: 'unchanged' }],
      },
    });

    const unchangedUpdate = await reader.nextFrame();
    expect(unchangedUpdate.event).toBe('update');
    expect(unchangedUpdate.data.events).toEqual([]);

    store.recordRecordResult({
      trigger: 'scheduler',
      at: NOW,
      accountId: 'acc1',
      domain: 'example.com',
      subdomain: 'www',
      targetIp: '1.1.1.1',
      result: {
        domain: 'example.com',
        subdomain: 'www',
        status: 'failed',
        error: 'Still failing',
      },
    });

    const errorUpdate = await reader.nextFrame();
    expect(errorUpdate.event).toBe('update');
    expect(errorUpdate.data.events).toHaveLength(1);
    expect(errorUpdate.data.events[0]).toEqual(expect.objectContaining({
      action: 'error',
      fqdn: 'www.example.com',
    }));
  });
});
