import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdaterService } from '../src/services/UpdaterService.js';

const logger: any = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

const ipService: any = {
  getPublicIp: vi.fn(),
};

const validCredentials = {
  endpoint: 'ovh-eu',
  appKey: 'APP_KEY_SHOULD_NOT_LEAK',
  appSecret: 'APP_SECRET_SHOULD_NOT_LEAK',
  consumerKey: 'CONSUMER_KEY_SHOULD_NOT_LEAK',
};

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc1',
    provider: 'ovh',
    enabled: true,
    credentials: validCredentials,
    domains: [],
    ...overrides,
  };
}

describe('UpdaterService initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails fast when an enabled account cannot be initialized', () => {
    // Configuration validation rejects unknown endpoints in real startup.
    // This test isolates the UpdaterService safety net in case OvhAccount
    // starts throwing for another initialization reason.
    const config: any = {
      accounts: [account({
        id: 'bad-account',
        credentials: { ...validCredentials, endpoint: 'ovh-typo' },
      })],
    };

    let thrown: Error | undefined;
    try {
      new UpdaterService(config, ipService, logger);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown?.message).toMatch(/Failed to initialize account bad-account/);
    expect(thrown?.message).not.toContain(validCredentials.appKey);
    expect(thrown?.message).not.toContain(validCredentials.appSecret);
    expect(thrown?.message).not.toContain(validCredentials.consumerKey);
    expect((thrown as any)?.cause).toBeInstanceOf(Error);
  });

  it('does not initialize disabled accounts', () => {
    // Configuration validation still rejects structural errors in disabled
    // accounts; this test covers the runtime initialization skip.
    const config: any = {
      accounts: [account({
        id: 'disabled-account',
        enabled: false,
        credentials: { ...validCredentials, endpoint: 'ovh-typo' },
      })],
    };

    const service = new UpdaterService(config, ipService, logger);
    expect(service.hasAccount('disabled-account')).toBe(false);
  });

  it('initializes enabled accounts with a supported endpoint', () => {
    const config: any = { accounts: [account()] };
    const service = new UpdaterService(config, ipService, logger);
    expect(service.hasAccount('acc1')).toBe(true);
  });
});
