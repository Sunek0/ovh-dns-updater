import ovh, { OvhClient } from 'ovh';
import { FastifyBaseLogger } from 'fastify';
import { AccountConfig, SubdomainConfig } from '../types.js';

export class OvhAccount {
  private client: OvhClient;
  private config: AccountConfig;
  private logger: FastifyBaseLogger;

  constructor(config: AccountConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger.child({ accountId: config.id });
    
    this.client = ovh({
      endpoint: config.credentials.endpoint,
      appKey: config.credentials.appKey,
      appSecret: config.credentials.appSecret,
      consumerKey: config.credentials.consumerKey,
    });
  }

  private request<T>(method: string, path: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client.request(method, path, params, (err: any, result: T) => {
        if (err) {
          // OVH Error structure usually has 'error' code or message
          return reject(new Error(`OVH API Error [${method} ${path}]: ${err.message || err} (${err.error || ''})`));
        }
        resolve(result);
      });
    });
  }

  async updateAccount(publicIp: string): Promise<void> {
    this.logger.info({ publicIp }, 'Starting account update');

    for (const domainCfg of this.config.domains) {
      const { name: domainName, subdomains } = domainCfg;
      let domainUpdated = false;

      this.logger.debug({ domain: domainName }, 'Processing domain');

      // Expand subdomains logic (support string or object {name: 'custom-sub'} if needed in future, current schema is string | SubdomainConfig)
      // Wait, schema in types.ts: subdomains: (string | SubdomainConfig)[];
      // But SubdomainConfig is {[domain: string]: string}.
      // The "NextGen" requirement was "puedan usarse varios app keys...". I should keep it simple.
      // I'll assume simple strings for now based on typical usage, but handle the object case if it maps sub -> something.
      // Actually, looking at old code: `subdomainsToUpdate` could be string or object.
      // Let's simplify and assume the configuration will be normalized to strings or I map it here.
      
      const normalizedSubdomains = subdomains.map(s => {
        let name = typeof s === 'string' ? s : Object.keys(s)[0];
        // Normalize '@' to empty string for OVH root domain
        return name === '@' ? '' : name;
      });

      for (const sub of normalizedSubdomains) {
        if (typeof sub !== 'string') continue;

        try {
          const changed = await this.updateRecord(domainName, sub, publicIp);
          if (changed) domainUpdated = true;
        } catch (err) {
          this.logger.error({ domain: domainName, sub, err }, 'Failed to update subdomain');
        }
      }

      if (domainUpdated) {
        try {
          await this.request('POST', `/domain/zone/${domainName}/refresh`);
          this.logger.info({ domain: domainName }, 'Domain zone refreshed');
        } catch (err) {
          this.logger.error({ domain: domainName, err }, 'Failed to refresh zone');
        }
      }
    }
  }

  private async updateRecord(domain: string, sub: string, targetIp: string): Promise<boolean> {
    // 1. Find the record ID
    const records = await this.request<number[]>('GET', `/domain/zone/${domain}/record`, {
      fieldType: 'A',
      subDomain: sub || undefined,
    });

    if (!records || records.length === 0) {
      this.logger.warn({ domain, sub }, 'Record not found in OVH, skipping (creation not supported yet)');
      return false;
    }

    // usually one record per type/subdomain
    const recordId = records[0];

    // 2. Get current value from OVH to verify if update is needed
    const recordData = await this.request<{ target: string }>('GET', `/domain/zone/${domain}/record/${recordId}`);

    if (recordData.target === targetIp) {
      this.logger.debug({ domain, sub, ip: targetIp }, 'IP already matches in OVH, skipping update');
      return false;
    }

    // 3. Perform the update since it's different
    this.logger.info({ domain, sub, oldIp: recordData.target, newIp: targetIp }, 'IP desynchronized in OVH, updating record');
    await this.request('PUT', `/domain/zone/${domain}/record/${recordId}`, {
      target: targetIp,
      subDomain: sub || undefined,
    });

    return true;
  }
}
