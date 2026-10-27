import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdaterService } from '../src/services/UpdaterService.js';
import { OvhAccount } from '../src/services/OvhAccount.js';

// Global mocks for OvhAccount methods
const mockUpdateAccount = vi.fn();

const successResult = { status: 'success' as const, domains: [] };

vi.mock('../src/services/OvhAccount.js', () => {
    return {
        OvhAccount: class {
            updateAccount = mockUpdateAccount;
        }
    };
});

const mockLogger: any = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn()
};

describe('UpdaterService', () => {
  const config: any = {
    accounts: [
      { id: 'acc1', enabled: true, domains: [] },
      { id: 'acc2', enabled: false, domains: [] },
      { id: 'acc3', enabled: true, domains: [] }
    ]
  };

  let mockIpService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIpService = {
      getPublicIp: vi.fn().mockResolvedValue('1.1.1.1')
    };
    mockUpdateAccount.mockReset();
    mockUpdateAccount.mockResolvedValue(successResult);
  });

  it('should initialize only enabled accounts', () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    expect(service.hasAccount('acc1')).toBe(true);
    expect(service.hasAccount('acc2')).toBe(false);
    expect(service.hasAccount('acc3')).toBe(true);
  });

  it('should sync all accounts with detected IP', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const result = await service.syncAll();

    expect(result.ip).toBe('1.1.1.1');
    expect(result.results['acc1']).toBe('Success');
    expect(result.results['acc3']).toBe('Success');
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
  });

  it('should use provided IP if present', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const result = await service.syncAll(true, '8.8.8.8');

    expect(result.ip).toBe('8.8.8.8');
    expect(mockIpService.getPublicIp).not.toHaveBeenCalled();
  });

  it('should handle account sync failure', async () => {
    mockUpdateAccount
        .mockRejectedValueOnce(new Error('API Down'))
        .mockResolvedValueOnce(successResult);

    const service = new UpdaterService(config, mockIpService, mockLogger);
    const result = await service.syncAll();

    expect(result.results['acc1']).toContain('Failed: API Down');
    expect(result.results['acc3']).toBe('Success');
    expect(result.details['acc1'].status).toBe('failed');
    expect(result.details['acc1'].error).toContain('API Down');
  });

  it('should surface partial account results', async () => {
    mockUpdateAccount
        .mockResolvedValueOnce({
          status: 'partial',
          domains: [{
            domain: 'example.com',
            refresh: 'ok',
            subdomains: [
              { domain: 'example.com', subdomain: '', status: 'updated' },
              { domain: 'example.com', subdomain: 'www', status: 'failed', error: 'nope' }
            ]
          }]
        })
        .mockResolvedValueOnce(successResult);

    const service = new UpdaterService(config, mockIpService, mockLogger);
    const result = await service.syncAll();

    expect(result.results['acc1']).toBe('Partial');
    expect(result.details['acc1'].status).toBe('partial');
    expect(result.results['acc3']).toBe('Success');
  });

  it('should report account existence', () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    expect(service.hasAccount('acc1')).toBe(true);
    expect(service.hasAccount('acc2')).toBe(false);
    expect(service.hasAccount('non-existent')).toBe(false);
  });

  it('should fail to sync non-existent account', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    await expect(service.syncAccount('non-existent')).rejects.toThrow('Account non-existent not found');
  });

  it('should sync specific account', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const { ip, result } = await service.syncAccount('acc1');
    expect(ip).toBe('1.1.1.1');
    expect(result.status).toBe('success');
    expect(mockUpdateAccount).toHaveBeenCalled();
  });

  it('should sync a specific account with a provided IP', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const { ip, result } = await service.syncAccount('acc1', '9.9.9.9');

    expect(ip).toBe('9.9.9.9');
    expect(result.status).toBe('success');
    expect(mockIpService.getPublicIp).not.toHaveBeenCalled();
    expect(mockUpdateAccount).toHaveBeenCalledWith('9.9.9.9');
  });

  it('should still verify with OVH if current IP matches last IP', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    
    // First sync sets lastIp to 1.1.1.1
    await service.syncAll();
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
    
    mockUpdateAccount.mockClear();
    
    // Second sync with same IP
    await service.syncAll();
    
    // Should still call updateAccount because we must "revisar en OVH"
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '1.1.1.1' }), 
        'IP matches last detected IP. Verifying OVH consistency anyway.'
    );
  });

  it('should get public ip', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const ip = await service.getPublicIp();
    expect(ip).toBe('1.1.1.1');
  });

  it('should instrument scheduler triggers and per-subdomain results', async () => {
    const stateStore = {
      recordIpCheck: vi.fn(),
      recordRecordResult: vi.fn(),
      recordAccountError: vi.fn(),
      recordSyncOutcome: vi.fn(),
    };
    mockUpdateAccount.mockResolvedValueOnce({
      status: 'partial',
      domains: [{
        domain: 'example.com',
        refresh: 'ok',
        subdomains: [
          {
            domain: 'example.com',
            subdomain: '',
            status: 'updated',
            records: [{ recordId: 1, previousTarget: '0.0.0.1', status: 'updated' }],
          },
          {
            domain: 'example.com',
            subdomain: 'www',
            status: 'failed',
            error: 'nope',
          },
        ],
      }],
    });

    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);
    const result = await service.syncAll(false, undefined, 'scheduler');

    expect(result.details['acc1'].status).toBe('partial');
    expect(stateStore.recordIpCheck).toHaveBeenCalledWith({
      trigger: 'scheduler',
      ip: '1.1.1.1',
    });
    expect(stateStore.recordRecordResult).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'scheduler',
        accountId: 'acc1',
        domain: 'example.com',
        subdomain: '',
        targetIp: '1.1.1.1',
      }),
    );
    expect(stateStore.recordRecordResult).toHaveBeenCalledTimes(2);
    expect(stateStore.recordSyncOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('should record account-level failures and the final outcome', async () => {
    const stateStore = {
      recordIpCheck: vi.fn(),
      recordRecordResult: vi.fn(),
      recordAccountError: vi.fn(),
      recordDomainError: vi.fn(),
      recordSyncOutcome: vi.fn(),
    };
    mockUpdateAccount.mockRejectedValueOnce(new Error('OVH unavailable'));

    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);
    await service.syncAll();

    expect(stateStore.recordAccountError).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        error: 'OVH unavailable',
      }),
    );
    expect(stateStore.recordSyncOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'partial',
        error: 'OVH unavailable',
      }),
    );
  });

  it('should record zone refresh failures as domain errors', async () => {
    const stateStore = {
      recordIpCheck: vi.fn(),
      recordRecordResult: vi.fn(),
      recordAccountError: vi.fn(),
      recordDomainError: vi.fn(),
      recordSyncOutcome: vi.fn(),
    };
    mockUpdateAccount.mockResolvedValueOnce({
      status: 'partial',
      domains: [{
        domain: 'example.com',
        refresh: 'failed',
        subdomains: [{
          domain: 'example.com',
          subdomain: '',
          status: 'updated',
          records: [{ recordId: 1, previousTarget: '0.0.0.1', status: 'updated' }],
        }],
      }],
    });

    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);
    await service.syncAll();

    expect(stateStore.recordDomainError).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc1',
        domain: 'example.com',
      }),
    );
  });

  it('should never break updates when the state store throws', async () => {
    const fail = vi.fn(() => {
      throw new Error('state store exploded');
    });
    const stateStore = {
      recordIpCheck: fail,
      recordRecordResult: fail,
      recordAccountError: fail,
      recordSyncOutcome: fail,
    };
    mockUpdateAccount.mockResolvedValueOnce({
      status: 'success',
      domains: [{
        domain: 'example.com',
        refresh: 'ok',
        subdomains: [{
          domain: 'example.com',
          subdomain: '',
          status: 'updated',
          records: [{ recordId: 1, previousTarget: '0.0.0.1', status: 'updated' }],
        }],
      }],
    });

    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);
    const result = await service.syncAll();

    expect(result.details['acc1'].status).toBe('success');
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'State store update failed',
    );
  });
});
