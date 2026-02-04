# aquaman-clawed

Credential isolation for AI agents. Your API keys never touch the agent process.

## The Problem

AI agents can read files, execute commands, and access the filesystem. If an agent is compromised through prompt injection, any credentials in its environment or accessible files can be exfiltrated.

Storing API keys in environment variables or `.env` files means a single malicious prompt could steal them all.

## The Solution

aquaman-clawed runs a credential proxy that:

1. **Stores API keys in secure backends** - Keychain, 1Password, or HashiCorp Vault
2. **Proxies API requests** - Intercepts calls and injects auth headers on-the-fly
3. **Never exposes credentials** - The agent process only sees proxy URLs, never actual keys

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌──────────────────┐         ┌─────────────────────────────┐  │
│  │  Credential      │ HTTPS   │  AI Agent                   │  │
│  │  Proxy :8081     │◄────────│  (uses ANTHROPIC_BASE_URL   │  │
│  │                  │         │   pointing to proxy)        │  │
│  │  - Keychain      │         │                             │  │
│  │  - 1Password     │         │  API keys NEVER here        │  │
│  │  - Vault         │         └─────────────────────────────┘  │
│  └────────┬─────────┘                                          │
│           │                                                    │
│           │ Adds auth headers                                  │
│           ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  api.anthropic.com / api.openai.com / etc.              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Audit Log: ~/.aquaman/audit/current.jsonl (hash-chained)      │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
npm install -g aquaman-clawed

# Initialize configuration and TLS certificates
aquaman init

# Add your API keys to secure storage
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key

# Start credential proxy
aquaman start
```

## Features

| Feature | Description |
|---------|-------------|
| **Credential Proxy** | API keys injected via HTTPS proxy, never exposed to agents |
| **1Password Integration** | Team credential sharing via `op` CLI |
| **HashiCorp Vault** | Enterprise secrets management with rotation support |
| **Hash-chained Audit Logs** | Tamper-evident, append-only logging for compliance |
| **Custom Service Registry** | Define your own API endpoints via YAML |

## CLI Reference

```bash
# Lifecycle
aquaman start                    # Start credential proxy
aquaman start --no-launch        # Start proxy only (daemon mode)
aquaman start --dry-run          # Show configuration without starting
aquaman stop                     # Stop the daemon
aquaman status                   # Show configuration and status

# Configuration
aquaman init                     # Initialize config + TLS certs
aquaman configure                # Generate environment vars
aquaman configure --method dotenv   # Write to .env.aquaman file

# Credentials (stored in secure backend)
aquaman credentials add <service> <key>
aquaman credentials list
aquaman credentials delete <service> <key>

# Services (custom API configurations)
aquaman services list
aquaman services list --custom   # Show only user-defined services
aquaman services validate        # Validate services.yaml

# Audit
aquaman audit tail               # View recent entries
aquaman audit verify             # Verify hash chain integrity
aquaman audit rotate             # Archive current log
```

## Configuration

Edit `~/.aquaman/config.yaml`:

```yaml
credentials:
  backend: keychain          # keychain | 1password | vault | encrypted-file
  proxyPort: 8081
  proxiedServices:
    - anthropic
    - openai
    - slack
    - discord
    - github
  tls:
    enabled: true
    autoGenerate: true

audit:
  enabled: true
  logDir: ~/.aquaman/audit

services:
  configPath: ~/.aquaman/services.yaml
```

## Credential Backends

| Backend | Use Case | Setup |
|---------|----------|-------|
| `keychain` | macOS local development | Default, no setup needed |
| `encrypted-file` | Linux, CI/CD | Set `AQUAMAN_ENCRYPTION_PASSWORD` |
| `1password` | Team sharing, enterprise | Install `op` CLI, sign in |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |

### Using 1Password

```bash
# Install 1Password CLI
brew install --cask 1password/tap/1password-cli

# Sign in
op signin

# Configure aquaman to use 1Password
# Edit ~/.aquaman/config.yaml:
#   credentials:
#     backend: 1password
#     onePasswordVault: aquaman-clawed

# Add credentials
aquaman credentials add anthropic api_key
```

### Using HashiCorp Vault

```bash
# Set Vault environment
export VAULT_ADDR=https://vault.company.com:8200
export VAULT_TOKEN=hvs.xxxxx

# Configure aquaman
# Edit ~/.aquaman/config.yaml:
#   credentials:
#     backend: vault
#     vaultMountPath: secret

# Add credentials
aquaman credentials add anthropic api_key
```

## Custom Services

Add your own API endpoints in `~/.aquaman/services.yaml`:

```yaml
services:
  - name: github
    upstream: https://api.github.com
    authHeader: Authorization
    authPrefix: "Bearer "
    credentialKey: token
    description: GitHub API

  - name: internal-llm
    upstream: https://llm.internal.company.com/v1
    authHeader: X-API-Key
    credentialKey: api_key
    description: Internal LLM service
```

Then add to proxied services in `~/.aquaman/config.yaml`:

```yaml
credentials:
  proxiedServices:
    - anthropic
    - openai
    - github
    - internal-llm
```

## Audit Logs

The audit log uses hash chains for tamper detection:

```bash
# Verify integrity
aquaman audit verify

# View recent entries
aquaman audit tail -n 50

# Each entry contains:
# - previousHash: links to prior entry
# - hash: SHA-256 of (previousHash + entry data)
# - Tampering breaks the chain
```

## Environment Variables

When aquaman starts, it sets these environment variables:

```bash
ANTHROPIC_BASE_URL=https://127.0.0.1:8081/anthropic
OPENAI_BASE_URL=https://127.0.0.1:8081/openai
GITHUB_API_URL=https://127.0.0.1:8081/github
# ... one for each proxied service
```

Generate these manually with:

```bash
aquaman configure
# Output: export ANTHROPIC_BASE_URL="https://127.0.0.1:8081/anthropic"
```

## License

MIT
