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

    // 3. Update all accounts in parallel
    // Each OvhAccount.updateAccount will verify if the IP is actually different in OVH before writing
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
