import ovh, { OvhClient } from 'ovh';
import { FastifyBaseLogger } from 'fastify';
import {
  AccountConfig,
  AccountSyncResult,
  AccountSyncStatus,
  DomainSyncResult,
  RecordSyncResult,
  SubdomainSyncResult,
} from '../types.js';

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
      timeout: config.credentials.timeout ?? 30000,
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

  async updateAccount(publicIp: string): Promise<AccountSyncResult> {
    this.logger.info({ publicIp }, 'Starting account update');

    const domains: DomainSyncResult[] = [];

    for (const domainCfg of this.config.domains) {
      const { name: domainName, subdomains } = domainCfg;
      const domainResult: DomainSyncResult = {
        domain: domainName,
        refresh: 'not-needed',
        subdomains: [],
      };
      let domainUpdated = false;

      this.logger.debug({ domain: domainName }, 'Processing domain');

      // Accept both plain subdomain strings and single-key objects (legacy shape).
      const normalizedSubdomains = subdomains
        .map(subdomain => typeof subdomain === 'string'
          ? subdomain
          : Object.keys(subdomain)[0])
        .filter((name): name is string => typeof name === 'string')
        .map(name => name === '@' ? '' : name);

      for (const sub of normalizedSubdomains) {
        try {
          const result = await this.updateRecord(domainName, sub, publicIp);
          domainResult.subdomains.push(result);
          if (
            result.status === 'updated' ||
            result.records?.some(record => record.status === 'updated')
          ) {
            domainUpdated = true;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error({ domain: domainName, sub, err }, 'Failed to update subdomain');
          domainResult.subdomains.push({
            domain: domainName,
            subdomain: sub,
            status: 'failed',
            error: message,
          });
        }
      }

      if (domainUpdated) {
        try {
          await this.request('POST', `/domain/zone/${domainName}/refresh`);
          domainResult.refresh = 'ok';
          this.logger.info({ domain: domainName }, 'Domain zone refreshed');
        } catch (err) {
          domainResult.refresh = 'failed';
          this.logger.error({ domain: domainName, err }, 'Failed to refresh zone');
        }
      }

      domains.push(domainResult);
    }

    return {
      status: summarizeAccountStatus(domains),
      domains,
    };
  }

  private async updateRecord(
    domain: string,
    sub: string,
    targetIp: string,
  ): Promise<SubdomainSyncResult> {
    // 1. Find all A record IDs for the subdomain
    const records = await this.request<number[]>('GET', `/domain/zone/${domain}/record`, {
      fieldType: 'A',
      subDomain: sub || undefined,
    });

    if (!records || records.length === 0) {
      this.logger.warn({ domain, sub }, 'Record not found in OVH, skipping (creation not supported yet)');
      return { domain, subdomain: sub, status: 'not-found' };
    }

    const strategy = this.config.recordStrategy ?? 'all';

    if (strategy === 'fail' && records.length !== 1) {
      const error = `Expected exactly one A record, found ${records.length}`;
      this.logger.error({ domain, sub, count: records.length }, error);
      return { domain, subdomain: sub, status: 'failed', error, records: [] };
    }

    if (strategy === 'single' && records.length > 1) {
      this.logger.warn(
        { domain, sub, count: records.length },
        'Multiple A records found, updating only the first',
      );
    }

    const selectedRecords = strategy === 'single' ? records.slice(0, 1) : records;
    const recordResults: RecordSyncResult[] = [];

    for (const recordId of selectedRecords) {
      try {
        // 2. Get current value from OVH to verify if update is needed
        const recordData = await this.request<{ target: string }>(
          'GET',
          `/domain/zone/${domain}/record/${recordId}`,
        );

        if (recordData.target === targetIp) {
          this.logger.debug({ domain, sub, recordId, ip: targetIp }, 'IP already matches in OVH, skipping update');
          recordResults.push({
            recordId,
            previousTarget: recordData.target,
            status: 'unchanged',
          });
          continue;
        }

        // 3. Perform the update since it is different
        this.logger.info(
          { domain, sub, recordId, oldIp: recordData.target, newIp: targetIp },
          'IP desynchronized in OVH, updating record',
        );
        await this.request('PUT', `/domain/zone/${domain}/record/${recordId}`, {
          target: targetIp,
          subDomain: sub || undefined,
        });

        recordResults.push({
          recordId,
          previousTarget: recordData.target,
          status: 'updated',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ domain, sub, recordId, err }, 'Failed to update record');
        recordResults.push({ recordId, status: 'failed', error: message });
      }
    }

    const failed = recordResults.filter(record => record.status === 'failed').length;
    const updated = recordResults.filter(record => record.status === 'updated').length;
    const unchanged = recordResults.filter(record => record.status === 'unchanged').length;

    if (failed > 0) {
      return {
        domain,
        subdomain: sub,
        status: updated > 0 || unchanged > 0 ? 'partial' : 'failed',
        error: `${failed} of ${recordResults.length} records failed`,
        records: recordResults,
      };
    }

    return {
      domain,
      subdomain: sub,
      status: updated > 0 ? 'updated' : 'unchanged',
      records: recordResults,
    };
  }
}

export function summarizeAccountStatus(domains: DomainSyncResult[]): AccountSyncStatus {
  const subdomains = domains.flatMap(domain => domain.subdomains);
  const failed = subdomains.filter(
    subdomain => subdomain.status === 'failed' || subdomain.status === 'not-found',
  ).length;
  const partial = subdomains.filter(subdomain => subdomain.status === 'partial').length;
  const successful = subdomains.filter(
    subdomain => subdomain.status === 'updated' || subdomain.status === 'unchanged',
  ).length;

  let status: AccountSyncStatus;
  if (failed === 0 && partial === 0) {
    status = 'success';
  } else if (successful === 0 && partial === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  if (status === 'success' && domains.some(domain => domain.refresh === 'failed')) {
    status = 'partial';
  }

  return status;
}
