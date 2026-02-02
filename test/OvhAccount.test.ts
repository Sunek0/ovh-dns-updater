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
  });

  it('should update records only if IP changed', async () => {
    // 1. mock GET records for @ and www
    mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123])) // GET @
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' })) // GET details @ (changed)
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})) // PUT @
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [456])) // GET www
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.1.1.1' })) // GET details www (matching)
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {})); // POST refresh

    const account = new OvhAccount(config, mockLogger);
    await account.updateAccount('1.1.1.1');

    // Verify PUT was called for @ but not for www
    const putCalls = mockRequest.mock.calls.filter(c => c[0] === 'PUT');
    expect(putCalls.length).toBe(1);
    expect(putCalls[0][1]).toContain('/123');
    
    // Verify refresh was called because @ changed
    expect(mockRequest).toHaveBeenCalledWith('POST', '/domain/zone/example.com/refresh', undefined, expect.any(Function));
  });

  it('should handle OVH API errors globally', async () => {
    mockRequest.mockImplementation((m, p, pa, cb) => cb(new Error('Network Error')));

    const account = new OvhAccount(config, mockLogger);
    await account.updateAccount('1.1.1.1');

    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should handle record not found', async () => {
    mockRequest.mockImplementationOnce((m, p, pa, cb) => cb(null, [])); // No records

    const account = new OvhAccount(config, mockLogger);
    await account.updateAccount('1.1.1.1');

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ sub: '' }), expect.stringContaining('Record not found'));
  });

  it('should handle refresh failure without stopping', async () => {
      mockRequest
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [123]))
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '1.2.3.4' }))
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))
      .mockImplementationOnce((m, p, pa, cb) => cb(null, [456]))
      .mockImplementationOnce((m, p, pa, cb) => cb(null, { target: '2.2.2.2' }))
      .mockImplementationOnce((m, p, pa, cb) => cb(null, {}))
      .mockImplementationOnce((m, p, pa, cb) => cb(new Error('Refresh Failed'))); // Refresh fails

    const account = new OvhAccount(config, mockLogger);
    await account.updateAccount('1.1.1.1');
    expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to refresh zone');
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
      await account.updateAccount('1.1.1.1');
      // Verify it tried to fetch 'api' and 'blog'
      const getCalls = mockRequest.mock.calls.filter(c => c[0] === 'GET' && c[1].includes('/record'));
      expect(getCalls[0][2].subDomain).toBe('api');
      expect(getCalls[1][2].subDomain).toBe('blog');
  });
});
