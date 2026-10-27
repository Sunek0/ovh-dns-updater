import { beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import request from 'supertest';
import statusRoutes from '../src/routes/status.js';
import uiRoutes from '../src/routes/ui.js';
import { StateStore } from '../src/services/StateStore.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const config: any = {
  security: {
    apiKey: 'master-token',
    allowLegacyGlobalAccountTokens: false,
  },
  accounts: [
    {
      id: 'acc1',
      enabled: true,
      token: 'account-token',
      credentials: {
        endpoint: 'ovh-eu',
        appKey: 'APP_KEY_SHOULD_NOT_LEAK',
        appSecret: 'APP_SECRET_SHOULD_NOT_LEAK',
        consumerKey: 'CONSUMER_KEY_SHOULD_NOT_LEAK',
      },
      domains: [{ name: 'example.com', subdomains: ['@', 'www'] }],
    },
  ],
};

function createStore() {
  const store = new StateStore({
    now: () => NOW,
    historySize: 10,
    refreshSeconds: 10,
    schedulerEnabled: true,
    schedulerIntervalSeconds: 600,
    ondemandEnabled: true,
    accounts: [{ id: 'acc1', domains: config.accounts[0].domains }],
  });

  store.recordIpDetection({
    ip: null,
    provider: null,
    failures: [{ provider: 'https://ip.failing', error: 'timeout' }],
    detectedAt: NOW,
  });
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
  store.recordRecordResult({
    trigger: 'scheduler',
    at: new Date(NOW.getTime() + 1_000),
    accountId: 'acc1',
    domain: 'example.com',
    subdomain: 'www',
    targetIp: '1.1.1.1',
    result: {
      domain: 'example.com',
      subdomain: 'www',
      status: 'failed',
      error: 'OVH error',
    },
  });
  store.recordSyncOutcome({ status: 'partial', error: 'OVH error' });

  return store;
}

describe('Status API routes', () => {
  let app: any;
  let store: StateStore;

  beforeEach(async () => {
    store = createStore();
    app = fastify();
    app.decorate('config', config);
    app.decorate('stateStore', store);
    await app.register(statusRoutes, { prefix: '/api' });
    await app.register(uiRoutes);
    await app.ready();
  });

  it('rejects /api/status without an API key', async () => {
    const response = await request(app.server).get('/api/status');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
    expect(JSON.stringify(response.body)).not.toContain('1.1.1.1');
  });

  it('rejects a wrong API key and an account path token in the header', async () => {
    const wrong = await request(app.server)
      .get('/api/status')
      .set('Authorization', 'Bearer wrong-token');
    expect(wrong.status).toBe(401);

    const accountToken = await request(app.server)
      .get('/api/status')
      .set('Authorization', 'Bearer account-token');
    expect(accountToken.status).toBe(401);
  });

  it('returns the full snapshot with the master API key', async () => {
    const response = await request(app.server)
      .get('/api/status')
      .set('Authorization', 'Bearer master-token');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body.initialIp).toBe('1.1.1.1');
    expect(response.body.currentIp).toBe('1.1.1.1');
    expect(response.body.accounts[0].id).toBe('acc1');
    expect(response.body.accounts[0].domains[0].records).toHaveLength(2);
    expect(response.body.accounts[0].domains[0].records[0]).toMatchObject({
      fqdn: 'example.com',
      type: 'A',
      initialValue: '0.0.0.1',
      currentValue: '1.1.1.1',
      status: 'updated',
    });
    expect(response.body.ipProvider.failures).toEqual([
      { provider: 'https://ip.failing', error: 'timeout' },
    ]);
  });

  it('never exposes credentials, account tokens or the API key', async () => {
    const response = await request(app.server)
      .get('/api/status')
      .set('Authorization', 'Bearer master-token');
    const eventsResponse = await request(app.server)
      .get('/api/events')
      .set('Authorization', 'Bearer master-token');

    const body = JSON.stringify({
      status: response.body,
      events: eventsResponse.body,
    });
    for (const secret of [
      'APP_KEY_SHOULD_NOT_LEAK',
      'APP_SECRET_SHOULD_NOT_LEAK',
      'CONSUMER_KEY_SHOULD_NOT_LEAK',
      'account-token',
      'master-token',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('returns filtered events and validates query parameters', async () => {
    const response = await request(app.server)
      .get('/api/events?limit=1&account=acc1&domain=example.com&type=updated')
      .set('Authorization', 'Bearer master-token');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.total).toBe(1);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]).toMatchObject({
      action: 'updated',
      accountId: 'acc1',
      fqdn: 'example.com',
    });

    const invalidLimit = await request(app.server)
      .get('/api/events?limit=0')
      .set('Authorization', 'Bearer master-token');
    expect(invalidLimit.status).toBe(400);

    const invalidType = await request(app.server)
      .get('/api/events?type=whatever')
      .set('Authorization', 'Bearer master-token');
    expect(invalidType.status).toBe(400);
  });

  it('requires the API key for /api/events', async () => {
    const response = await request(app.server).get('/api/events');
    expect(response.status).toBe(401);
  });

  it('serves the static UI without authentication but not the API data', async () => {
    const page = await request(app.server).get('/');

    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.text).toContain('DNS Updater');
    expect(page.text).toContain('src="/app.js"');
    expect(page.text).not.toMatch(/src="https?:\/\//);

    const styles = await request(app.server).get('/styles.css');
    expect(styles.status).toBe(200);
    expect(styles.headers['content-type']).toContain('text/css');

    const script = await request(app.server).get('/app.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.text).toContain('sessionStorage');

    const api = await request(app.server).get('/api/status');
    expect(api.status).toBe(401);
  });
});
