# OVH DNS Updater NextGen

[![Build Status](https://img.shields.io/badge/status-active-brightgreen.svg)]()
[![Type](https://img.shields.io/badge/stack-Fastify%20|%20TypeScript%20|%20Vitest-blue.svg)]()

A dynamic DNS updater for OVH accounts. It monitors your public IP address and automatically updates specified OVH DNS A-records when a change is detected. Unlike previous versions, this "NextGen" edition supports **multiple OVH accounts** and multiple domains/subdomains per account.

## Features

- **Multi-Account Support**: Manage different OVH credentials in a single instance.
- **Resilient IP Detection**: Rotates between multiple public IP providers to ensure detection even if one provider is down.
- **Smart Updates**: Only performs API requests if the IP actually changed (or if a record is out of sync).
- **Auto-Refresh**: Automatically triggers the zone refresh in OVH after updates.
- **REST API**: Control and monitor the service via HTTP.
- **Background Scheduler**: Runs automatically every 10 minutes (configurable).
- **Modern Stack**: Fastify v5, TypeScript, node-config, and Vitest.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v22 or higher.
- [pnpm](https://pnpm.io/) v10+.
- An OVH Account with API credentials (Application Key, Application Secret, Consumer Key). You can generate them at [https://api.ovh.com/createToken/](https://api.ovh.com/createToken/).

### Setup

1. Clone the repository and navigate to the project directory.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Create a local configuration (see [Configuration](#configuration) section).

## Configuration

The project uses `node-config`. You can find the base configuration in `config/default.yaml`. For local development, it is recommended to create a `config/local.yaml`.

### Example `config/local.yaml`

```yaml
server:
  port: 3000
  logLevel: 'debug'

security:
  adminToken: 'your-secure-token'

accounts:
  - id: 'personal-account'
    provider: 'ovh'
    enabled: true
    credentials:
      endpoint: 'ovh-eu'
      appKey: 'your-app-key'
      appSecret: 'your-app-secret'
      consumerKey: 'your-consumer-key'
    domains:
      - name: 'example.com'
        subdomains: 
          - '@' # Root domain
          - 'www'
          - 'vpn'
      - name: 'another-domain.es'
        subdomains: ['*'] 

  - id: 'work-account'
    # ... another set of credentials
```

### Environment Variables

You can also use environment variables as defined in `config/custom-environment-variables.yaml`:

- `ADMIN_TOKEN`: Maps to `security.adminToken`.
- `OVH_ACCOUNTS`: A JSON string representing the accounts array.

## Running the Service

### Development Mode

Runs with `tsx` and hot-reload:
```bash
pnpm dev
```

### Production Build

```bash
pnpm build
pnpm start
```

### Using Docker

```bash
docker build -t ovh-dns-updater-nextgen .
docker run -p 3000:3000 -v ./config:/usr/src/app/config ovh-dns-updater-nextgen
```

## API Reference

### Health Check
`GET /health` - Check if the service is running.

### Get Public IP
`GET /api/public-ip` - Returns the currently detected public IP.

### Global Sync
`POST /api/sync` - Forces a full synchronization of all enabled accounts.
- **Auth**: Requires `Authorization: Bearer <adminToken>`.

### Legacy Compatibility (Mikrotik / GET style)
These endpoints are designed for backward compatibility with routers (like Mikrotik) that perform GET requests with the token in the URL.

- `GET /api/:token/checkip` - Similar to `/api/sync` but using GET and path token.
- `GET /api/:token/setip/:ip` - Manually set a specific IP for all accounts using GET and path token.

## Development

### Testing
Tests are written with Vitest.
```bash
pnpm test       # Run once
pnpm test:watch # Run in watch mode
```

### Folder Structure
- `src/services`: Business logic (IP Detection, OVH Communication).
- `src/plugins`: Fastify plugins (Services injection, Scheduler).
- `src/routes`: API endpoints.
- `config/`: Configuration files.

## License
MIT
