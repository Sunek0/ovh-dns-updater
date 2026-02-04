import { describe, it, expect, vi, beforeEach } from 'vitest';
import fastify from 'fastify';
import request from 'supertest';
import apiRoutes from '../src/routes/api.js';

const mockSyncAll = vi.fn();
const mockSyncAccount = vi.fn();

describe('API Routes', () => {
    let app: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        app = fastify();
        
        // Mock UpdaterService on the instance (consistent with src/routes/api.ts using fastify.updaterService)
        app.decorate('updaterService', {
            syncAll: mockSyncAll,
            syncAccount: mockSyncAccount
        });

        // Mock config for auth logic
        app.decorate('config', {
            security: { apiKey: 'master-token' },
            accounts: [{ id: 'acc1', token: 'legacy-token' }]
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
    });

    it('GET /api/:token/checkip should work with legacy token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: { acc1: 'Success' } });

        const res = await request(app.server).get('/api/legacy-token/checkip');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.2.3.4');
    });

    it('GET /api/:token/checkip should fail with wrong token', async () => {
        const res = await request(app.server).get('/api/wrong-token/checkip');
        expect(res.status).toBe(401);
    });

    it('GET /api/public-ip should return public ip', async () => {
        // Mock getPublicIp on the updaterService as well if used
        app.updaterService.getPublicIp = vi.fn().mockResolvedValue('5.5.5.5');
        const res = await request(app.server).get('/api/public-ip');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('5.5.5.5');
    });

    it('POST /api/accounts/:id/sync should sync specific account', async () => {
        mockSyncAccount.mockResolvedValue('1.1.1.1');
        const res = await request(app.server)
            .post('/api/accounts/acc1/sync')
            .set('Authorization', 'Bearer master-token');
        
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.1.1.1');
        expect(mockSyncAccount).toHaveBeenCalledWith('acc1');
    });

    it('GET /api/:token/setip/:ip should work with legacy token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '9.9.9.9', results: { acc1: 'Success' } });
        const res = await request(app.server).get('/api/legacy-token/setip/9.9.9.9');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('9.9.9.9');
        expect(mockSyncAll).toHaveBeenCalledWith(true, '9.9.9.9');
    });
});
