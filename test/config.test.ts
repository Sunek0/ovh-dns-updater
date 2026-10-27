import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config.js';

const validConfig = () => ({
  server: {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
  },
  security: {
    apiKey: 'master-token',
  },
  ondemand: {
    enabled: true,
  },
  scheduler: {
    enabled: true,
    interval: 600,
  },
  ipProviders: ['https://api.ipify.org'],
  accounts: [
    {
      id: 'acc1',
      provider: 'ovh',
      token: 'account-token',
      credentials: {
        endpoint: 'ovh-eu',
        appKey: 'key',
        appSecret: 'secret',
        consumerKey: 'consumer',
      },
      domains: [
        {
          name: 'example.com',
          subdomains: ['@', 'www'],
        },
      ],
    },
  ],
});

describe('configuration validation', () => {
  it('accepts a valid configuration and applies defaults', () => {
    const raw = validConfig();
    const config = validateConfig(raw);

    expect(config.security.allowLegacyGlobalAccountTokens).toBe(false);
    expect(config.scheduler.interval).toBe(600);
    expect(config.accounts[0].provider).toBe('ovh');
    expect(config.accounts[0].domains[0].subdomains).toEqual(['@', 'www']);
  });

  it('applies optional defaults', () => {
    const raw = validConfig();
    const config = validateConfig({
      server: {},
      security: { apiKey: 'master-token' },
      ipProviders: ['http://ip.local'],
    });

    expect(config.server).toEqual({
      port: 3000,
      host: '0.0.0.0',
      logLevel: 'info',
      trustProxy: false,
    });
    expect(config.ondemand.enabled).toBe(true);
    expect(config.scheduler.enabled).toBe(true);
    expect(config.ui).toEqual({
      enabled: true,
      historySize: 500,
      refreshSeconds: 10,
    });
    expect(config.accounts).toEqual([]);
  });

  it('accepts a custom UI configuration', () => {
    const raw = validConfig();
    (raw as any).ui = {
      enabled: false,
      historySize: 25,
      refreshSeconds: 5,
    };

    const config = validateConfig(raw);
    expect(config.ui).toEqual({
      enabled: false,
      historySize: 25,
      refreshSeconds: 5,
    });
  });

  it('rejects an invalid UI history size', () => {
    const raw = validConfig();
    (raw as any).ui = { historySize: 0 };

    expect(() => validateConfig(raw)).toThrow(/ui\.historySize/);
  });

  it('rejects an invalid UI refresh interval', () => {
    const raw = validConfig();
    (raw as any).ui = { refreshSeconds: 0 };

    expect(() => validateConfig(raw)).toThrow(/ui\.refreshSeconds/);
  });

  it('rejects a missing API key', () => {
    const raw = validConfig();
    (raw as any).security = {};

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey/);
  });

  it('rejects a non-positive scheduler interval', () => {
    const raw = validConfig();
    raw.scheduler.interval = 0;

    expect(() => validateConfig(raw)).toThrow(/scheduler\.interval/);
  });

  it('rejects duplicate account ids', () => {
    const raw = validConfig();
    raw.accounts.push({
      ...raw.accounts[0],
      token: 'other-token',
    });

    expect(() => validateConfig(raw)).toThrow(/accounts\.1\.id: must be unique/);
  });

  it('rejects duplicate account tokens', () => {
    const raw = validConfig();
    raw.accounts.push({
      ...raw.accounts[0],
      id: 'acc2',
    });

    expect(() => validateConfig(raw)).toThrow(/accounts\.1\.token: must be unique/);
  });

  it('rejects an account token that equals the API key', () => {
    const raw = validConfig();
    raw.accounts[0].token = raw.security.apiKey;

    expect(() => validateConfig(raw)).toThrow(/must differ from security\.apiKey/);
  });

  it('rejects non-http IP providers', () => {
    const raw = validConfig();
    raw.ipProviders = ['file:///etc/passwd'];

    expect(() => validateConfig(raw)).toThrow(/ipProviders\.0/);
  });

  it('accepts the production-style config with wildcard subdomains', () => {
    const raw = {
      server: { port: 3000, host: '0.0.0.0', logLevel: 'info' },
      security: { apiKey: 'xxx' },
      ondemand: { enabled: true },
      scheduler: { enabled: true, interval: 600 },
      ipProviders: [
        'https://api.ipify.org',
        'https://ifconfig.me/ip',
        'https://icanhazip.com',
      ],
      accounts: [
        {
          id: 'personal-account',
          provider: 'ovh',
          enabled: true,
          credentials: {
            endpoint: 'ovh-eu',
            appKey: 'xxx',
            appSecret: 'xxx',
            consumerKey: 'xxx',
          },
          domains: [
            { name: 'jacko.es', subdomains: ['@', '*'] },
            { name: 'suneko.es', subdomains: ['@', '*'] },
            { name: 'efimero.ovh', subdomains: ['@', '*'] },
            { name: 'danielbarreiro.es', subdomains: ['@', '*'] },
            { name: 'barreirofuentes.es', subdomains: ['@', '*'] },
          ],
        },
        {
          id: 'puertacartuja-account',
          provider: 'ovh',
          enabled: true,
          credentials: {
            endpoint: 'ovh-eu',
            appKey: 'xxx',
            appSecret: 'xxx',
            consumerKey: 'xxx',
          },
          domains: [
            {
              name: 'puertacartuja.es',
              subdomains: ['cajafuerte', 'identidad', 'wiki'],
            },
          ],
        },
      ],
    };

    const config = validateConfig(raw);

    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].domains[0].subdomains).toEqual(['@', '*']);
    expect(config.accounts.every(account => account.recordStrategy === 'all')).toBe(true);
    expect(config.security.allowLegacyGlobalAccountTokens).toBe(false);
  });

  it('rejects an unknown record strategy', () => {
    const raw = validConfig();
    (raw.accounts[0] as any).recordStrategy = 'random';

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.recordStrategy/);
  });

  it('does not leak credential values in validation errors', () => {
    const raw = validConfig();
    raw.accounts[0].credentials.appSecret = '';

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.credentials\.appSecret/);

    try {
      validateConfig(raw);
    } catch (err) {
      expect(String(err)).not.toContain(raw.accounts[0].credentials.consumerKey);
    }
  });
});
