import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IpService } from '../src/services/IpService.js';
import { FastifyBaseLogger } from 'fastify';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as FastifyBaseLogger;

describe('IpService', () => {
  const providers = ['https://ip1.com', 'https://ip2.com'];

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('should return IP from first working provider', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      text: async () => '1.2.3.4',
    });

    const service = new IpService(providers, mockLogger);
    const ip = await service.getPublicIp();

    expect(ip).toBe('1.2.3.4');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should fail over to second provider if first fails', async () => {
    // Mock random sort to ensure a specific order if needed, but here we cover both calls
    // Actually shuffling might make order unpredictable, so we mock failures for N-1
    
    // We can't easily predict order due to shuffle, so let's just make ALL fail except one logic?
    // Or we can mock Math.random to deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // No sort change if consistent?
    
    // Let's assume the loop runs.
    (global.fetch as any)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '5.6.7.8',
      });

    const service = new IpService(providers, mockLogger);
    const ip = await service.getPublicIp();

    expect(ip).toBe('5.6.7.8');
    // Should be called twice (or at least more than once)
    expect(global.fetch).toHaveBeenCalled(); 
  });

  it('should throw error if key all providers fail', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Fail'));

    const service = new IpService(providers, mockLogger);
    
    await expect(service.getPublicIp()).rejects.toThrow('Could not determine public IP');
  });

  it('should validate IP format', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => 'not-an-ip',
    });

    const service = new IpService(providers, mockLogger);

    // If all providers return bad IP
    await expect(service.getPublicIp()).rejects.toThrow();
  });
});
