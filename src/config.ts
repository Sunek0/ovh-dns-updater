import nodeConfig from 'config';
import { z } from 'zod';
import { AppConfig } from './types.js';

const nonEmptyString = z.string().trim().min(1);

// Keep in sync with the preconfigured endpoints in `ovh/lib/endpoints.js`.
export const OVH_ENDPOINTS = [
  'ovh-eu',
  'ovh-us',
  'ovh-ca',
  'sys-eu',
  'sys-ca',
  'soyoustart-eu',
  'soyoustart-ca',
  'ks-eu',
  'ks-ca',
  'kimsufi-eu',
  'kimsufi-ca',
] as const;

const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_DIVERSITY = 8;

// Normalize separators/case so padded variants such as
// "change-me-change-me" cannot bypass the placeholder check.
const PLACEHOLDER_SECRETS = [
  'changeme',
  'cambiarporunaclavelargayaleatoria',
  'mysecretpathtoken',
  'yourapikey',
  'yoursecret',
] as const;

function normalizeSecret(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[\s._-]+/g, '');
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = normalizeSecret(value);
  return PLACEHOLDER_SECRETS.some(placeholder => normalized.includes(placeholder));
}

function hasLowDiversity(value: string): boolean {
  return new Set(value).size < MIN_SECRET_DIVERSITY;
}

function addWeakSecretIssues(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  secret: string,
  surface: string,
): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `must be at least ${MIN_SECRET_LENGTH} characters when ${surface} is enabled`,
    });
  }

  if (isPlaceholderSecret(secret)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `must not be a placeholder when ${surface} is enabled`,
    });
  }

  if (hasLowDiversity(secret)) {
    ctx.addIssue({
      code: 'custom',
      path,
      message: `must contain at least ${MIN_SECRET_DIVERSITY} distinct characters when ${surface} is enabled`,
    });
  }
}

const httpUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be a valid http(s) URL');

const endpointSchema = nonEmptyString.pipe(z.enum(OVH_ENDPOINTS));

const credentialsSchema = z.object({
  endpoint: endpointSchema,
  appKey: nonEmptyString,
  appSecret: nonEmptyString,
  consumerKey: nonEmptyString,
  timeout: z.coerce.number().int().positive().optional(),
});

const subdomainSchema = z.union([
  nonEmptyString,
  z.record(z.string(), z.string()),
]);

const domainSchema = z.object({
  name: nonEmptyString,
  subdomains: z.array(subdomainSchema).default([]),
});

const accountSchema = z.object({
  id: nonEmptyString,
  provider: z.literal('ovh').default('ovh'),
  enabled: z.boolean().optional(),
  token: nonEmptyString.optional(),
  recordStrategy: z.enum(['all', 'single', 'fail']).default('all'),
  credentials: credentialsSchema,
  domains: z.array(domainSchema).default([]),
});

const appConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: nonEmptyString.default('0.0.0.0'),
    logLevel: nonEmptyString.default('info'),
    trustProxy: z.boolean().default(false),
  }),
  security: z.object({
    apiKey: nonEmptyString,
    allowLegacyGlobalAccountTokens: z.boolean().default(false),
  }),
  ondemand: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
  scheduler: z.object({
    enabled: z.boolean().default(true),
    interval: z.coerce.number().positive().default(600),
  }).default({ enabled: true, interval: 600 }),
  ui: z.object({
    enabled: z.boolean().default(true),
    historySize: z.coerce.number().int().min(1).max(10000).default(500),
    refreshSeconds: z.coerce.number().int().min(1).max(3600).default(10),
  }).default({ enabled: true, historySize: 500, refreshSeconds: 10 }),
  ipProviders: z.array(httpUrl).min(1),
  accounts: z.array(accountSchema).default([]),
}).superRefine((value, ctx) => {
  const authSurfaceEnabled = value.ondemand.enabled || value.ui.enabled;
  const ids = new Set<string>();
  const tokens = new Set<string>();

  // `security.apiKey` only protects routes registered by the on-demand API
  // or the UI. If both toggles are off, the key is not reachable and a
  // placeholder is harmless. Otherwise, force a non-guessable value.
  if (authSurfaceEnabled) {
    addWeakSecretIssues(
      ctx,
      ['security', 'apiKey'],
      value.security.apiKey,
      'the API or UI',
    );
  }

  value.accounts.forEach((account, index) => {
    if (ids.has(account.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', index, 'id'],
        message: 'must be unique',
      });
    }
    ids.add(account.id);

    if (!account.token) return;

    // Account tokens are only accepted by the legacy GET routes, which are
    // registered with the on-demand API. The UI only accepts the master key.
    // Disabled accounts never authenticate, so their stale tokens must not
    // prevent the service from starting.
    if (value.ondemand.enabled && account.enabled !== false) {
      addWeakSecretIssues(
        ctx,
        ['accounts', index, 'token'],
        account.token,
        'the API',
      );
    }

    if (tokens.has(account.token)) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', index, 'token'],
        message: 'must be unique',
      });
    }

    if (account.token === value.security.apiKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['accounts', index, 'token'],
        message: 'must differ from security.apiKey',
      });
    }

    tokens.add(account.token);
  });
});

export function validateConfig(raw: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }

  return parsed.data;
}

export function loadConfig(): AppConfig {
  return validateConfig(nodeConfig.util.toObject());
}
