import { describe, it, expect, vi, beforeEach } from 'vitest';
import fastify from 'fastify';
import request from 'supertest';
import apiRoutes, { RATE_LIMITS } from '../src/routes/api.js';

describe('API rate limiting', () => {
  let app: any;

  beforeEach(async () => {
    app = fastify();
    app.decorate('updaterService', {
      getPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
      syncAll: vi.fn(),
      syncAccount: vi.fn(),
      hasAccount: vi.fn().mockReturnValue(true),
    });
    app.decorate('config', {
      security: { apiKey: 'master-token' },
      accounts: [],
    });
    await app.register(apiRoutes, { prefix: '/api' });
    await app.ready();
  });

  it('should return 429 after the public-ip limit is exceeded', async () => {
    for (let index = 0; index < RATE_LIMITS.publicIp.max; index += 1) {
      const response = await request(app.server).get('/api/public-ip');
      expect(response.status).toBe(200);
    }

    const limited = await request(app.server).get('/api/public-ip');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
