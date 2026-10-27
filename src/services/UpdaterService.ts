import { FastifyBaseLogger } from 'fastify';
import { AccountConfig, AccountSyncResult, AppConfig } from '../types.js';
import { summarizeAccountResult } from '../utils/results.js';
import { IpService } from './IpService.js';
import { OvhAccount } from './OvhAccount.js';

export class UpdaterService {
  private ipService: IpService;
  private accounts: Map<string, OvhAccount>; // id -> account
  private logger: FastifyBaseLogger;
  private lastIp: string | null = null;

  constructor(config: AppConfig, ipService: IpService, logger: FastifyBaseLogger) {
    this.ipService = ipService;
    this.logger = logger;
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

  async syncAll(force = false, providedIp?: string): Promise<{
    ip: string;
    results: Record<string, string>;
    details: Record<string, AccountSyncResult>;
  }> {
    this.logger.info({ force, providedIp }, 'Starting global sync');
    
    // 1. Get IP (use provided or detect)
    const currentIp = providedIp || await this.ipService.getPublicIp();
    
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
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error({ accountId: id, err }, 'Account update failed');
        details[id] = { status: 'failed', domains: [], error: message };
        results[id] = `Failed: ${message}`;
      }
    });

    await Promise.all(promises);
    return { ip: currentIp, results, details };
  }

  hasAccount(accountId: string): boolean {
    return this.accounts.has(accountId);
  }

  async syncAccount(accountId: string, providedIp?: string): Promise<{
    ip: string;
    result: AccountSyncResult;
  }> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const currentIp = providedIp ?? await this.ipService.getPublicIp();
    const result = await account.updateAccount(currentIp);
    return { ip: currentIp, result };
  }
  
  getPublicIp() {
    return this.ipService.getPublicIp();
  }
}
