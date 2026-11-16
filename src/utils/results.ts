import type {
  AccountSyncResult,
  SubdomainSyncStatus,
} from '../types.js';

export function summarizeAccountResult(result: AccountSyncResult): string {
  if (result.status === 'success') return 'Success';
  if (result.status === 'partial') return 'Partial';
  return 'Failed';
}

function publicMessage(status: SubdomainSyncStatus): string | undefined {
  if (status === 'failed') return 'Update failed';
  if (status === 'partial') return 'Partial update failed';
  if (status === 'not-found') return 'Record not found';
  return undefined;
}

/**
 * Strips upstream error text from API responses. Full diagnostics stay in the
 * server logs and in the authenticated in-memory state store.
 */
export function toPublicAccountResult(result: AccountSyncResult): AccountSyncResult {
  return {
    status: result.status,
    ...(result.error ? { error: 'Account sync failed' } : {}),
    domains: result.domains.map(domain => ({
      domain: domain.domain,
      refresh: domain.refresh,
      subdomains: domain.subdomains.map(subdomain => {
        const message = publicMessage(subdomain.status);

        return {
          domain: subdomain.domain,
          subdomain: subdomain.subdomain,
          status: subdomain.status,
          ...(message ? { error: message } : {}),
          ...(subdomain.records
            ? {
                records: subdomain.records.map(record => ({
                  recordId: record.recordId,
                  ...(record.previousTarget !== undefined
                    ? { previousTarget: record.previousTarget }
                    : {}),
                  status: record.status,
                  ...(record.error ? { error: 'Update failed' } : {}),
                })),
              }
            : {}),
        };
      }),
    })),
  };
}
