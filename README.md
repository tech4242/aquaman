# 🔱🦞 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Credential isolation for OpenClaw — secrets stay submerged, agents stay dry.

You have bought yourself a brand new Mac Mini (or credits at your favorite cloud provider) and now you are still scared about your API credentials because you read all the articles. 

We get it.

With Aquaman API keys never enter the agent process. Aquaman stores them in a secure vault of your choosing and injects auth headers via a separate proxy. Even a fully compromised agent should not be able to exfiltrate your keys.

## Quick Start

### Local (macOS / Linux)

```bash
npm install -g aquaman-proxy
aquaman setup                             # stores keys, installs OpenClaw plugin
aquaman migrate openclaw --auto           # existing users: migrate plaintext secrets
openclaw                                  # proxy starts automatically via plugin
```

The plugin starts the proxy for you — no extra steps. To check
everything is wired up correctly:

```bash
aquaman doctor                 # diagnose issues with actionable fixes
aquaman help                   # list all commands
```

### Server (Docker)

Two-container deployment: aquaman (proxy, internet access) + OpenClaw
(gateway, internal network only — no direct internet access).

```bash
git clone https://github.com/tech4242/aquaman.git && cd aquaman
cp docker/.env.example docker/.env
# Edit docker/.env — set backend and credentials
docker compose -f docker/docker-compose.yml --profile with-openclaw up -d
```

For tool execution sandboxing (tools run in ephemeral containers with
read-only filesystem, dropped capabilities, network restricted to
proxy only):

```bash
docker compose -f docker/docker-compose.yml --profile with-openclaw-sandboxed up -d
```

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │──request────>│  Keychain / 1Pass /  │
│  = localhost:8081    │              │  Vault / Encrypted   │
│                      │<─response────│                      │
│  fetch() interceptor │──channel────>│  + Auth injected:    │
│  redirects channel   │   traffic    │    header / url-path │
│  API traffic         │              │    basic / oauth     │
│                      │              │                      │
│  No credentials.     │              │                      │
│  Nothing to steal.   │              │                      │
└──────────────────────┘              └───┬──────────┬───────┘
                                         │          │
                                         │          ▼
                                         │  ~/.aquaman/audit/
                                         │  (hash-chained log)
                                         ▼
                               api.anthropic.com
                               api.telegram.org
                               slack.com/api  ...
```

1. **Store** — Credentials live in a vault backend (Keychain, 1Password, Vault, encrypted file)
2. **Proxy** — Aquaman runs a reverse proxy in a separate process on localhost
3. **Inject** — Proxy looks up the credential and adds the auth header before forwarding

The agent only knows a localhost URL. It never sees a key.

## Credential Backends

| Backend | Best For | Setup |
|---------|----------|-------|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin` |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |

**Important:** `encrypted-file` is a last-resort backend for headless Linux/CI environments without a native keyring. For better security, install `libsecret-1-dev` (for GNOME Keyring) or use 1Password/Vault.

## Why Aquaman

**Security** — Process-level credential isolation, tamper-evident audit logs with SHA-256 hash chains

**DevOps** — Plugs into Keychain, 1Password, and HashiCorp Vault; YAML-based service config; 23 builtin services across 4 auth modes

**Developers** — Transparent reverse proxy, no SDK changes, works with any OpenClaw workflow or standalone app
