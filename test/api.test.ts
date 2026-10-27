import { describe, it, expect, vi, beforeEach } from 'vitest';
import fastify from 'fastify';
import request from 'supertest';
import apiRoutes from '../src/routes/api.js';

const mockSyncAll = vi.fn();
const mockSyncAccount = vi.fn();
const mockHasAccount = vi.fn();

const successAccountResult = (ip: string) => ({
    ip,
    result: { status: 'success' as const, domains: [] }
});

describe('API Routes', () => {
    let app: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        mockHasAccount.mockReturnValue(true);

        app = fastify();

        // Mock UpdaterService on the instance (consistent with src/routes/api.ts using fastify.updaterService)
        app.decorate('updaterService', {
            syncAll: mockSyncAll,
            syncAccount: mockSyncAccount,
            hasAccount: mockHasAccount
        });

        // Mock config for auth logic
        app.decorate('config', {
            security: {
                apiKey: 'master-token',
                allowLegacyGlobalAccountTokens: false
            },
            accounts: [
                { id: 'acc1', token: 'legacy-token', enabled: true },
                { id: 'disabled', token: 'disabled-token', enabled: false }
            ]
        });

        await app.register(apiRoutes, { prefix: '/api' });
        await app.ready();
    });

    it('POST /api/sync should call syncAll (as admin)', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: { acc1: 'Success' } });

        const res = await request(app.server)
            .post('/api/sync')
            .set('Authorization', 'Bearer master-token');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.2.3.4');
        expect(mockSyncAll).toHaveBeenCalledWith(true);
    });

    it('POST /api/sync should accept a lowercase bearer scheme', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: {} });

        const res = await request(app.server)
            .post('/api/sync')
            .set('Authorization', 'bearer master-token');

        expect(res.status).toBe(200);
    });

    it('POST /api/sync should reject a raw token without the Bearer scheme', async () => {
        const res = await request(app.server)
            .post('/api/sync')
            .set('Authorization', 'master-token');

        expect(res.status).toBe(401);
        expect(mockSyncAll).not.toHaveBeenCalled();
    });

    it('POST /api/sync should reject a non-Bearer scheme', async () => {
        const res = await request(app.server)
            .post('/api/sync')
            .set('Authorization', 'Basic master-token');

        expect(res.status).toBe(401);
        expect(mockSyncAll).not.toHaveBeenCalled();
    });

    it('POST /api/sync should reject an account token in the header', async () => {
        const res = await request(app.server)
            .post('/api/sync')
            .set('Authorization', 'Bearer legacy-token');

        expect(res.status).toBe(401);
        expect(mockSyncAll).not.toHaveBeenCalled();
    });

    it('GET /api/:token/checkip should scope an account token to its account', async () => {
        mockSyncAccount.mockResolvedValue(successAccountResult('1.1.1.1'));

        const res = await request(app.server).get('/api/legacy-token/checkip');

        expect(res.status).toBe(200);
        expect(mockSyncAccount).toHaveBeenCalledWith('acc1', undefined);
        expect(mockSyncAll).not.toHaveBeenCalled();
        expect(res.body).toEqual({
            ip: '1.1.1.1',
            results: { acc1: 'Success' },
            details: { acc1: { status: 'success', domains: [] } }
        });
    });

    it('GET /api/:token/checkip should run a global sync with the master path token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: { acc1: 'Success' } });

        const res = await request(app.server).get('/api/master-token/checkip');

        expect(res.status).toBe(200);
        expect(mockSyncAll).toHaveBeenCalledWith(false);
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });

    it('GET /api/:token/checkip should fail with wrong token', async () => {
        const res = await request(app.server).get('/api/wrong-token/checkip');
        expect(res.status).toBe(401);
        expect(mockSyncAll).not.toHaveBeenCalled();
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });

    it('GET /api/:token/checkip should reject a disabled account token', async () => {
        const res = await request(app.server).get('/api/disabled-token/checkip');
        expect(res.status).toBe(401);
    });

    it('GET /api/:token/checkip should preserve the legacy global behaviour when enabled', async () => {
        app.config.security.allowLegacyGlobalAccountTokens = true;
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: {} });

        const res = await request(app.server).get('/api/legacy-token/checkip');

        expect(res.status).toBe(200);
        expect(mockSyncAll).toHaveBeenCalledWith(false);
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });

    it('GET /api/:token/checkip should return 502 when the account sync fails', async () => {
        mockSyncAccount.mockRejectedValue(new Error('OVH down'));

        const res = await request(app.server).get('/api/legacy-token/checkip');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Account sync failed');
    });

    it('GET /api/:token/setip/:ip should reject an invalid IP', async () => {
        const res = await request(app.server).get('/api/legacy-token/setip/999.999.999.999');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid IPv4 address');
        expect(mockSyncAll).not.toHaveBeenCalled();
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });

    it('GET /api/public-ip should return public ip', async () => {
        app.updaterService.getPublicIp = vi.fn().mockResolvedValue('5.5.5.5');
        const res = await request(app.server).get('/api/public-ip');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('5.5.5.5');
    });

    it('POST /api/accounts/:id/sync should sync specific account', async () => {
        mockSyncAccount.mockResolvedValue(successAccountResult('1.1.1.1'));
        const res = await request(app.server)
            .post('/api/accounts/acc1/sync')
            .set('Authorization', 'Bearer master-token');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.1.1.1');
        expect(res.body.results.acc1).toBe('Success');
        expect(res.body.details.acc1.status).toBe('success');
        expect(mockSyncAccount).toHaveBeenCalledWith('acc1');
    });

    it('POST /api/accounts/:id/sync should return 404 for an unknown account', async () => {
        mockHasAccount.mockReturnValue(false);

        const res = await request(app.server)
            .post('/api/accounts/does-not-exist/sync')
            .set('Authorization', 'Bearer master-token');

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Account not found');
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });

    it('GET /api/:token/setip/:ip should scope an account token to its account', async () => {
        mockSyncAccount.mockResolvedValue(successAccountResult('9.9.9.9'));

        const res = await request(app.server).get('/api/legacy-token/setip/9.9.9.9');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ip: '9.9.9.9',
            results: { acc1: 'Success' },
            details: { acc1: { status: 'success', domains: [] } }
        });
        expect(mockSyncAccount).toHaveBeenCalledWith('acc1', '9.9.9.9');
        expect(mockSyncAll).not.toHaveBeenCalled();
    });

    it('GET /api/:token/setip/:ip should run a global sync with the master path token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '9.9.9.9', results: { acc1: 'Success' } });

        const res = await request(app.server).get('/api/master-token/setip/9.9.9.9');

        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('9.9.9.9');
        expect(mockSyncAll).toHaveBeenCalledWith(true, '9.9.9.9');
        expect(mockSyncAccount).not.toHaveBeenCalled();
    });
});
