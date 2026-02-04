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
