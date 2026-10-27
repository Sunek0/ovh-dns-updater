import { FastifyBaseLogger } from 'fastify';
import { isValidIPv4 } from '../utils/ip.js';

export class IpService {
  private providers: string[];
  private logger: FastifyBaseLogger;
  private cacheTtlMs: number;
  private cached?: { ip: string; expiresAt: number };
  private inFlight?: Promise<string>;

  constructor(providers: string[], logger: FastifyBaseLogger, cacheTtlMs = 30000) {
    this.providers = providers;
    this.logger = logger;
    this.cacheTtlMs = cacheTtlMs;
  }

  async getPublicIp(force = false): Promise<string> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) {
      this.logger.debug({ ip: this.cached.ip }, 'Using cached public IP');
      return this.cached.ip;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchPublicIp()
      .then(ip => {
        this.cached = { ip, expiresAt: Date.now() + this.cacheTtlMs };
        return ip;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    this.inFlight = request;
    return request;
  }

  private async fetchPublicIp(): Promise<string> {
    // Fisher-Yates shuffle to balance providers without the sort() bias.
    const shuffled = [...this.providers];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }

    for (const provider of shuffled) {
      try {
        this.logger.debug({ provider }, 'Fetching IP from provider');
        const response = await fetch(provider, { signal: AbortSignal.timeout(5000) });
        
        if (!response.ok) {
          throw new Error(`Status ${response.status}`);
        }

        const ip = (await response.text()).trim();
        
        if (!isValidIPv4(ip)) {
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
