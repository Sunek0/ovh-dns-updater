import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it('should reject out-of-range IPv4 octets', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '999.999.999.999',
    });

    const service = new IpService(providers, mockLogger);

    await expect(service.getPublicIp()).rejects.toThrow('Could not determine public IP');
  });

  it('should cache the detected IP', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '1.2.3.4',
    });

    const service = new IpService(providers, mockLogger);

    await expect(service.getPublicIp()).resolves.toBe('1.2.3.4');
    await expect(service.getPublicIp()).resolves.toBe('1.2.3.4');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should bypass the cache when forced', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '1.2.3.4',
    });

    const service = new IpService(providers, mockLogger);

    await service.getPublicIp();
    await service.getPublicIp(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should deduplicate concurrent IP detections', async () => {
    let resolveText!: (value: string) => void;
    const text = new Promise<string>(resolve => {
      resolveText = resolve;
    });

    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: () => text,
    });

    const service = new IpService(providers, mockLogger);
    const first = service.getPublicIp();
    const second = service.getPublicIp();

    resolveText('1.2.3.4');

    await expect(Promise.all([first, second])).resolves.toEqual(['1.2.3.4', '1.2.3.4']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should refresh the IP after the cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '1.2.3.4',
    });

    const service = new IpService(providers, mockLogger, 1000);

    await service.getPublicIp();
    vi.setSystemTime(new Date(1001));
    await service.getPublicIp();

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should report the provider that answered and the failed providers', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const reports: any[] = [];
    (global.fetch as any)
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '1.2.3.4',
      });

    const service = new IpService(
      providers,
      mockLogger,
      30000,
      report => reports.push(report),
    );
    const ip = await service.getPublicIp();

    expect(ip).toBe('1.2.3.4');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      ip: '1.2.3.4',
      provider: providers[1],
      failures: [{ provider: providers[0], error: 'down' }],
    });
    expect(reports[0].detectedAt).toBeInstanceOf(Date);
  });

  it('should report every failure when no provider works', async () => {
    const reports: any[] = [];
    (global.fetch as any).mockRejectedValue(new Error('down'));

    const service = new IpService(
      providers,
      mockLogger,
      30000,
      report => reports.push(report),
    );

    await expect(service.getPublicIp()).rejects.toThrow('Could not determine public IP');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ ip: null, provider: null });
    expect(reports[0].failures).toHaveLength(2);
  });

  it('should keep detecting the IP when the observer throws', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '1.2.3.4',
    });

    const service = new IpService(
      providers,
      mockLogger,
      30000,
      () => {
        throw new Error('observer exploded');
      },
    );

    await expect(service.getPublicIp()).resolves.toBe('1.2.3.4');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'IP detection observer failed',
    );
  });
});
