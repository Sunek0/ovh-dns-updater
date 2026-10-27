import type {
  DomainConfig,
  IpDetectionReport,
  ProviderFailure,
  SubdomainSyncResult,
} from '../types.js';
import { normalizeSubdomain, qualifyDomain } from '../utils/subdomains.js';

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

export interface StateStoreOptions {
  startedAt?: Date;
  now?: () => Date;
  historySize?: number;
  refreshSeconds?: number;
  schedulerEnabled?: boolean;
  schedulerIntervalSeconds?: number;
  ondemandEnabled?: boolean;
  accounts?: Array<{
    id: string;
    domains: DomainConfig[];
  }>;
}

export type IpCheckInput =
  | { trigger: SyncTrigger; at?: Date; ip: string }
  | { trigger: SyncTrigger; at?: Date; error: string };

export interface RecordResultInput {
  trigger: SyncTrigger;
  at?: Date;
  accountId: string;
  domain: string;
  subdomain: string;
  targetIp: string;
  result: SubdomainSyncResult;
}

export interface AccountErrorInput {
  trigger: SyncTrigger;
  at?: Date;
  accountId: string;
  error: string;
}

export interface DomainErrorInput {
  trigger: SyncTrigger;
  at?: Date;
  accountId: string;
  domain: string;
  error: string;
}

export interface SyncOutcomeInput {
  at?: Date;
  status: CheckStatus;
  error?: string | null;
}

interface InternalRecord {
  accountId: string;
  domain: string;
  subdomain: string;
  fqdn: string;
  initialValue: string | null;
  currentValue: string | null;
  status: RecordStateStatus;
  lastCheckedAt: Date | null;
  lastChangedAt: Date | null;
  lastError: string | null;
}

interface NewEvent {
  timestamp: Date;
  trigger: SyncTrigger;
  accountId?: string | null;
  domain?: string | null;
  subdomain?: string | null;
  fqdn?: string | null;
  action: EventAction;
  oldValue?: string | null;
  newValue?: string | null;
  message?: string | null;
}

const DEFAULT_HISTORY_SIZE = 500;
const DEFAULT_REFRESH_SECONDS = 10;
const DEFAULT_SCHEDULER_INTERVAL_SECONDS = 600;
const DEFAULT_EVENT_LIMIT = 100;

function recordKey(accountId: string, domain: string, subdomain: string): string {
  return `${accountId}\u0000${domain}\u0000${subdomain}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function uniqueValues(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function errorMessage(result: SubdomainSyncResult): string {
  if (result.error) return result.error;
  if (result.status === 'not-found') return 'No se encontró el registro A en OVH';
  if (result.status === 'partial') return 'No se pudieron actualizar todos los registros A';
  return 'No se pudo actualizar el registro A';
}

/**
 * In-memory observability store for the updater. It intentionally knows nothing
 * about OVH credentials or the application config object: only account ids,
 * domains and subdomains are copied into it.
 *
 * All methods are synchronous and best-effort. Callers that must never fail
 * because of observability (the DNS update path) additionally guard calls.
 */
export class StateStore {
  private readonly now: () => Date;
  private readonly startedAt: Date;
  private readonly historySize: number;
  private readonly refreshSeconds: number;
  private readonly schedulerEnabled: boolean;
  private readonly schedulerIntervalSeconds: number;
  private readonly ondemandEnabled: boolean;

  private readonly accountIds: string[] = [];
  private readonly domainsByAccount = new Map<string, string[]>();
  private readonly records = new Map<string, InternalRecord>();

  private initialIp: string | null = null;
  private currentIp: string | null = null;
  private lastCheckAt: Date | null = null;
  private lastCheckResult: StatusSnapshot['lastCheckResult'] = null;
  private nextCheckAt: Date | null = null;
  private provider: string | null = null;
  private lastDetectionAt: Date | null = null;
  private providerFailures: ProviderFailure[] = [];

  private checks = 0;
  private updates = 0;
  private errors = 0;

  private events: StatusEvent[] = [];
  private nextEventId = 1;

  constructor(options: StateStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.startedAt = options.startedAt
      ? new Date(options.startedAt.getTime())
      : this.now();
    this.historySize = Math.max(1, Math.trunc(options.historySize ?? DEFAULT_HISTORY_SIZE));
    this.refreshSeconds = Math.max(
      1,
      Math.trunc(options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS),
    );
    this.schedulerEnabled = options.schedulerEnabled ?? false;
    this.schedulerIntervalSeconds = Math.max(
      1,
      options.schedulerIntervalSeconds ?? DEFAULT_SCHEDULER_INTERVAL_SECONDS,
    );
    this.ondemandEnabled = options.ondemandEnabled ?? false;

    if (this.schedulerEnabled) {
      this.nextCheckAt = new Date(
        this.startedAt.getTime() + this.schedulerIntervalSeconds * 1000,
      );
    }

    for (const account of options.accounts ?? []) {
      this.ensureAccount(account.id);
      for (const domain of account.domains) {
        this.ensureDomain(account.id, domain.name);
        for (const configured of domain.subdomains) {
          const subdomain = normalizeSubdomain(configured);
          if (subdomain === undefined) continue;
          this.ensureRecord(account.id, domain.name, subdomain);
        }
      }
    }
  }

  recordIpDetection(report: IpDetectionReport): void {
    this.provider = report.provider;
    this.lastDetectionAt = new Date(report.detectedAt.getTime());
    this.providerFailures = report.failures.map(failure => ({ ...failure }));
  }

  recordIpCheck(input: IpCheckInput): void {
    const at = this.resolveDate(input.at);
    this.checks += 1;
    this.lastCheckAt = at;

    if ('error' in input) {
      this.lastCheckResult = { status: 'error', ip: null, error: input.error };
      this.errors += 1;
      this.pushEvent({
        timestamp: at,
        trigger: input.trigger,
        action: 'error',
        message: input.error,
      });
      return;
    }

    const previousIp = this.currentIp;
    this.currentIp = input.ip;
    if (this.initialIp === null) {
      this.initialIp = input.ip;
    }
    this.lastCheckResult = { status: 'ok', ip: input.ip, error: null };

    if (this.schedulerEnabled && input.trigger !== 'ondemand') {
      this.nextCheckAt = new Date(
        at.getTime() + this.schedulerIntervalSeconds * 1000,
      );
    }

    if (previousIp !== null && previousIp !== input.ip) {
      this.pushEvent({
        timestamp: at,
        trigger: input.trigger,
        action: 'public_ip_changed',
        oldValue: previousIp,
        newValue: input.ip,
      });
    }
  }

  recordRecordResult(input: RecordResultInput): void {
    const at = this.resolveDate(input.at);
    const record = this.ensureRecord(input.accountId, input.domain, input.subdomain);
    const previousValues = uniqueValues(
      (input.result.records ?? []).map(result => result.previousTarget),
    );
    const previousDisplay = previousValues.length > 0
      ? previousValues.join(', ')
      : null;
    const observedValues = uniqueValues(
      (input.result.records ?? []).map(result =>
        result.status === 'failed' ? result.previousTarget : input.targetIp,
      ),
    );
    const observedDisplay = observedValues.length > 0
      ? observedValues.join(', ')
      : null;

    if (record.initialValue === null && previousDisplay !== null) {
      record.initialValue = previousDisplay;
    }

    let action: EventAction;
    let newValue: string | null = null;
    let error: string | null = null;
    let didUpdate = false;

    switch (input.result.status) {
      case 'updated':
        record.status = 'updated';
        record.currentValue = input.targetIp;
        record.lastError = null;
        action = 'updated';
        newValue = input.targetIp;
        didUpdate = true;
        break;
      case 'unchanged':
        record.status = 'ok';
        record.currentValue = input.targetIp;
        record.lastError = null;
        action = 'unchanged';
        newValue = input.targetIp;
        break;
      case 'partial':
        record.status = 'error';
        record.currentValue = observedDisplay ?? record.currentValue;
        error = errorMessage(input.result);
        record.lastError = error;
        action = 'error';
        newValue = input.targetIp;
        didUpdate = (input.result.records ?? []).some(
          result => result.status === 'updated',
        );
        break;
      case 'failed':
        record.status = 'error';
        if (record.currentValue === null) {
          record.currentValue = observedDisplay ?? previousDisplay;
        }
        error = errorMessage(input.result);
        record.lastError = error;
        action = 'error';
        break;
      case 'not-found':
        record.status = 'error';
        error = errorMessage(input.result);
        record.lastError = error;
        action = 'error';
        break;
    }

    record.lastCheckedAt = at;
    if (didUpdate) {
      record.lastChangedAt = at;
      this.updates += 1;
    }
    if (record.status === 'error') {
      this.errors += 1;
    }

    this.pushEvent({
      timestamp: at,
      trigger: input.trigger,
      accountId: input.accountId,
      domain: input.domain,
      subdomain: input.subdomain,
      fqdn: record.fqdn,
      action,
      oldValue: previousDisplay,
      newValue,
      message: error,
    });
  }

  recordAccountError(input: AccountErrorInput): void {
    const at = this.resolveDate(input.at);

    for (const record of this.records.values()) {
      if (record.accountId !== input.accountId) continue;
      record.status = 'error';
      record.lastCheckedAt = at;
      record.lastError = input.error;
    }

    this.errors += 1;
    this.pushEvent({
      timestamp: at,
      trigger: input.trigger,
      accountId: input.accountId,
      action: 'error',
      message: input.error,
    });
  }

  recordDomainError(input: DomainErrorInput): void {
    const at = this.resolveDate(input.at);
    this.ensureDomain(input.accountId, input.domain);
    this.errors += 1;
    this.pushEvent({
      timestamp: at,
      trigger: input.trigger,
      accountId: input.accountId,
      domain: input.domain,
      action: 'error',
      message: input.error,
    });
  }

  recordSyncOutcome(input: SyncOutcomeInput): void {
    this.lastCheckAt = this.resolveDate(input.at);
    this.lastCheckResult = {
      status: input.status,
      ip: this.currentIp,
      error: input.error ?? null,
    };
  }

  getSnapshot(): StatusSnapshot {
    const now = this.now();
    const accounts = this.accountIds.map(accountId => ({
      id: accountId,
      domains: (this.domainsByAccount.get(accountId) ?? []).map(domain => ({
        name: domain,
        records: [...this.records.values()]
          .filter(record => record.accountId === accountId && record.domain === domain)
          .map(record => this.toStatusRecord(record)),
      })),
    }));

    return {
      generatedAt: now.toISOString(),
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.max(
        0,
        Math.floor((now.getTime() - this.startedAt.getTime()) / 1000),
      ),
      initialIp: this.initialIp,
      currentIp: this.currentIp,
      lastCheckAt: iso(this.lastCheckAt),
      lastCheckResult: this.lastCheckResult
        ? { ...this.lastCheckResult }
        : null,
      nextCheckAt: iso(this.nextCheckAt),
      scheduler: {
        enabled: this.schedulerEnabled,
        intervalSeconds: this.schedulerIntervalSeconds,
      },
      ondemand: {
        enabled: this.ondemandEnabled,
      },
      ipProvider: {
        provider: this.provider,
        lastDetectionAt: iso(this.lastDetectionAt),
        failures: this.providerFailures.map(failure => ({ ...failure })),
      },
      counters: {
        checks: this.checks,
        updates: this.updates,
        errors: this.errors,
      },
      ui: {
        refreshSeconds: this.refreshSeconds,
        historySize: this.historySize,
      },
      accounts,
    };
  }

  getEvents(filter: EventFilter = {}): EventsResult {
    const requestedLimit = filter.limit ?? DEFAULT_EVENT_LIMIT;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), this.historySize))
      : DEFAULT_EVENT_LIMIT;

    const filtered = this.events.filter(event => {
      if (filter.account && event.accountId !== filter.account) return false;
      if (filter.domain && event.domain !== filter.domain) return false;
      if (filter.type && event.action !== filter.type) return false;
      return true;
    });

    return {
      events: filtered.slice(-limit).reverse().map(event => ({ ...event })),
      total: filtered.length,
    };
  }

  private resolveDate(value?: Date): Date {
    return value ? new Date(value.getTime()) : this.now();
  }

  private ensureAccount(accountId: string): void {
    if (this.domainsByAccount.has(accountId)) return;
    this.accountIds.push(accountId);
    this.domainsByAccount.set(accountId, []);
  }

  private ensureDomain(accountId: string, domain: string): void {
    this.ensureAccount(accountId);
    const domains = this.domainsByAccount.get(accountId)!;
    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }

  private ensureRecord(
    accountId: string,
    domain: string,
    subdomain: string,
  ): InternalRecord {
    this.ensureDomain(accountId, domain);
    const key = recordKey(accountId, domain, subdomain);
    let record = this.records.get(key);
    if (!record) {
      record = {
        accountId,
        domain,
        subdomain,
        fqdn: qualifyDomain(domain, subdomain),
        initialValue: null,
        currentValue: null,
        status: 'pending',
        lastCheckedAt: null,
        lastChangedAt: null,
        lastError: null,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private toStatusRecord(record: InternalRecord): StatusRecord {
    return {
      fqdn: record.fqdn,
      type: 'A',
      subdomain: record.subdomain,
      initialValue: record.initialValue,
      currentValue: record.currentValue,
      status: record.status,
      lastCheckedAt: iso(record.lastCheckedAt),
      lastChangedAt: iso(record.lastChangedAt),
      lastError: record.lastError,
    };
  }

  private pushEvent(event: NewEvent): void {
    this.events.push({
      id: this.nextEventId,
      timestamp: event.timestamp.toISOString(),
      trigger: event.trigger,
      accountId: event.accountId ?? null,
      domain: event.domain ?? null,
      subdomain: event.subdomain ?? null,
      fqdn: event.fqdn ?? null,
      action: event.action,
      oldValue: event.oldValue ?? null,
      newValue: event.newValue ?? null,
      message: event.message ?? null,
    });
    this.nextEventId += 1;

    if (this.events.length > this.historySize) {
      this.events.splice(0, this.events.length - this.historySize);
    }
  }
}
