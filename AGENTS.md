# AGENTS.md

## Project Overview

`ovh-dns-updater-ng` is a dynamic DNS updater for OVH. It detects the public IPv4
address, updates the configured OVH `A` records across one or more accounts, and
refreshes each DNS zone so the changes are published.

Stack: Node.js 24, TypeScript (ESM), Fastify 5, `node-config`, Zod, Pino,
Vitest and `supertest`. The package is private and ESM-only (`"type": "module"`).

Main capabilities:

- Multi-account/multi-tenancy with isolated OVH credentials.
- Rotating IPv4 detection providers with a 30 s cache and shared in-flight request.
- Background scheduler, on-demand REST API, and legacy Mikrotik-style GET routes.
- In-memory status UI with REST polling and Server-Sent Events (SSE).
- Strict startup configuration validation, with secrets rejected when weak.

## Setup Commands

- Node version: `24.22.1` (`.nvmrc`); `engines` requires Node `>=24`.
- Package manager: pnpm 12 (`packageManager` pins `pnpm@12.21.0`).
- Enable Corepack and install dependencies:
  ```bash
  corepack enable
  pnpm install --frozen-lockfile   # use plain `pnpm install` when intentionally changing deps
  ```
- Create a local config (`config/local.yml` is gitignored and must never be committed):
  ```bash
  openssl rand -hex 32   # use as security.apiKey
  cp config/default.yaml config/local.yml
  ```
- Fill in OVH credentials and domains in `config/local.yml`. OVH tokens need:
  `GET /domain/zone/*`, `PUT /domain/zone/*`, `POST /domain/zone/*/refresh`.

## Development Workflow

```bash
pnpm dev            # tsx watch on src/index.ts, pretty logs
pnpm start          # run built output (dist/index.js)
pnpm build          # compile src with tsconfig.build.json
pnpm typecheck      # tsc --noEmit for src + test
pnpm test           # one-shot Vitest run
pnpm test:watch     # Vitest watch mode
pnpm test:coverage  # Vitest with V8 coverage into coverage/
```

- Production startup uses `NODE_ENV=production` and JSON logs by default.
  `LOG_PRETTY=true` enables `pino-pretty`. Outside Docker with
  `NODE_ENV=production`, set `SUPPRESS_STRICTNESS_CHECK=true` to silence
  `node-config`'s missing-production-file warning.
- Configuration is merged by `node-config` from `config/default.yaml`, the
  instance file `config/local.yml`/`config/local.yaml`, and optionally the
  `NODE_CONFIG` JSON environment variable; there is no per-key env mapping.
  It is validated by Zod in `src/config.ts`. Invalid configuration aborts startup.
- `config/local.*` is intentionally excluded from Git and Docker. Never add real
  OVH credentials, account tokens, or the API key to tracked files, tests,
  docs, examples, or logs.

## Architecture

- `src/index.ts`: loads/validates config, starts the server, installs
  SIGINT/SIGTERM shutdown and enforces a graceful-shutdown timeout.
- `src/app.ts`: builds the Fastify instance and conditionally registers plugins
  and routes (`buildServer`), without listening. Used by startup and tests.
- `src/plugins/services.ts`: creates and decorates Fastify with `config`,
  `stateStore`, and `updaterService`. Plugin is wrapped in `fastify-plugin` so
  decorators are visible to sibling plugins.
- `src/plugins/scheduler.ts`: runs an initial sync on `onReady` and periodic
  syncs via `setInterval`; skips overlapping runs; clears timers on close.
- `src/services/UpdaterService.ts`: sync orchestration (`syncAll`,
  `syncAccount`), per-account result aggregation, best-effort state updates.
- `src/services/OvhAccount.ts`: OVH API wrapper; resolves A records, verifies
  `subDomain`, applies `recordStrategy`, updates records, refreshes zones.
- `src/services/IpService.ts`: shuffles providers, validates IPv4, caches the
  result, and reports provider failures.
- `src/services/StateStore.ts`: in-memory snapshot/history/event store and
  subscriptions for status, events, and SSE. It is observability-only and must
  never hold OVH credentials or the API key.
- `src/routes/api.ts`: on-demand and legacy API routes, authentication and rate
  limits. `src/routes/status.ts`: `/api/status`, `/api/events`, `/api/stream`.
  `src/routes/ui.ts`: serves static files from `public/`.
- `public/`: dependency-free HTML/CSS/JS status UI. No build step and no external
  CDNs; UI copy is in Spanish.
- `test/`: Vitest suites named after the module under test.
- `src/ovh.d.ts`: local typings for the `ovh` package.

Requests flow as: route → `UpdaterService` → `IpService`/`OvhAccount` →
`StateStore` (observability) → response. `StateStore` failures must never break
the DNS update path.

## Testing Instructions

- Run all tests with `pnpm test`; run a subset with
  `pnpm vitest run test/OvhAccount.test.ts` or filter by name with
  `pnpm vitest run -t "pattern"`.
- Tests live in `test/*.test.ts`, grouped by the source module they cover.
  Focused sub-suites (scheduler, streaming, rate limiting) may live alongside
  the closest module test. Use `describe`/`it` from Vitest and `supertest` for
  HTTP behavior where it fits.
- Mock OVH and network boundaries (`vi.mock`, fake services, fake loggers).
  Never call real OVH, real IP providers, or use real credentials in tests.
- Use obviously fake secrets of at least 32 characters with at least 8 distinct
  characters when a test needs an accepted key/token.
- Add or update tests for every behavior change, including failure paths and
  secret-redaction guarantees. `pnpm test:coverage` enforces server-side
  thresholds (statements ≥92 %, lines ≥93 %, branches ≥82 %, functions ≥95 %);
  `src/index.ts` (process bootstrap) and type-only files are excluded.
- Current suite: 10 files / 151 tests. Coverage output goes to `coverage/`
  (gitignored, uploaded as a CI artifact).

## Code Style

- TypeScript strict mode, ES2022 target, `module`/`moduleResolution` `NodeNext`.
- ESM imports must include the `.js` extension even in `.ts` files
  (for example `import { loadConfig } from './config.js';`).
- Match the existing formatting: 2-space indentation, single quotes, semicolons,
  trailing commas, small focused functions, and named exports. Fastify plugins
  and route modules are the exception: they use default exports because that is
  the registration idiom. Existing test files use 4-space blocks; match the
  file you are editing and do not reformat unrelated code.
- No ESLint/Prettier script is configured. Match surrounding style; do not
  reformat unrelated code.
- Keep shared domain types in `src/types.ts`; use Fastify declaration merging
  for decorators (`src/plugins/services.ts`, `src/types.ts`).
- Routes stay thin: validate input, call services, map errors to HTTP status.
  Business logic belongs in `src/services/`; pure helpers in `src/utils/`.
- Log through `fastify.log`/Pino with structured context. `console.error` is
  only a fallback for startup failures where the logger may exit first.
- Error messages returned to clients must stay generic. Never include OVH
  credentials, account tokens, or the API key; log full details server-side.
- The service intentionally supports IPv4 / `A` records only. Do not add IPv6
  handling without an explicit requirement.
- `@` normalizes to the empty OVH root subdomain; `*` is a wildcard. Record
  updates must not touch A records belonging to a different `subDomain`.
- Every managed domain is refreshed on each sync (idempotent retry). Do not
  "optimize" this away: a previous PUT may have succeeded while its refresh did
  not, leaving OVH stored data and the published zone out of sync.
- Record creation is not supported: missing A records are reported as
  `not-found`, not created.
- Observability and state updates are best-effort; wrap them so they can never
  interrupt IP detection or DNS updates.

## Security and API Notes

- Management routes (`/api/sync`, `/api/accounts/:id/sync`, status/events/stream)
  require `Authorization: Bearer <security.apiKey>`.
- Account tokens are only accepted in legacy path routes (`/api/:token/...`) and
  are scoped to that account. Global behavior for account tokens is opt-in via
  `security.allowLegacyGlobalAccountTokens` (disabled by default).
- Use constant-time comparisons (`safeEqual`) for secrets; never log them.
- When the API or UI is enabled, `security.apiKey` must be at least 32 chars,
  non-placeholder, and have at least 8 distinct characters. Enabled account
  tokens follow the same rules when `ondemand.enabled` is true. Secrets must not
  contain whitespace or control characters.
- IP providers must use HTTPS unless `security.allowInsecureIpProviders` is
  explicitly enabled, and provider URLs must not embed credentials. Detected
  addresses must be globally routable IPv4; private, loopback, link-local and
  reserved ranges are rejected.
- Configuration schemas are strict: unknown keys abort startup. `scheduler.interval`
  must be an integer between 10 and 2,147,483 seconds.
- Error text returned to clients is generic; full (redacted) diagnostics stay in
  the server logs and the authenticated in-memory state store.
- Keep rate limits in `src/routes/api.ts` (`RATE_LIMITS`) and the standard
  `Cache-Control: no-store` / `X-Content-Type-Options: nosniff` headers for API
  responses.
- Enable `server.trustProxy` only behind a trusted reverse proxy. For SSE,
  disable proxy buffering (for example `proxy_buffering off` in Nginx).
- Preserve the CSP, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`
  headers on UI assets.
- Status snapshots, events, and SSE payloads must never include OVH credentials,
  account tokens, or the master API key.

## Build and Deployment

- `pnpm build` compiles only `src/` (`tsconfig.build.json`) into `dist/`.
  `dist/` is a build artifact, not source; do not edit it.
- `pnpm start` runs `node dist/index.js`; build before starting in production.
- Docker image: multi-stage `node:24.22.1-alpine`, production deps only,
  unprivileged `node` user, port 3000, `/health` HEALTHCHECK.
- The image sets `NODE_ENV=production` and `SUPPRESS_STRICTNESS_CHECK=true`.
  Instance config is mounted at runtime, for example:
  ```bash
  docker run -p 3000:3000 \
    -v /etc/ovh-dns-updater/local.yml:/usr/src/app/config/local.yml:ro \
    ovh-dns-updater-ng
  ```
  Mount the file, not the whole directory, so the image's `config/default.yaml`
  is not hidden. `config/local.*` is also in `.dockerignore`.
- GitLab CI (`.gitlab-ci.yml`) is authoritative: install with
  `--frozen-lockfile`, then `pnpm typecheck`, `pnpm test:coverage`, and
  `pnpm audit --audit-level=high`. It builds/pushes images from `main` and
  `develop`.
- GitHub is only a mirror of `main` and release tags; `develop` stays on GitLab.
  `.github/workflows/release-image.yml` publishes multi-arch images to
  `ghcr.io/sunek0/ovh-dns-updater` on `vX.Y.Z` tags or manual dispatch.

## Pull Request Guidelines

- Use Conventional Commits, matching existing history, for example
  `feat(ui): ...`, `fix(config): ...`, `chore(deps): ...`, `docs(config): ...`.
- Before submitting, run:
  ```bash
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm audit --audit-level=high
  ```
- Keep changes focused and include tests for new behavior.
- Never commit `config/local.yml`, `config/local.yaml`, `.env*`, `dist/`,
  `coverage/`, `node_modules/`, or real credentials.

## Troubleshooting

- Startup fails with `Invalid configuration: path: message`: fix the reported
  config path. Errors intentionally omit secret values.
- `security.apiKey` rejected: generate a strong key with
  `openssl rand -hex 32`; placeholders, short keys, and low-diversity values are
  refused while the API/UI is enabled.
- `node-config` strictness warning in production: set
  `SUPPRESS_STRICTNESS_CHECK=true` or run the Docker image, which sets it.
- UI returns 401: send the master API key as a Bearer token; account tokens are
  not accepted by status/UI endpoints.
- SSE reconnects or lags: check reverse-proxy buffering and `server.trustProxy`
  / rate-limit behavior.
- OVH `not-found`: the A record does not exist; create it in OVH first. The
  updater intentionally does not create records.
- Zone refresh failures mark affected records as errors even when targets were
  stored correctly; the next sync retries the refresh.
