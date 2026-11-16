import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdaterService } from '../src/services/UpdaterService.js';
import { summarizeAccountResult, toPublicAccountResult } from '../src/utils/results.js';

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

    expect(result.results['acc1']).toBe('Failed');
    expect(result.results['acc3']).toBe('Success');
    expect(result.details['acc1'].status).toBe('failed');
    expect(result.details['acc1'].error).toBe('Account sync failed');
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

  it('should still verify with OVH when the IP has not changed', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    
    // First sync sets the last detected IP
    await service.syncAll();
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
    
    mockUpdateAccount.mockClear();
    
    // Second sync with same IP
    await service.syncAll();
    
    // Should still call updateAccount because we must verify in OVH
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
  });

  it('should get public ip', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const ip = await service.getPublicIp();
    expect(ip).toBe('1.1.1.1');
  });

  it('should force a fresh IP detection when requested', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);

    await service.syncAll(true);
    expect(mockIpService.getPublicIp).toHaveBeenLastCalledWith(true);

    await service.syncAll(false);
    expect(mockIpService.getPublicIp).toHaveBeenLastCalledWith(false);
  });

  it('should record an IP detection failure and skip account updates', async () => {
    mockIpService.getPublicIp.mockRejectedValueOnce(new Error('providers down'));
    const stateStore = { recordIpCheck: vi.fn() };
    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);

    await expect(service.syncAll()).rejects.toThrow('providers down');
    expect(stateStore.recordIpCheck).toHaveBeenCalledWith({
      trigger: 'ondemand',
      error: 'providers down',
    });
    expect(mockUpdateAccount).not.toHaveBeenCalled();
  });

  it('should record a specific-account sync failure', async () => {
    mockUpdateAccount.mockRejectedValueOnce(new Error('OVH down'));
    const stateStore = {
      recordIpCheck: vi.fn(),
      recordAccountError: vi.fn(),
      recordSyncOutcome: vi.fn(),
    };
    const service = new UpdaterService(config, mockIpService, mockLogger, stateStore as any);

    await expect(service.syncAccount('acc1')).rejects.toThrow('OVH down');
    expect(stateStore.recordAccountError).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc1', error: 'OVH down' }),
    );
    expect(stateStore.recordSyncOutcome).toHaveBeenCalledWith({
      status: 'error',
      error: 'Account sync failed',
    });
  });

  it('should serialize concurrent global and account syncs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    mockUpdateAccount
      .mockImplementationOnce(() => gate.then(() => successResult))
      .mockResolvedValue(successResult);

    const singleConfig = {
      accounts: [{ id: 'acc1', enabled: true, domains: [] }],
    };
    const service = new UpdaterService(singleConfig as any, mockIpService, mockLogger);

    const first = service.syncAll();
    const second = service.syncAccount('acc1');

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mockUpdateAccount).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(mockUpdateAccount).toHaveBeenCalledTimes(2);
  });

  it('should redact configured secrets from returned and recorded errors', async () => {
    const secretConfig = {
      security: { apiKey: 'MASTER_KEY_SHOULD_NOT_LEAK' },
      accounts: [{
        id: 'acc1',
        enabled: true,
        domains: [],
        credentials: {
          endpoint: 'ovh-eu',
          appKey: 'APP_KEY_SHOULD_NOT_LEAK',
          appSecret: 'APP_SECRET_SHOULD_NOT_LEAK',
          consumerKey: 'CONSUMER_KEY_SHOULD_NOT_LEAK',
        },
      }],
    };
    mockUpdateAccount.mockRejectedValueOnce(
      new Error('boom APP_SECRET_SHOULD_NOT_LEAK'),
    );
    const stateStore = {
      recordIpCheck: vi.fn(),
      recordAccountError: vi.fn(),
      recordSyncOutcome: vi.fn(),
    };
    const service = new UpdaterService(
      secretConfig as any,
      mockIpService,
      mockLogger,
      stateStore as any,
    );

    const result = await service.syncAll();

    expect(result.results.acc1).toBe('Failed');
    expect(result.details.acc1.error).toBe('Account sync failed');
    expect(JSON.stringify(stateStore.recordAccountError.mock.calls))
      .not.toContain('APP_SECRET_SHOULD_NOT_LEAK');
    expect(JSON.stringify(mockLogger.error.mock.calls))
      .not.toContain('APP_SECRET_SHOULD_NOT_LEAK');
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
        error: 'Account sync failed',
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
      expect.objectContaining({ error: 'state store exploded' }),
      'State store update failed',
    );
  });
});

describe('account result helpers', () => {
  it('summarizes every account status', () => {
    expect(summarizeAccountResult({ status: 'success', domains: [] })).toBe('Success');
    expect(summarizeAccountResult({ status: 'partial', domains: [] })).toBe('Partial');
    expect(summarizeAccountResult({ status: 'failed', domains: [] })).toBe('Failed');
  });

  it('strips upstream diagnostics from public results', () => {
    const result = toPublicAccountResult({
      status: 'partial',
      error: 'OVH error with details',
      domains: [{
        domain: 'example.com',
        refresh: 'failed',
        subdomains: [{
          domain: 'example.com',
          subdomain: 'www',
          status: 'failed',
          error: 'OVH error with details',
          records: [{
            recordId: 1,
            status: 'failed',
            error: 'OVH error with details',
          }],
        }],
      }],
    });

    expect(result.error).toBe('Account sync failed');
    expect(result.domains[0].subdomains[0].error).toBe('Update failed');
    expect(result.domains[0].subdomains[0].records?.[0].error).toBe('Update failed');
    expect(JSON.stringify(result)).not.toContain('with details');
  });
});
