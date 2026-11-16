import type { AccountConfig, AccountSyncResult, AppConfig } from '../types.js';

const REDACTED = '[redacted]';

/** Removes credentials, query strings and fragments from a URL used in logs/state. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password && !url.search && !url.hash) {
      return value;
    }

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

/** Replaces every configured secret found in a message with a stable marker. */
export function redactSecrets(message: string, secrets: Iterable<string>): string {
  let redacted = message;

  for (const secret of secrets) {
    if (secret.length < 8) continue;

    redacted = redacted.split(secret).join(REDACTED);

    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      redacted = redacted.split(encoded).join(REDACTED);
    }
  }

  return redacted;
}

/** Collects every secret the updater knows about so error paths can redact them. */
export function configuredSecrets(config: {
  security?: Pick<AppConfig['security'], 'apiKey'>;
  accounts?: Array<{
    token?: string;
    credentials?: AccountConfig['credentials'];
  }>;
}): string[] {
  const secrets = config.security?.apiKey ? [config.security.apiKey] : [];

  for (const account of config.accounts ?? []) {
    if (account.token) {
      secrets.push(account.token);
    }

    if (account.credentials) {
      secrets.push(
        account.credentials.appKey,
        account.credentials.appSecret,
        account.credentials.consumerKey,
      );
    }
  }

  return [...new Set(secrets.filter(secret => secret.length > 0))];
}

/** Returns a copy of an account result with credentials removed from every error text. */
export function redactAccountResult(
  result: AccountSyncResult,
  secrets: Iterable<string>,
): AccountSyncResult {
  return {
    ...result,
    error: result.error ? redactSecrets(result.error, secrets) : undefined,
    domains: result.domains.map(domain => ({
      ...domain,
      subdomains: domain.subdomains.map(subdomain => ({
        ...subdomain,
        error: subdomain.error
          ? redactSecrets(subdomain.error, secrets)
          : undefined,
        records: subdomain.records?.map(record => ({
          ...record,
          error: record.error ? redactSecrets(record.error, secrets) : undefined,
        })),
      })),
    })),
  };
}
