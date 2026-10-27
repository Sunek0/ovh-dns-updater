import type { SubdomainConfig } from '../types.js';

/**
 * Normalizes a configured subdomain to the value used by the OVH API.
 * `@` becomes the empty string (root record) and legacy single-key objects
 * keep their first key.
 */
export function normalizeSubdomain(
  subdomain: string | SubdomainConfig,
): string | undefined {
  const name = typeof subdomain === 'string' ? subdomain : Object.keys(subdomain)[0];
  if (typeof name !== 'string') return undefined;
  return name === '@' ? '' : name;
}

/** Returns the fully qualified name for a configured domain/subdomain pair. */
export function qualifyDomain(domain: string, subdomain: string): string {
  return subdomain.length > 0 ? `${subdomain}.${domain}` : domain;
}
