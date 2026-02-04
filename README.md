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
- **Feature Toggles**: Enable/Disable the scheduler or the API independently via configuration.
- **Modern Stack**: Node.js 24+, Fastify 5, TypeScript, Pino logging, and Vitest.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v24 or higher.
- [pnpm](https://pnpm.io/) v10+.
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

The project uses `node-config`. Configuration is merged from `config/default.yaml`, environment variables, and optionally `config/local.yaml`.

### Settings Overview

| Path | Description | Default |
| :--- | :--- | :--- |
| `server.port` | HTTP Port | `3000` |
| `server.logLevel` | Logging level (pino) | `info` |
| `security.apiKey` | Master token for API access | `changeme` |
| `scheduler.enabled` | Enable background checks | `true` |
| `scheduler.intervalMs` | Interval between checks | `600000` (10m) |
| `ondemand.enabled` | Enable the REST API | `true` |

### Account Configuration

Each account in the `accounts` array can have:
- `id`: Unique identifier for logging/API.
- `token`: (Optional) A dedicated token for legacy GET access to this account.
- `credentials`: OVH endpoint and keys.
- `domains`: List of domains and subdomains (use `@` for root).

```yaml
accounts:
  - id: 'my-home-server'
    token: 'my-secret-path-token'
    enabled: true
    credentials:
      endpoint: 'ovh-eu'
      appKey: '...'
      appSecret: '...'
      consumerKey: '...'
    domains:
      - name: 'example.com'
        subdomains: ['@', 'vpn', 'cloud']
```

## API Reference

All on-demand routes are prefixed with `/api`.

### Public Endpoints
- `GET /health`: Liveness check.
- `GET /api/public-ip`: Returns the currently detected public IP.

### Management (Requires `Authorization: Bearer <apiKey>`)
- `POST /api/sync`: Force a check and update for all enabled accounts.
- `POST /api/accounts/:id/sync`: Sync only a specific account.

### Legacy / Mikrotik (Requires valid `:token` in path)
Compatible with devices that can only perform GET requests. The `:token` can be either the `apiKey` or the specific account `token`.

- `GET /api/:token/checkip`: Trigger a global sync.
- `GET /api/:token/setip/:ip`: Force a specific IP update for all accounts.

## Running

```bash
# Development
pnpm dev

# Production
pnpm start
```

### Docker
```bash
docker build -t ovh-dns-updater-ng .
docker run -p 3000:3000 -v ./config:/app/config ovh-dns-updater-ng
```

## Testing

The project maintains high coverage (90%+) using Vitest.

```bash
pnpm test          # Run tests
pnpm test:coverage # Generate coverage report
```

## License
MIT

