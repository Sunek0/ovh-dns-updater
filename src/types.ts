import 'fastify';

export type AuthContext =
  | { kind: 'master' }
  | { kind: 'account'; accountId: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const EVENT_ACTIONS = [
  'updated',
  'unchanged',
  'error',
  'public_ip_changed',
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];
export type SyncTrigger = 'startup' | 'scheduler' | 'ondemand';
export type RecordStateStatus = 'pending' | 'ok' | 'updated' | 'error';
export type CheckStatus = 'ok' | 'partial' | 'error';

export interface StatusEvent {
  id: number;
  timestamp: string;
  trigger: SyncTrigger;
  accountId: string | null;
  domain: string | null;
  subdomain: string | null;
  fqdn: string | null;
  action: EventAction;
  oldValue: string | null;
  newValue: string | null;
  message: string | null;
}

export interface StatusRecord {
  fqdn: string;
  type: 'A';
  subdomain: string;
  initialValue: string | null;
  currentValue: string | null;
  status: RecordStateStatus;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  lastError: string | null;
}

export interface StatusDomain {
  name: string;
  records: StatusRecord[];
}

export interface StatusAccount {
  id: string;
  domains: StatusDomain[];
}

export interface StatusSnapshot {
  generatedAt: string;
  startedAt: string;
  uptimeSeconds: number;
  initialIp: string | null;
  currentIp: string | null;
  lastCheckAt: string | null;
  lastCheckResult: {
    status: CheckStatus;
    ip: string | null;
    error: string | null;
  } | null;
  nextCheckAt: string | null;
  scheduler: {
    enabled: boolean;
    intervalSeconds: number;
  };
  ondemand: {
    enabled: boolean;
  };
  ipProvider: {
    provider: string | null;
    lastDetectionAt: string | null;
    failures: ProviderFailure[];
  };
  counters: {
    checks: number;
    updates: number;
    errors: number;
  };
  ui: {
    refreshSeconds: number;
    historySize: number;
  };
  accounts: StatusAccount[];
}

export interface EventFilter {
  limit?: number;
  account?: string;
  domain?: string;
  type?: EventAction;
}

export interface EventsResult {
  events: StatusEvent[];
  total: number;
}

export type StateChangeListener = (event?: StatusEvent) => void;

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

export type SubdomainSyncStatus =
  | 'updated'
  | 'unchanged'
  | 'not-found'
  | 'partial'
  | 'failed';

export type OvhRecordStrategy = 'all' | 'single' | 'fail';

export interface RecordSyncResult {
  recordId: number;
  previousTarget?: string;
  status: 'updated' | 'unchanged' | 'failed';
  error?: string;
}

export interface SubdomainSyncResult {
  domain: string;
  subdomain: string;
  status: SubdomainSyncStatus;
  error?: string;
  records?: RecordSyncResult[];
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
  recordStrategy?: OvhRecordStrategy;
  credentials: OvhCredentials;
  domains: DomainConfig[];
}

export interface UiConfig {
  enabled: boolean;
  historySize: number;
  refreshSeconds: number;
}

export interface ProviderFailure {
  provider: string;
  error: string;
}

export interface IpDetectionReport {
  ip: string | null;
  provider: string | null;
  failures: ProviderFailure[];
  detectedAt: Date;
}

export interface AppConfig {
  server: {
    port: number;
    host: string;
    logLevel: LogLevel;
    trustProxy?: boolean;
  };
  security: {
    apiKey: string;
    allowLegacyGlobalAccountTokens?: boolean;
    allowInsecureIpProviders?: boolean;
  };
  ondemand: {
    enabled: boolean;
  };
  scheduler: {
    enabled: boolean;
    interval: number;
  };
  ui: UiConfig;
  ipProviders: string[];
  accounts: AccountConfig[];
}
