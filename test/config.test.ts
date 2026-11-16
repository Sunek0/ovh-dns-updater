import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { OVH_ENDPOINTS, formatConfigError, validateConfig } from '../src/config.js';

const nodeRequire = createRequire(import.meta.url);
const ovhEndpoints = nodeRequire('ovh/lib/endpoints.js') as Record<string, unknown>;

const STRONG_API_KEY = '0123456789abcdef0123456789abcdef';
const STRONG_ACCOUNT_TOKEN = 'fedcba9876543210fedcba9876543210';
const OTHER_STRONG_ACCOUNT_TOKEN = '11111111111111111111111111111111';

const validConfig = () => ({
  server: {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
  },
  security: {
    apiKey: STRONG_API_KEY,
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
      token: STRONG_ACCOUNT_TOKEN,
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
    expect(config.security.allowInsecureIpProviders).toBe(false);
    expect(config.scheduler.interval).toBe(600);
    expect(config.accounts[0].provider).toBe('ovh');
    expect(config.accounts[0].domains[0].subdomains).toEqual(['@', 'www']);
  });

  it('applies optional defaults', () => {
    const raw = validConfig();
    const config = validateConfig({
      server: {},
      security: { apiKey: STRONG_API_KEY },
      ipProviders: ['https://ip.local'],
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
      token: OTHER_STRONG_ACCOUNT_TOKEN,
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
      security: { apiKey: STRONG_API_KEY },
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

  it('rejects a placeholder API key when the API is enabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'change-me';
    raw.ondemand.enabled = true;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must not be a placeholder/);
  });

  it('rejects a placeholder API key when the UI is enabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'CAMBIAR_POR_UNA_CLAVE_LARGA_Y_ALEATORIA';
    raw.ondemand.enabled = false;
    (raw as any).ui = { enabled: true };

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must not be a placeholder/);
  });

  it('rejects a placeholder API key when ui is omitted and defaults to enabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'change-me';
    raw.ondemand.enabled = false;

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must not be a placeholder/);
  });

  it('accepts the placeholder API key when the API and UI are disabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'change-me';
    raw.ondemand.enabled = false;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects a short API key when an auth surface is enabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'short';
    raw.ondemand.enabled = true;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must be at least 32/);
  });

  it('accepts a short API key when the API and UI are disabled', () => {
    const raw = validConfig();
    raw.security.apiKey = 'short';
    raw.ondemand.enabled = false;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects a weak account token when the API is enabled', () => {
    const raw = validConfig();
    raw.accounts[0].token = 'short';
    raw.ondemand.enabled = true;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.token: must be at least 32/);
  });

  it('rejects a placeholder account token when the API is enabled', () => {
    const raw = validConfig();
    raw.accounts[0].token = 'my-secret-path-token';
    raw.ondemand.enabled = true;
    (raw as any).ui = { enabled: false };

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.token: must not be a placeholder/);
  });

  it('accepts a weak account token when the API is disabled', () => {
    const raw = validConfig();
    raw.accounts[0].token = 'short';
    raw.ondemand.enabled = false;
    (raw as any).ui = { enabled: true };

    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects an unsupported OVH endpoint', () => {
    const raw = validConfig();
    raw.accounts[0].credentials.endpoint = 'ovh-typo';

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.credentials\.endpoint/);
  });

  it('keeps the endpoint list in sync with the OVH client', () => {
    expect([...OVH_ENDPOINTS].sort()).toEqual(Object.keys(ovhEndpoints).sort());
  });

  it('trims a supported OVH endpoint', () => {
    const raw = validConfig();
    raw.accounts[0].credentials.endpoint = ' ovh-eu ';

    const config = validateConfig(raw);
    expect(config.accounts[0].credentials.endpoint).toBe('ovh-eu');
  });

  it('accepts an API key of exactly 32 characters when auth is enabled', () => {
    const raw = validConfig();
    expect(raw.security.apiKey).toHaveLength(32);

    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects a 31-character API key when auth is enabled', () => {
    const raw = validConfig();
    raw.security.apiKey = '0123456789abcdef0123456789abcde';

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must be at least 32/);
  });

  it('rejects a padded placeholder API key', () => {
    const raw = validConfig();
    raw.security.apiKey = 'change-me'.repeat(4);

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must not be a placeholder/);
  });

  it('rejects a low-diversity API key', () => {
    const raw = validConfig();
    raw.security.apiKey = 'a'.repeat(32);

    expect(() => validateConfig(raw)).toThrow(/security\.apiKey: must contain at least 8 distinct/);
  });

  it('rejects a low-diversity account token', () => {
    const raw = validConfig();
    raw.accounts[0].token = 'a'.repeat(32);

    expect(() => validateConfig(raw)).toThrow(/accounts\.0\.token: must contain at least 8 distinct/);
  });

  it('accepts a weak token for a disabled account when the API is enabled', () => {
    const raw = validConfig();
    raw.accounts[0].token = 'short';
    (raw.accounts[0] as any).enabled = false;

    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects secrets containing whitespace or control characters', () => {
    const raw = validConfig();
    raw.security.apiKey = '0123456789abcdef 0123456789abcdef';

    expect(() => validateConfig(raw)).toThrow(
      /security\.apiKey: must not contain whitespace or control characters/,
    );

    const tokenConfig = validConfig();
    tokenConfig.accounts[0].token = 'fedcba9876543210\tfedcba9876543210';

    expect(() => validateConfig(tokenConfig)).toThrow(
      /accounts\.0\.token: must not contain whitespace or control characters/,
    );
  });

  it('rejects unknown configuration keys', () => {
    const topLevel = validConfig() as any;
    topLevel.schedular = { enabled: false };

    expect(() => validateConfig(topLevel)).toThrow(/Unrecognized key/);

    const nested = validConfig() as any;
    nested.server.extra = true;

    expect(() => validateConfig(nested)).toThrow(/Unrecognized key/);

    const accountTypo = validConfig() as any;
    accountTypo.accounts[0].enable = false;

    expect(() => validateConfig(accountTypo)).toThrow(/Unrecognized key/);
  });

  it('rejects invalid log levels', () => {
    const raw = validConfig();
    (raw.server as any).logLevel = 'verbose';

    expect(() => validateConfig(raw)).toThrow(/server\.logLevel/);
  });

  it('bounds the scheduler interval and requires whole seconds', () => {
    for (const interval of [0.5, 9, 2_147_484]) {
      const raw = validConfig();
      raw.scheduler.interval = interval as any;

      expect(() => validateConfig(raw)).toThrow(/scheduler\.interval/);
    }

    const minimum = validConfig();
    minimum.scheduler.interval = 10;
    expect(validateConfig(minimum).scheduler.interval).toBe(10);

    const maximum = validConfig();
    maximum.scheduler.interval = 2_147_483;
    expect(validateConfig(maximum).scheduler.interval).toBe(2_147_483);
  });

  it('bounds the OVH timeout to a safe timer range', () => {
    const raw = validConfig();
    (raw.accounts[0].credentials as any).timeout = 2_147_483_648;

    expect(() => validateConfig(raw)).toThrow(/credentials\.timeout/);
  });

  it('rejects plaintext IP providers unless explicitly allowed', () => {
    const raw = validConfig();
    raw.ipProviders = ['http://ip.local'];

    expect(() => validateConfig(raw)).toThrow(/allowInsecureIpProviders/);

    (raw.security as any).allowInsecureIpProviders = true;
    expect(() => validateConfig(raw)).not.toThrow();
  });

  it('rejects IP providers with embedded credentials', () => {
    const raw = validConfig();
    raw.ipProviders = ['https://user:pass@ip.local'];
    (raw.security as any).allowInsecureIpProviders = true;

    expect(() => validateConfig(raw)).toThrow(/must not include credentials/);
  });

  it('does not expose secrets from node-config parse errors', () => {
    const formatted = formatConfigError(new Error(
      "Cannot parse config file: '/etc/ovh-dns-updater/local.yml': " +
      'YAMLException: bad indentation apiKey: "SUPERSECRETVALUE_SHOULD_NOT_LEAK',
    ));

    expect(formatted).toContain('/etc/ovh-dns-updater/local.yml');
    expect(formatted).not.toContain('SUPERSECRETVALUE_SHOULD_NOT_LEAK');
    expect(formatConfigError(new Error('Invalid configuration: server.port: x')))
      .toBe('Invalid configuration: server.port: x');
  });
});
