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
            security: { adminToken: 'master-token' },
            accounts: [{ id: 'acc1', token: 'legacy-token' }]
        });

        await app.register(apiRoutes);
        await app.ready();
    });

    it('POST /sync should call syncAll (as admin)', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: { acc1: 'Success' } });
        
        const res = await request(app.server)
            .post('/sync')
            .set('Authorization', 'Bearer master-token');
        
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.2.3.4');
    });

    it('GET /:token/checkip should work with legacy token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '1.2.3.4', results: { acc1: 'Success' } });

        const res = await request(app.server).get('/legacy-token/checkip');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.2.3.4');
    });

    it('GET /:token/checkip should fail with wrong token', async () => {
        const res = await request(app.server).get('/wrong-token/checkip');
        expect(res.status).toBe(401);
    });

    it('GET /public-ip should return public ip', async () => {
        // Mock getPublicIp on the updaterService as well if used
        app.updaterService.getPublicIp = vi.fn().mockResolvedValue('5.5.5.5');
        const res = await request(app.server).get('/public-ip');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('5.5.5.5');
    });

    it('POST /accounts/:id/sync should sync specific account', async () => {
        mockSyncAccount.mockResolvedValue('1.1.1.1');
        const res = await request(app.server)
            .post('/accounts/acc1/sync')
            .set('Authorization', 'Bearer master-token');
        
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('1.1.1.1');
        expect(mockSyncAccount).toHaveBeenCalledWith('acc1');
    });

    it('GET /:token/setip/:ip should work with legacy token', async () => {
        mockSyncAll.mockResolvedValue({ ip: '9.9.9.9', results: { acc1: 'Success' } });
        const res = await request(app.server).get('/legacy-token/setip/9.9.9.9');
        expect(res.status).toBe(200);
        expect(res.body.ip).toBe('9.9.9.9');
        expect(mockSyncAll).toHaveBeenCalledWith(true, '9.9.9.9');
    });
});
