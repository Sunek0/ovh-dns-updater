import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OvhAccount } from '../src/services/OvhAccount.js';

const mockRequest = vi.fn();

vi.mock('ovh', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      request: mockRequest
    }))
  };
});

const mockLogger: any = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn().mockReturnThis()
};

describe('OvhAccount', () => {
  const config: any = {
    id: 'test-acc',
    credentials: {
      endpoint: 'ovh-eu',
      appKey: 'key',
      appSecret: 'secret',
      consumerKey: 'consumer'
    },
    domains: [
      {
        name: 'example.com',
        subdomains: ['@', 'www']
      }
    ]
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
  });

  it('should update records only if IP changed in OVH', async () => {
    // 1. mock sequence for @ and www
    // For @: GET records -> [123], GET details -> target '1.2.3.4' (changed) -> PUT -> POST refresh
    // For www: GET records -> [456], GET details -> target '1.1.1.1' (matching) -> skip
    
    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123]))   // GET @ (get ID)
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // GET details @
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))      // PUT @
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [456]))   // GET www
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.1.1.1' })) // GET details www
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}));     // POST refresh

    const account = new OvhAccount(config, mockLogger);
    const result = await account.updateAccount('1.1.1.1');

    // Verify PUT was called for @ but not for www
    const putCalls = mockRequest.mock.calls.filter(c => c[0] === 'PUT');
    expect(putCalls.length).toBe(1);
    expect(putCalls[0][1]).toContain('/123');

    // Verify refresh was called because @ changed
    expect(mockRequest).toHaveBeenCalledWith('POST', '/domain/zone/example.com/refresh', undefined, expect.any(Function));
    expect(result.status).toBe('success');
    expect(result.domains[0].refresh).toBe('ok');
    expect(result.domains[0].subdomains).toMatchObject([
      {
        domain: 'example.com',
        subdomain: '',
        status: 'updated',
        records: [{ recordId: 123, previousTarget: '1.2.3.4', status: 'updated' }]
      },
      {
        domain: 'example.com',
        subdomain: 'www',
        status: 'unchanged',
        records: [{ recordId: 456, previousTarget: '1.1.1.1', status: 'unchanged' }]
      }
    ]);
  });

  it('should report partial results when one subdomain fails', async () => {
    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123]))   // @ get ID
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // @ details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))      // @ PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(new Error('Subdomain failure'))) // www get ID fails
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}));     // refresh

    const account = new OvhAccount(config, mockLogger);
    const result = await account.updateAccount('1.1.1.1');

    expect(result.status).toBe('partial');
    expect(result.domains[0].refresh).toBe('ok');
    expect(result.domains[0].subdomains).toMatchObject([
      {
        domain: 'example.com',
        subdomain: '',
        status: 'updated',
        records: [{ recordId: 123, previousTarget: '1.2.3.4', status: 'updated' }]
      },
      {
        domain: 'example.com',
        subdomain: 'www',
        status: 'failed',
        error: expect.stringContaining('Subdomain failure')
      }
    ]);
  });

  it('should update all A records with the default strategy', async () => {
    const multiRecordConfig = {
      ...config,
      recordStrategy: 'all',
      domains: [{ name: 'example.com', subdomains: ['www'] }]
    };

    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123, 456])) // www IDs
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // 123 details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})) // 123 PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.5' })) // 456 details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})) // 456 PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})); // refresh

    const account = new OvhAccount(multiRecordConfig, mockLogger);
    const result = await account.updateAccount('9.9.9.9');

    expect(result.status).toBe('success');
    expect(result.domains[0].refresh).toBe('ok');
    expect(result.domains[0].subdomains[0]).toMatchObject({
      status: 'updated',
      records: [
        { recordId: 123, previousTarget: '1.2.3.4', status: 'updated' },
        { recordId: 456, previousTarget: '1.2.3.5', status: 'updated' }
      ]
    });
    expect(mockRequest.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(2);
  });

  it('should reject multiple A records with the fail strategy', async () => {
    const multiRecordConfig = {
      ...config,
      recordStrategy: 'fail',
      domains: [{ name: 'example.com', subdomains: ['www'] }]
    };

    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123, 456]));

    const account = new OvhAccount(multiRecordConfig, mockLogger);
    const result = await account.updateAccount('9.9.9.9');

    expect(result.status).toBe('failed');
    expect(result.domains[0].subdomains[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Expected exactly one A record, found 2')
    });
    expect(mockRequest.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
  });

  it('should update only the first A record with the single strategy', async () => {
    const multiRecordConfig = {
      ...config,
      recordStrategy: 'single',
      domains: [{ name: 'example.com', subdomains: ['www'] }]
    };

    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123, 456])) // www IDs
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // 123 details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})) // 123 PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})); // refresh

    const account = new OvhAccount(multiRecordConfig, mockLogger);
    const result = await account.updateAccount('9.9.9.9');

    expect(result.status).toBe('success');
    expect(result.domains[0].subdomains[0].records).toHaveLength(1);
    expect(result.domains[0].subdomains[0].records?.[0].recordId).toBe(123);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      'Multiple A records found, updating only the first'
    );
    expect(mockRequest.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(1);
  });

  it('should preserve wildcard subdomains', async () => {
    const wildcardConfig = {
      ...config,
      domains: [{ name: 'example.com', subdomains: ['@', '*'] }]
    };

    mockRequest.mockImplementation((m, p, pa, cb) => cb(null, []));

    const account = new OvhAccount(wildcardConfig, mockLogger);
    const result = await account.updateAccount('1.1.1.1');

    const getCalls = mockRequest.mock.calls.filter(
      call => call[0] === 'GET' && call[1].includes('/record')
    );
    expect(getCalls[0][2].subDomain).toBeUndefined();
    expect(getCalls[1][2].subDomain).toBe('*');
    expect(result.domains[0].subdomains.map(subdomain => subdomain.subdomain)).toEqual(['', '*']);
  });

  it('should handle OVH API errors globally', async () => {
    mockRequest.mockImplementation((m, p, pa, cb) => cb(new Error('Network Error')));

    const account = new OvhAccount(config, mockLogger);
    const result = await account.updateAccount('1.1.1.1');

    expect(mockLogger.error).toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.domains[0].subdomains).toHaveLength(2);
    expect(result.domains[0].subdomains.every(subdomain => subdomain.status === 'failed')).toBe(true);
  });

  it('should handle record not found', async () => {
    mockRequest.mockImplementation((m, p, pa, cb) => cb(null, []));

    const account = new OvhAccount(config, mockLogger);
    const result = await account.updateAccount('1.1.1.1');

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ sub: '' }), expect.stringContaining('Record not found'));
    expect(result.status).toBe('failed');
    expect(result.domains[0].subdomains.every(subdomain => subdomain.status === 'not-found')).toBe(true);
  });

  it('should handle refresh failure without stopping', async () => {
      mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123]))   // @ get ID
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // @ details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))      // @ PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [456]))   // www get ID
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '2.2.2.2' })) // www details
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))      // www PUT
      .mockImplementationOnce((m, p, pa, cb) => cb(new Error('Refresh Failed'))); // Refresh fails

    const account = new OvhAccount(config, mockLogger);
    const result = await account.updateAccount('1.1.1.1');
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to refresh zone');
    expect(result.status).toBe('partial');
    expect(result.domains[0].refresh).toBe('failed');
  });

  it('should handle complex subdomain configs', async () => {
      const complexConfig = {
          ...config,
          domains: [{
              name: 'example.com',
              subdomains: [{ 'api': 'some-meta' }, 'blog']
          }]
      };
      mockRequest.mockImplementation((m, p, pa, cb) => cb(null, []));
      
      const account = new OvhAccount(complexConfig, mockLogger);
      const result = await account.updateAccount('1.1.1.1');
      // Verify it tried to fetch 'api' and 'blog'
      const getCalls = mockRequest.mock.calls.filter(c => c[0] === 'GET' && c[1].includes('/record'));
      expect(getCalls[0][2].subDomain).toBe('api');
      expect(getCalls[1][2].subDomain).toBe('blog');
      expect(result.domains[0].subdomains.map(subdomain => subdomain.subdomain)).toEqual(['api', 'blog']);
  });
});
