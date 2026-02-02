import { FastifyBaseLogger } from 'fastify';

export class IpService {
  private providers: string[];
  private logger: FastifyBaseLogger;

  constructor(providers: string[], logger: FastifyBaseLogger) {
    this.providers = providers;
    this.logger = logger;
  }

  async getPublicIp(): Promise<string> {
    // Shuffle providers to load balance / randomize
    const shuffled = [...this.providers].sort(() => 0.5 - Math.random());

    for (const provider of shuffled) {
      try {
        this.logger.debug({ provider }, 'Fetching IP from provider');
        const response = await fetch(provider, { signal: AbortSignal.timeout(5000) });
        
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }

        const ip = (await response.text()).trim();
        
        // Basic IPv4 validation
        if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
           throw new Error(`Invalid IP format received: ${ip}`);
        }

        this.logger.info({ provider, ip }, 'Public IP detected');
        return ip;
      } catch (err) {
        this.logger.warn({ provider, err }, 'Failed to fetch IP from provider, trying next...');
      }
    }

    throw new Error('Could not determine public IP from any provider');
  }
}
