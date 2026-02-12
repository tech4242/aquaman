# 🔱🦞 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![npm version](https://img.shields.io/npm/v/aquaman-proxy?label=aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![npm downloads](https://img.shields.io/npm/dm/aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![Security: process isolation](https://img.shields.io/badge/security-process%20isolation-critical)](https://github.com/tech4242/aquaman#how-it-works)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Credential isolation for OpenClaw — secrets stay submerged, agents stay dry.

You have bought yourself a brand new Mac Mini (or credits at your favorite cloud provider) and now you are still scared about your API credentials because you read all the articles. 

We get it.

With Aquaman API keys never enter the agent process. Aquaman stores them in a secure vault of your choosing and injects auth headers via a separate proxy. Even a fully compromised agent should not be able to exfiltrate your keys.

## Quick Start

### Local (macOS / Linux)

```bash
npm install -g aquaman-proxy              # install the proxy CLI
aquaman setup                             # stores keys, installs OpenClaw plugin
openclaw                                  # proxy starts automatically via plugin
```

> `aquaman setup` auto-detects your credential backend. macOS defaults to Keychain,
> Linux defaults to encrypted file. Override with `--backend`:
> `aquaman setup --backend keepassxc`
> Options: `keychain`, `encrypted-file`, `keepassxc`, `1password`, `vault`

Existing plaintext credentials are migrated automatically during setup.
The migration detects credentials from channels (Telegram, Slack, etc.)
**and** third-party plugins/skills (any `*token*`, `*key*`, `*secret*`,
`*password*` fields in `openclaw.json` plugin configs). Upstream URLs are
auto-detected from plugin config fields like `endpoint` or `baseUrl`.
Run again anytime to migrate new credentials: `aquaman migrate openclaw --auto`

The plugin starts the proxy for you — no extra steps. To check
everything is wired up correctly:

```bash
aquaman doctor                 # diagnose issues with actionable fixes
aquaman help                   # list all commands
```

### Docker Setup

Single-image deployment — same UDS architecture as local, containerized.

```bash
git clone https://github.com/tech4242/aquaman.git && cd aquaman
cp docker/.env.example docker/.env
# Edit docker/.env — pick a backend and set its credentials
# needless to say instead of .env you should handle your env properly but this is a starting point you can test.
npm run docker:build
npm run docker:run
```

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │══ Unix ════> │  Keychain / 1Pass /  │
│  = aquaman.local     │   Domain     │  Vault / Encrypted   │
│                      │<═ Socket ═══ │                      │
│  fetch() interceptor │══ (UDS) ══=> │  + Auth injected:    │
│  redirects channel   │              │    header / url-path │
│  API traffic         │              │    basic / oauth     │
│                      │              │                      │
│  No credentials.     │  ~/.aquaman/ │                      │
│  No open ports.      │  proxy.sock  │                      │
│  Nothing to steal.   │  (chmod 600) │                      │
└──────────────────────┘              └──┬──────────┬────────┘
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
2. **Proxy** — Aquaman runs a reverse proxy in a separate process, connected via Unix domain socket — no TCP port, no network exposure
3. **Inject** — Proxy looks up the credential and adds the auth header before forwarding

The agent only sees a sentinel hostname (`aquaman.local`). It never sees a key, and no port is open for other processes to probe.

## Credential Backends

| Backend | Best For | Setup |
|---------|----------|-------|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `keepassxc` | Existing KeePass users | Set `AQUAMAN_KEEPASS_PASSWORD` or key file |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin` |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |

**Important:** `encrypted-file` is a last-resort backend for headless Linux/CI environments without a native keyring. For better security, install `libsecret-1-dev` (for GNOME Keyring) or use 1Password/Vault.

## Security Audit

`openclaw security audit --deep` will report one `dangerous-exec` finding for the plugin. This is expected — spawning the proxy as a separate process is how aquaman keeps credentials out of the agent. `aquaman setup` adds the plugin to `plugins.allow` automatically so OpenClaw knows you trust it.

## Why Aquaman

**Security** — Process-level credential isolation via Unix domain socket (no TCP port, no network exposure). Socket file permissions (`chmod 600`) restrict access to the owning user. Tamper-evident audit logs with SHA-256 hash chains

**DevOps** — Plugs into Keychain, 1Password, and HashiCorp Vault; YAML-based service config; 23 builtin services across 4 auth modes

**Developers** — Transparent reverse proxy, no SDK changes, works with any OpenClaw workflow or standalone app
