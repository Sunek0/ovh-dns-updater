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
