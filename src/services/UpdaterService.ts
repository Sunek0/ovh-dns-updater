import { FastifyBaseLogger } from 'fastify';
import { AccountConfig, AccountSyncResult, AppConfig } from '../types.js';
import { summarizeAccountResult } from '../utils/results.js';
import { IpService } from './IpService.js';
import {
  CheckStatus,
  StateStore,
  SyncTrigger,
} from './StateStore.js';
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
  private lastIp: string | null = null;

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

    this.initializeAccounts(config.accounts);
  }

  private initializeAccounts(accountsCfg: AccountConfig[]) {
    for (const accCfg of accountsCfg) {
      if (accCfg.enabled === false) continue;

      try {
        const account = new OvhAccount(accCfg, this.logger);
        this.accounts.set(accCfg.id, account);
      } catch (err) {
        this.logger.error({ err, accountId: accCfg.id }, 'Failed to initialize account');
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
      this.logger.warn({ err }, 'State store update failed');
    }
  }

  private recordAccountResult(
    accountId: string,
    result: AccountSyncResult,
    ip: string,
    trigger: SyncTrigger,
  ): void {
    this.updateState(store => {
      const at = new Date();
      const subdomains = result.domains.flatMap(domain => domain.subdomains);

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

      for (const domainResult of result.domains) {
        if (domainResult.refresh !== 'failed') continue;
        store.recordDomainError({
          at,
          trigger,
          accountId,
          domain: domainResult.domain,
          error: 'No se pudo refrescar la zona DNS en OVH',
        });
      }

      if (result.error && subdomains.length === 0) {
        store.recordAccountError({ at, trigger, accountId, error: result.error });
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
    this.logger.info({ force, providedIp, trigger }, 'Starting global sync');

    // 1. Get IP (use provided or detect)
    let currentIp: string;
    try {
      currentIp = providedIp || await this.ipService.getPublicIp();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateState(store => {
        store.recordIpCheck({ trigger, error: message });
      });
      throw err;
    }

    this.updateState(store => {
      store.recordIpCheck({ trigger, ip: currentIp });
    });

    // 2. Logic for skipping or verifying
    if (!force && currentIp === this.lastIp) {
      this.logger.info({ ip: currentIp }, 'IP matches last detected IP. Verifying OVH consistency anyway.');
    } else if (force) {
      this.logger.info({ ip: currentIp }, 'Forcing global sync regardless of last IP.');
    } else {
      this.logger.info({ oldIp: this.lastIp, newIp: currentIp }, 'IP change detected or initial sync.');
    }

    this.lastIp = currentIp;
    const results: Record<string, string> = {};
    const details: Record<string, AccountSyncResult> = {};

    // 3. Update all accounts in parallel
    // Each OvhAccount.updateAccount verifies whether the IP actually differs in OVH before writing.
    const promises = Array.from(this.accounts.entries()).map(async ([id, account]) => {
      try {
        const result = await account.updateAccount(currentIp);
        details[id] = result;
        results[id] = summarizeAccountResult(result);
        this.recordAccountResult(id, result, currentIp, trigger);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ accountId: id, err }, 'Account update failed');
        details[id] = { status: 'failed', domains: [], error: message };
        results[id] = `Failed: ${message}`;
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
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    let currentIp: string;
    try {
      currentIp = providedIp ?? await this.ipService.getPublicIp();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.updateState(store => {
        store.recordIpCheck({ trigger, error: message });
      });
      throw err;
    }

    this.updateState(store => {
      store.recordIpCheck({ trigger, ip: currentIp });
    });

    let result: AccountSyncResult;
    try {
      result = await account.updateAccount(currentIp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordAccountFailure(accountId, message, trigger);
      this.updateState(store => {
        store.recordSyncOutcome({ status: 'error', error: message });
      });
      throw err;
    }

    this.recordAccountResult(accountId, result, currentIp, trigger);
    this.updateState(store => {
      store.recordSyncOutcome({
        status: result.status === 'success'
          ? 'ok'
          : result.status === 'failed' ? 'error' : 'partial',
        error: result.error ?? null,
      });
    });

    return { ip: currentIp, result };
  }

  getPublicIp() {
    return this.ipService.getPublicIp();
  }
}
