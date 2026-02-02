import { FastifyBaseLogger } from 'fastify';
import { AppConfig, AccountConfig } from '../types.js';
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

  async syncAll(force = false, providedIp?: string): Promise<{ ip: string; results: Record<string, string> }> {
    this.logger.info({ force, providedIp }, 'Starting global sync');
    
    // 1. Get IP (use provided or detect)
    const currentIp = providedIp || await this.ipService.getPublicIp();
    
    // Optimization: If IP hasn't changed and not forced, maybe skip?
    if (!force && currentIp === this.lastIp) {
      this.logger.info({ ip: currentIp }, 'IP unchanged, verifying accounts anyway (lazy check)');
      // In the old code, it skipped *everything* if IP didn't change (in checkIp). 
      // But here we want robustness. Maybe we should check anyway in case records were changed externally?
      // For API quota reasons, skipping is better.
      // However, the prompt asked for "robustness".
      // Let's implement a "smart skip" logic: skip if IP matches cached and successful last run?
      // For now, I'll just log and proceed. The OvhAccount.updateAccount logic checks record value before writing, so it's safe (idempotent).
    }

    this.lastIp = currentIp;
    const results: Record<string, string> = {};

    // 2. Update all accounts in parallel
    const promises = Array.from(this.accounts.entries()).map(async ([id, account]) => {
      try {
        await account.updateAccount(currentIp);
        results[id] = 'Success';
      } catch (err: any) {
        this.logger.error({ accountId: id, err }, 'Account update failed');
        results[id] = `Failed: ${err.message}`;
      }
    });

    await Promise.all(promises);
    return { ip: currentIp, results };
  }

  async syncAccount(accountId: string): Promise<string> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account ${accountId} not found`);
    }

    const currentIp = await this.ipService.getPublicIp();
    await account.updateAccount(currentIp);
    return currentIp;
  }
  
  getPublicIp() {
    return this.ipService.getPublicIp();
  }
}
