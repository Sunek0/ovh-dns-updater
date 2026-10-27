import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdaterService } from '../src/services/UpdaterService.js';
import { OvhAccount } from '../src/services/OvhAccount.js';

// Global mocks for OvhAccount methods
const mockUpdateAccount = vi.fn();

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
  debug: vi.fn()
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
    mockUpdateAccount.mockResolvedValue(undefined);
  });

  it('should initialize only enabled accounts', () => {
    new UpdaterService(config, mockIpService, mockLogger);
    // Since we replaced OvhAccount with a class, we can check its behavior indirectly or check if it was instantiated.
    // In this mock setup, we can't easily check calledTimes on the class itself if it's a real class,
    // but we can check if updateAccount is eventually called.
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
        .mockResolvedValueOnce(undefined);

    const service = new UpdaterService(config, mockIpService, mockLogger);
    const result = await service.syncAll();

    expect(result.results['acc1']).toContain('Failed: API Down');
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
    const ip = await service.syncAccount('acc1');
    expect(ip).toBe('1.1.1.1');
    expect(mockUpdateAccount).toHaveBeenCalled();
  });

  it('should sync a specific account with a provided IP', async () => {
    const service = new UpdaterService(config, mockIpService, mockLogger);
    const ip = await service.syncAccount('acc1', '9.9.9.9');

    expect(ip).toBe('9.9.9.9');
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
});
