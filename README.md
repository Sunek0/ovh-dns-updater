# OVH DNS Updater NextGen

[![Build Status](https://img.shields.io/badge/status-active-brightgreen.svg)]()
[![Type](https://img.shields.io/badge/stack-Fastify%20|%20TypeScript%20|%20Vitest-blue.svg)]()
[![Coverage](https://img.shields.io/badge/coverage-95%25-brightgreen.svg)]()

A modern, dynamic DNS updater for OVH accounts. It monitors your public IP address and automatically updates specified OVH DNS A-records.

## Features

- **Multi-Account/Multi-Tenancy**: Manage completely different OVH accounts (different app keys/secrets) within a single instance.
- **Resilient IP Detection**: Rotates between providers (`ipify.org`, `ifconfig.me`, `icanhazip.com`) to ensure detection works even if some services are down.
- **Root Domain Support**: Automatic normalization of `@` to root record updates.
- **Legacy Compatibility**: Support for Mikrotik-style scripts via GET requests with tokens in the URL.
- **Smart Sync**:
  - **Background Scheduler**: Periodically checks and updates records (default: every 10 mins).
  - **On-Demand API**: Trigger updates via REST API.
- **Web Status UI**: Optional, dependency-free interface with live in-memory status, per-record values, IP provider health and a filterable event timeline.
- **Feature Toggles**: Enable/Disable the scheduler, the API or the web UI independently via configuration.
- **Modern Stack**: Node.js 24+, Fastify 5, TypeScript, Pino logging, and Vitest.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v24 or higher (recommended: 24.22.1).
- [pnpm](https://pnpm.io/) v12 or higher (the project pins 12.15.0).
- OVH API credentials. Create them at [https://api.ovh.com/createToken/](https://api.ovh.com/createToken/). Required rights:
  - `GET /domain/zone/*`
  - `PUT /domain/zone/*`
  - `POST /domain/zone/*/refresh`

### Setup

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Build the project:
   ```bash
   pnpm build
   ```

## Configuration

The project uses `node-config`. Configuration is merged from `config/default.yaml`,
environment variables, and the instance file `config/local.yml` (or `config/local.yaml`).

The merged configuration is validated at startup. Invalid values, duplicate account IDs,
duplicate tokens or malformed provider URLs abort the process with a clear error that
does not include secret values.

### Settings Overview

| Path | Description | Default |
| :--- | :--- | :--- |
| `server.port` | HTTP Port | `3000` |
| `server.logLevel` | Logging level (pino) | `info` |
| `server.trustProxy` | Trust `X-Forwarded-*` headers (only behind a trusted proxy) | `false` |
| `security.apiKey` | Master token for API access | `change-me` |
| `security.allowLegacyGlobalAccountTokens` | Allow account tokens to trigger global syncs (legacy) | `false` |
| `scheduler.enabled` | Enable background checks | `true` |
| `scheduler.interval` | Interval between checks (seconds) | `600` (10m) |
| `ondemand.enabled` | Enable the REST API | `true` |
| `ui.enabled` | Serve the web UI and its status API | `true` |
| `ui.historySize` | Events kept in the in-memory circular buffer | `500` |
| `ui.refreshSeconds` | Fallback polling interval used when SSE is unavailable | `10` |

> **Security:** change `security.apiKey` before exposing the service. The default
> value is only a placeholder and must not be used in production.

### Account Configuration

Each account in the `accounts` array can have:
- `id`: Unique identifier for logging/API.
- `token`: (Optional) A dedicated token for legacy GET access. It is scoped to this account.
- `credentials`: OVH endpoint and keys. `timeout` is optional and defaults to 30 seconds.
- `domains`: List of domains and subdomains (use `@` for root and `*` for a wildcard).
- `recordStrategy`: How to handle multiple A records for the same subdomain:
  - `all` (default): update every A record.
  - `single`: update only the first record and log a warning.
  - `fail`: reject the update if there is not exactly one A record.

```yaml
accounts:
  - id: 'my-home-server'
    token: 'my-secret-path-token'
    enabled: true
    recordStrategy: 'all'
    credentials:
      endpoint: 'ovh-eu'
      appKey: '...'
      appSecret: '...'
      consumerKey: '...'
    domains:
      - name: 'example.com'
        subdomains: ['@', 'vpn', 'cloud']
```

### Configuración del servidor: `config/local.yml`

En el servidor no se usa `config/production.yml`. Toda la configuración de la
instancia debe ir en `config/local.yml`; `node-config` lo carga automáticamente
y el fichero está excluido de Git y del contexto de Docker.

Ejemplo completo para el servidor:

```yaml
# config/local.yml - no versionar
server:
  port: 3000
  host: '0.0.0.0'
  logLevel: 'info'
  # Activar solo si hay un proxy inverso de confianza delante.
  trustProxy: false

security:
  apiKey: 'CAMBIAR_POR_UNA_CLAVE_LARGA_Y_ALEATORIA'
  allowLegacyGlobalAccountTokens: false

ondemand:
  enabled: true

scheduler:
  enabled: true
  interval: 600

ui:
  enabled: true
  historySize: 500
  refreshSeconds: 10

ipProviders:
  - https://api.ipify.org
  - https://ifconfig.me/ip
  - https://icanhazip.com

accounts:
  - id: 'personal-account'
    provider: 'ovh'
    enabled: true
    recordStrategy: 'all'
    credentials:
      endpoint: 'ovh-eu'
      appKey: '...'
      appSecret: '...'
      consumerKey: '...'
      timeout: 30000
    domains:
      - name: 'example.com'
        subdomains: ['@', '*']
      - name: 'example.org'
        subdomains: ['@', '*']

  - id: 'second-account'
    provider: 'ovh'
    enabled: true
    # recordStrategy omitted -> "all"
    credentials:
      endpoint: 'ovh-eu'
      appKey: '...'
      appSecret: '...'
      consumerKey: '...'
    domains:
      - name: 'example.net'
        subdomains: ['cajafuerte', 'identidad', 'wiki']
```

Notas:

- `@` actualiza el registro raíz y `*` el comodín del dominio.
- `recordStrategy` acepta `all` (por defecto), `single` o `fail`.
- `security.apiKey` debe ser distinta de los tokens de cuenta.
- Si el servicio está detrás de un proxy, activa `server.trustProxy: true`.
- El fichero `config/local.yml` no se copia dentro de la imagen Docker; hay que
  montarlo en runtime.
- No se necesita `config/production.yml`. Si arrancas fuera de Docker con
  `NODE_ENV=production`, añade `SUPPRESS_STRICTNESS_CHECK=true` para evitar el
  aviso de node-config. La imagen Docker ya lo define.

## Interfaz web

La UI está habilitada por defecto y se sirve desde el propio Fastify, sin
dependencias nuevas ni CDNs externos. Funciona en una red local sin acceso a
Internet y se adapta a móvil y a modo oscuro (`prefers-color-scheme`).

- `GET /` sirve la interfaz estática. No requiere autenticación para cargar el
  HTML, CSS y JS.
- La UI pide la `security.apiKey`, la guarda solo en `sessionStorage` y la envía
  como `Authorization: Bearer <apiKey>` en cada petición de datos.
- Muestra la IP actual e inicial, última/próxima comprobación, uptime, estado
  del scheduler y de on-demand, proveedor de IP, contadores, una tarjeta por
  cuenta con sus registros y un timeline filtrable de eventos.
- Si `ondemand.enabled` es `true`, aparece el botón **Comprobar ahora**, que usa
  el endpoint existente `POST /api/sync`.
- Las actualizaciones llegan por **SSE** desde `GET /api/stream`, autenticado
  con Bearer. El navegador usa `fetch` en streaming (no `EventSource`) para poder
  enviar la cabecera `Authorization` sin poner la API key en la URL.
- El stream envía un bootstrap al conectar y después snapshots consolidados y
  eventos incrementales. Se reconecta con backoff y, si no está disponible,
  vuelve automáticamente al polling REST cada `ui.refreshSeconds`.
- El uptime, los tiempos relativos y la cuenta atrás se actualizan localmente
  cada segundo; no dependen de que llegue un evento SSE.
- Al ocultar la pestaña se cierra la conexión SSE; al volver a mostrarla se
  reconecta y se recibe un nuevo bootstrap.

Todo el estado de la UI vive en memoria: no hay base de datos ni ficheros. Al
reiniciar el proceso se pierde el historial y los valores iniciales se vuelven
a leer desde OVH en la primera sincronización. El buffer de eventos conserva
como máximo `ui.historySize` entradas.

`ui.enabled: false` desactiva la interfaz y también `/api/status`,
`/api/events` y `/api/stream`. El updater, el scheduler y la API on-demand
siguen funcionando con normalidad. Los secretos de OVH (`appKey`, `appSecret`,
`consumerKey`) y la `apiKey` nunca forman parte del snapshot ni del historial.

Si la UI está detrás de un proxy inverso, desactiva el buffering para
`/api/stream` (por ejemplo, `proxy_buffering off` en Nginx).

## API Reference

On-demand routes are prefixed with `/api`. The UI status, event and streaming
endpoints are also under `/api` and are served when `ui.enabled` is `true`,
independently of whether on-demand updates are enabled.

### Public Endpoints
- `GET /`: Static web UI (when `ui.enabled` is `true`).
- `GET /health`: Liveness check.
- `GET /api/public-ip`: Returns the currently detected public IP.

### Management (Requires `Authorization: Bearer <apiKey>`)
- `GET /api/status`: Full in-memory snapshot (global state, accounts, records and counters).
- `GET /api/events?limit=&account=&domain=&type=`: Event history. `type` accepts
  `updated`, `unchanged`, `error` or `public_ip_changed`. Results are returned
  newest first and `limit` defaults to 100.
- `GET /api/stream?limit=&account=&domain=&type=`: Server-Sent Events stream.
  It first sends a `bootstrap` event with the snapshot and filtered history,
  then `update` events with a consolidated snapshot and new events, plus
  periodic `heartbeat` events. The same filters as `/api/events` apply.
- `POST /api/sync`: Force a check and update for all enabled accounts.
- `POST /api/accounts/:id/sync`: Sync only a specific account.

`/api/*` responses include `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. The SSE response uses
`Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`. The status
snapshot never includes OVH credentials, account tokens or the master API key.

Sync responses include `results` with a per-account summary (`Success`, `Partial`,
`Failed`) and `details` with the per-domain/per-subdomain outcome.

### Rate limiting and caching
- `GET /api/public-ip`: 30 requests/minute per client IP.
- `POST /api/sync` and `POST /api/accounts/:id/sync`: 10 requests/minute.
- `GET /api/:token/checkip`: 30 requests/minute.
- `GET /api/:token/setip/:ip`: 10 requests/minute.

Exceeding a limit returns `429 Too Many Requests`. The detected public IP is cached
for 30 seconds, and concurrent detections share a single upstream request.

If the service runs behind a reverse proxy, enable `server.trustProxy` so rate limits
use the real client IP. Do not enable it when the service is directly exposed.

### Legacy / Mikrotik (Requires valid `:token` in path)
Compatible with devices that can only perform GET requests. The `:token` can be either the `apiKey` or a specific account `token`.

- `GET /api/:token/checkip`: With the master `apiKey`, trigger a global sync. With an account token, sync only that account.
- `GET /api/:token/setip/:ip`: With the master `apiKey`, force the IP for all accounts. With an account token, force the IP only for that account.

> The previous global behaviour for account tokens can be restored temporarily with
> `security.allowLegacyGlobalAccountTokens: true`. It is disabled by default and
> logs a warning when enabled.

## Running

```bash
# Development (pretty logs)
pnpm dev

# Production (JSON logs)
NODE_ENV=production SUPPRESS_STRICTNESS_CHECK=true pnpm start
```

In production the logger emits JSON by default. Set `LOG_PRETTY=true` only if you
explicitly want `pino-pretty` output. The Docker image already sets
`NODE_ENV=production` and `SUPPRESS_STRICTNESS_CHECK=true`.

### Docker
```bash
docker build -t ovh-dns-updater-ng .
docker run -p 3000:3000 \
  -v /etc/ovh-dns-updater/local.yml:/usr/src/app/config/local.yml:ro \
  ovh-dns-updater-ng
```

Monta el fichero `local.yml` en lugar del directorio completo para no ocultar el
`config/default.yaml` incluido en la imagen. Si prefieres montar un directorio,
asegúrate de que también contiene `default.yaml`.

The runtime image uses Node 24.22.1, runs as the unprivileged `node` user, emits
JSON logs and exposes a `HEALTHCHECK` against `/health`. The static UI files in
`public/` are copied into the image. Instance-specific settings (including
`config/local.yml`) are intentionally excluded from the build context and must
be mounted at runtime.

## Testing

The project maintains high coverage (90%+) using Vitest.

```bash
pnpm typecheck     # Type-check source and tests
pnpm test          # Run tests
pnpm test:coverage # Generate coverage report
```

## License
MIT

