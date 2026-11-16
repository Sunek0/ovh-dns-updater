import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import schedulerPlugin from '../src/plugins/scheduler.js';
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

describe('scheduler plugin', () => {
  const successResult = { status: 'success' as const, domains: [] };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function build(interval = 600) {
    const app = Fastify({ logger: false });
    const syncAll = vi.fn().mockResolvedValue(successResult);

    app.decorate('config', {
      scheduler: { enabled: true, interval },
    } as any);
    app.decorate('updaterService', { syncAll } as any);

    await app.register(schedulerPlugin);
    await app.ready();

    return { app, syncAll };
  }

  const flushScheduler = () => vi.advanceTimersByTimeAsync(0);

  it('runs an initial sync and then periodic syncs', async () => {
    const { app, syncAll } = await build();

    await vi.advanceTimersByTimeAsync(100);
    expect(syncAll).toHaveBeenCalledWith(false, undefined, 'startup');

    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncAll).toHaveBeenCalledWith(false, undefined, 'scheduler');

    await flushScheduler();
    await app.close();
  }, 15_000);

  it('skips a run while the previous sync is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const app = Fastify({ logger: false });
    const syncAll = vi.fn()
      .mockImplementationOnce(() => gate.then(() => successResult))
      .mockResolvedValue(successResult);

    app.decorate('config', {
      scheduler: { enabled: true, interval: 600 },
    } as any);
    app.decorate('updaterService', { syncAll } as any);
    await app.register(schedulerPlugin);
    await app.ready();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(syncAll).toHaveBeenCalledTimes(1);

    release();
    await flushScheduler();
    await app.close();
  }, 15_000);

  it('stops scheduling after close', async () => {
    const { app, syncAll } = await build();

    await vi.advanceTimersByTimeAsync(100);
    await flushScheduler();
    await app.close();
    await vi.advanceTimersByTimeAsync(1_200_000);

    expect(syncAll).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('waits for an in-flight sync before closing', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const app = Fastify({ logger: false });
    const syncAll = vi.fn().mockImplementationOnce(
      () => gate.then(() => successResult),
    );

    app.decorate('config', {
      scheduler: { enabled: true, interval: 600 },
    } as any);
    app.decorate('updaterService', { syncAll } as any);
    await app.register(schedulerPlugin);
    await app.ready();

    await vi.advanceTimersByTimeAsync(100);
    expect(syncAll).toHaveBeenCalledTimes(1);

    let closed = false;
    const closePromise = app.close().then(() => {
      closed = true;
    });

    await flushScheduler();
    expect(closed).toBe(false);

    release();
    await closePromise;
    expect(closed).toBe(true);
  }, 15_000);
});
