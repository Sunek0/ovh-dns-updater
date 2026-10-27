import 'fastify';

export type AuthContext =
  | { kind: 'master' }
  | { kind: 'account'; accountId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export interface SubdomainConfig {
  [domain: string]: string;
}

export interface DomainConfig {
  name: string;
  subdomains: (string | SubdomainConfig)[];
}

export interface OvhCredentials {
  endpoint: string;
  appKey: string;
  appSecret: string;
  consumerKey: string;
  timeout?: number; // milliseconds, defaults to 30000
}

export type SubdomainSyncStatus = 'updated' | 'unchanged' | 'not-found' | 'failed';

export interface SubdomainSyncResult {
  domain: string;
  subdomain: string;
  status: SubdomainSyncStatus;
  error?: string;
}

export type RefreshStatus = 'ok' | 'failed' | 'not-needed';

export interface DomainSyncResult {
  domain: string;
  refresh: RefreshStatus;
  subdomains: SubdomainSyncResult[];
}

export type AccountSyncStatus = 'success' | 'partial' | 'failed';

export interface AccountSyncResult {
  status: AccountSyncStatus;
  domains: DomainSyncResult[];
  error?: string;
}

export interface AccountConfig {
  id: string;
  provider: 'ovh';
  enabled?: boolean;
  token?: string; // Legacy access token
  credentials: OvhCredentials;
  domains: DomainConfig[];
}

export interface AppConfig {
  server: {
    port: number;
    host: string;
    logLevel: string;
    trustProxy?: boolean;
  };
  security: {
    apiKey: string;
    allowLegacyGlobalAccountTokens?: boolean;
  };
  ondemand: {
    enabled: boolean;
  };
  scheduler: {
    enabled: boolean;
    interval: number;
  };
  ipProviders: string[];
  accounts: AccountConfig[];
}
