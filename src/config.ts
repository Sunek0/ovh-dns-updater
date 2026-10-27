import nodeConfig from 'config';
import { z } from 'zod';
import { AppConfig } from './types.js';

const nonEmptyString = z.string().trim().min(1);

const httpUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be a valid http(s) URL');

const credentialsSchema = z.object({
  endpoint: nonEmptyString,
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
  credentials: credentialsSchema,
  domains: z.array(domainSchema).default([]),
});

const appConfigSchema = z.object({
  server: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
    host: nonEmptyString.default('0.0.0.0'),
    logLevel: nonEmptyString.default('info'),
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
  ipProviders: z.array(httpUrl).min(1),
  accounts: z.array(accountSchema).default([]),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  const tokens = new Set<string>();

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
