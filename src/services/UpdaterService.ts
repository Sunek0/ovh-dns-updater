import { FastifyBaseLogger } from 'fastify';
import {
  AccountConfig,
  AccountSyncResult,
  AppConfig,
  CheckStatus,
  SyncTrigger,
} from '../types.js';
import { configuredSecrets, redactAccountResult, redactSecrets } from '../utils/redaction.js';
import { summarizeAccountResult, toPublicAccountResult } from '../utils/results.js';
import { IpService } from './IpService.js';
import { StateStore } from './StateStore.js';
import { OvhAccount } from './OvhAccount.js';

function overallStatus(details: Record<string, AccountSyncResult>): CheckStatus {
  const statuses = Object.values(details).map(result => result.status);
  if (statuses.length === 0 || statuses.every(status => status === 'success')) {
    return 'ok';
  }
  if (statuses.every(status => status === 'failed')) {
    return 'error';
  }
  return 'partial';
}

export class UpdaterService {
  private ipService: IpService;
  private accounts: Map<string, OvhAccount>; // id -> account
  private logger: FastifyBaseLogger;
  private stateStore?: StateStore;
  private readonly secrets: string[];
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    config: AppConfig,
    ipService: IpService,
    logger: FastifyBaseLogger,
    stateStore?: StateStore,
  ) {
    this.ipService = ipService;
    this.logger = logger;
    this.stateStore = stateStore;
    this.accounts = new Map();
    this.secrets = configuredSecrets(config);

    this.initializeAccounts(config.accounts);
  }

  private redact(value: string): string {
    return redactSecrets(value, this.secrets);
  }

  /**
   * Serializes sync operations so an on-demand request cannot overlap a
   * scheduled run (or another account sync) against OVH.
   */
  private enqueueSync<T>(task: () => Promise<T>): Promise<T> {
    const run = this.syncQueue.then(task, task);
    this.syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private initializeAccounts(accountsCfg: AccountConfig[]): void {
    for (const accCfg of accountsCfg) {
      if (accCfg.enabled === false) continue;

      try {
        const account = new OvhAccount(accCfg, this.logger);
        this.accounts.set(accCfg.id, account);
      } catch (err) {
        // Keep the public message free of raw error text, which may contain
        // credentials in future OVH client versions. The caller logs the
        // cause with full diagnostic context.
        throw new Error(
          `Failed to initialize account ${accCfg.id}`,
          { cause: err },
        );
      }
    }
  }

  /**
   * Observability is strictly best-effort: a bug in the state store must never
   * interrupt an IP check or an OVH update.
   */
  private updateState(update: (store: StateStore) => void): void {
    if (!this.stateStore) return;

    try {
      update(this.stateStore);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { error: this.redact(message) },
        'State store update failed',
      );
    }
  }

  private recordAccountResult(
    accountId: string,
    result: AccountSyncResult,
    ip: string,
    trigger: SyncTrigger,
  ): void {
    const safeResult = redactAccountResult(result, this.secrets);

    this.updateState(store => {
      const at = new Date();
      const subdomains = safeResult.domains.flatMap(domain => domain.subdomains);

      for (const subdomainResult of subdomains) {
        store.recordRecordResult({
          at,
          trigger,
          accountId,
          domain: subdomainResult.domain,
          subdomain: subdomainResult.subdomain,
          targetIp: ip,
          result: subdomainResult,
        });
      }

      for (const domainResult of safeResult.domains) {
        if (domainResult.refresh !== 'failed') continue;
        store.recordDomainError({
          at,
          trigger,
          accountId,
          domain: domainResult.domain,
          error: 'No se pudo refrescar la zona DNS en OVH',
        });
      }

      if (safeResult.error && subdomains.length === 0) {
        store.recordAccountError({ at, trigger, accountId, error: safeResult.error });
      }
    });
  }

  private recordAccountFailure(
    accountId: string,
    error: string,
    trigger: SyncTrigger,
  ): void {
    this.updateState(store => {
      store.recordAccountError({ trigger, accountId, error });
    });
  }

  async syncAll(
    force = false,
    providedIp?: string,
    trigger: SyncTrigger = 'ondemand',
  ): Promise<{
    ip: string;
    results: Record<string, string>;
    details: Record<string, AccountSyncResult>;
  }> {
    return this.enqueueSync(() => this.performSyncAll(force, providedIp, trigger));
  }

  private async resolveIp(
    providedIp: string | undefined,
    force: boolean,
    trigger: SyncTrigger,
  ): Promise<string> {
    if (providedIp !== undefined) {
      return providedIp;
    }

    try {
      return await this.ipService.getPublicIp(force);
    } catch (err) {
      const message = this.redact(err instanceof Error ? err.message : String(err));
      this.updateState(store => {
        store.recordIpCheck({ trigger, error: message });
      });
      throw err;
    }
  }

  private async performSyncAll(
    force: boolean,
    providedIp: string | undefined,
    trigger: SyncTrigger,
  ): Promise<{
    ip: string;
    results: Record<string, string>;
    details: Record<string, AccountSyncResult>;
  }> {
    this.logger.info({ force, trigger }, 'Starting global sync');

    const currentIp = await this.resolveIp(providedIp, force, trigger);

    this.updateState(store => {
      store.recordIpCheck({ trigger, ip: currentIp });
    });

    this.logger.info(
      { ip: currentIp, force, trigger },
      'Public IP resolved for global sync',
    );

    const results: Record<string, string> = {};
    const details: Record<string, AccountSyncResult> = {};

    // Update all accounts in parallel. Each OvhAccount verifies whether the
    // target actually differs in OVH before writing.
    const promises = Array.from(this.accounts.entries()).map(async ([id, account]) => {
      try {
        const result = await account.updateAccount(currentIp);
        this.recordAccountResult(id, result, currentIp, trigger);
        details[id] = toPublicAccountResult(result);
        results[id] = summarizeAccountResult(result);
      } catch (err) {
        const message = this.redact(err instanceof Error ? err.message : String(err));
        this.logger.error(
          { accountId: id, error: message },
          'Account update failed',
        );
        details[id] = { status: 'failed', domains: [], error: 'Account sync failed' };
        results[id] = 'Failed';
        this.recordAccountFailure(id, message, trigger);
      }
    });

    await Promise.all(promises);

    const stateErrors = Object.values(details)
      .map(result => result.error)
      .filter((error): error is string => Boolean(error));
    this.updateState(store => {
      store.recordSyncOutcome({
        status: overallStatus(details),
        error: stateErrors.length > 0 ? stateErrors.join('; ') : null,
      });
    });

    return { ip: currentIp, results, details };
  }

  hasAccount(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  async syncAccount(
    accountId: string,
    providedIp?: string,
    trigger: SyncTrigger = 'ondemand',
  ): Promise<{
    ip: string;
    result: AccountSyncResult;
  }> {
    return this.enqueueSync(
      () => this.performSyncAccount(accountId, providedIp, trigger),
    );
  }

  private async performSyncAccount(
    accountId: string,
    providedIp: string | undefined,
    trigger: SyncTrigger,
  ): Promise<{
    ip: string;
    result: AccountSyncResult;
  }> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const currentIp = await this.resolveIp(providedIp, false, trigger);

    this.updateState(store => {
      store.recordIpCheck({ trigger, ip: currentIp });
    });

    let result: AccountSyncResult;
    try {
      result = await account.updateAccount(currentIp);
    } catch (err) {
      const message = this.redact(err instanceof Error ? err.message : String(err));
      this.logger.error(
        { accountId, error: message },
        'Account update failed',
      );
      this.recordAccountFailure(accountId, message, trigger);
      this.updateState(store => {
        store.recordSyncOutcome({ status: 'error', error: 'Account sync failed' });
      });
      throw err;
    }

    this.recordAccountResult(accountId, result, currentIp, trigger);
    this.updateState(store => {
      store.recordSyncOutcome({
        status: result.status === 'success'
          ? 'ok'
          : result.status === 'failed' ? 'error' : 'partial',
        error: result.error ? this.redact(result.error) : null,
      });
    });

    return { ip: currentIp, result: toPublicAccountResult(result) };
  }

  getPublicIp(force = false) {
    return this.ipService.getPublicIp(force);
  }
}
