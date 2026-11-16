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
import { redactSecrets } from '../utils/redaction.js';
import { normalizeSubdomain } from '../utils/subdomains.js';

interface OvhRecordDetail {
  target: string;
  subDomain: string;
}

export class OvhAccount {
  private client: OvhClient;
  private config: AccountConfig;
  private logger: FastifyBaseLogger;
  private readonly secrets: string[];

  constructor(config: AccountConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = logger.child({ accountId: config.id });
    this.secrets = [
      config.token,
      config.credentials.appKey,
      config.credentials.appSecret,
      config.credentials.consumerKey,
    ].filter((secret): secret is string => Boolean(secret));

    this.client = ovh({
      endpoint: config.credentials.endpoint,
      appKey: config.credentials.appKey,
      appSecret: config.credentials.appSecret,
      consumerKey: config.credentials.consumerKey,
      timeout: config.credentials.timeout ?? 30000,
    });
  }

  private redact(value: string): string {
    return redactSecrets(value, this.secrets);
  }

  private request<T>(method: string, path: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      this.client.request(method, path, params, (err: any, result: T) => {
        if (err) {
          const detail = err?.message ?? String(err);
          const code = err?.error ?? '';
          return reject(new Error(this.redact(
            `OVH API Error [${method} ${path}]: ${detail} (${code})`,
          )));
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

      this.logger.debug({ domain: domainName }, 'Processing domain');

      // Accept both plain subdomain strings and single-key objects (legacy shape).
      const normalizedSubdomains = subdomains
        .map(normalizeSubdomain)
        .filter((name): name is string => name !== undefined);

      for (const sub of normalizedSubdomains) {
        try {
          const result = await this.updateRecord(domainName, sub, publicIp);
          domainResult.subdomains.push(result);
        } catch (err) {
          const message = this.redact(
            err instanceof Error ? err.message : String(err),
          );
          this.logger.error(
            { domain: domainName, sub, error: message },
            'Failed to update subdomain',
          );
          domainResult.subdomains.push({
            domain: domainName,
            subdomain: sub,
            status: 'failed',
            error: message,
          });
        }
      }

      // OVH applies record changes only after a zone refresh. Refresh every
      // domain with managed records, even when all targets already match: an
      // earlier PUT may have succeeded while its refresh failed (or the
      // process crashed before refreshing), in which case the records look
      // unchanged now but the published zone is still stale. Refresh is
      // idempotent, so retrying it unconditionally closes that gap.
      if (normalizedSubdomains.length > 0) {
        try {
          await this.request('POST', `/domain/zone/${domainName}/refresh`);
          domainResult.refresh = 'ok';
          this.logger.info({ domain: domainName }, 'Domain zone refreshed');
        } catch (err) {
          domainResult.refresh = 'failed';
          this.logger.error(
            {
              domain: domainName,
              error: this.redact(
                err instanceof Error ? err.message : String(err),
              ),
            },
            'Failed to refresh zone',
          );
        }
      }

      domains.push(domainResult);
    }

    return {
      status: summarizeAccountStatus(domains),
      domains,
    };
  }

  private notFoundResult(domain: string, sub: string): SubdomainSyncResult {
    this.logger.warn(
      { domain, sub },
      'Record not found in OVH, skipping (creation not supported yet)',
    );

    return { domain, subdomain: sub, status: 'not-found' };
  }

  private async updateRecord(
    domain: string,
    sub: string,
    targetIp: string,
  ): Promise<SubdomainSyncResult> {
    // 1. Find all A record IDs for the subdomain. The OVH `subDomain` filter
    // is optional: omitting it lists every A record in the zone. Pass it even
    // for the root record (empty string), otherwise an `@` update would
    // rewrite unrelated names such as www or mail.
    const records = await this.request<number[]>('GET', `/domain/zone/${domain}/record`, {
      fieldType: 'A',
      subDomain: sub,
    });

    if (!records || records.length === 0) {
      return this.notFoundResult(domain, sub);
    }

    // 2. Read the record details before applying the strategy. This verifies
    // the subDomain returned by OVH and never updates a record that belongs to
    // a different name, even if the API filter is ignored or interpreted
    // loosely.
    const matched: Array<{ recordId: number; target: string }> = [];
    const recordResults: RecordSyncResult[] = [];

    for (const recordId of records) {
      try {
        const recordData = await this.request<OvhRecordDetail>(
          'GET',
          `/domain/zone/${domain}/record/${recordId}`,
        );

        // DNS names are case-insensitive, while the OVH `subDomain` filter is
        // case-insensitive too. Compare normalized values so an uppercase
        // configuration does not skip its own record.
        if (String(recordData.subDomain ?? '').toLowerCase() !== sub.toLowerCase()) {
          this.logger.warn(
            { domain, sub, recordId, recordSubDomain: recordData.subDomain },
            'Ignoring A record returned for a different subdomain',
          );
          continue;
        }

        matched.push({ recordId, target: recordData.target });
      } catch (err) {
        const message = this.redact(
          err instanceof Error ? err.message : String(err),
        );
        this.logger.error(
          { domain, sub, recordId, error: message },
          'Failed to read record',
        );
        recordResults.push({ recordId, status: 'failed', error: message });
      }
    }

    if (matched.length === 0) {
      if (recordResults.length > 0) {
        return {
          domain,
          subdomain: sub,
          status: 'failed',
          error: `Could not read ${recordResults.length} A record(s)`,
          records: recordResults,
        };
      }

      return this.notFoundResult(domain, sub);
    }

    const strategy = this.config.recordStrategy ?? 'all';

    if (strategy === 'fail' && (matched.length !== 1 || recordResults.length > 0)) {
      const error = recordResults.length > 0
        ? `Could not read ${recordResults.length} A record(s); expected exactly one`
        : `Expected exactly one A record, found ${matched.length}`;
      this.logger.error(
        { domain, sub, count: matched.length, unreadable: recordResults.length },
        error,
      );
      return { domain, subdomain: sub, status: 'failed', error, records: recordResults };
    }

    if (strategy === 'single' && matched.length > 1) {
      this.logger.warn(
        { domain, sub, count: matched.length },
        'Multiple A records found, updating only the first',
      );
    }

    const selectedRecords = strategy === 'single' ? matched.slice(0, 1) : matched;

    // 3. Update each selected record only when its target differs.
    for (const { recordId, target } of selectedRecords) {
      if (target === targetIp) {
        this.logger.debug({ domain, sub, recordId, ip: targetIp }, 'IP already matches in OVH, skipping update');
        recordResults.push({
          recordId,
          previousTarget: target,
          status: 'unchanged',
        });
        continue;
      }

      this.logger.info(
        { domain, sub, recordId, oldIp: target, newIp: targetIp },
        'IP desynchronized in OVH, updating record',
      );
      try {
        await this.request('PUT', `/domain/zone/${domain}/record/${recordId}`, {
          target: targetIp,
        });

        recordResults.push({
          recordId,
          previousTarget: target,
          status: 'updated',
        });
      } catch (err) {
        const message = this.redact(
          err instanceof Error ? err.message : String(err),
        );
        this.logger.error(
          { domain, sub, recordId, error: message },
          'Failed to update record',
        );
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
