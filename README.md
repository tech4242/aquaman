# 🔱🦞🪸 aquaman 

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Security control plane for OpenClaw - audit logging, guardrails, and credential isolation.

Zero-trust credential isolation for **OpenClaw Gateway**. API keys never enter the Gateway process—they're stored in secure backends and injected by a separate proxy.

## The Problem

AI agents are vulnerable to prompt injection — and when an agent has API keys in its environment, a single compromised tool call can exfiltrate every credential it can reach.

Detection-based approaches catch exposure *after* the fact. Aquaman makes exfiltration **technically impossible**: credentials exist in a separate OS process that the agent cannot access.

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │──request────>│  Keychain / 1Pass /  │
│  = localhost:8081    │              │  Vault / Encrypted   │
│                      │<─response────│                      │
│  No credentials.     │              │  + Auth header       │
│  Nothing to steal.   │              │  injected on-the-fly │
│                      │              │                      │
└──────────────────────┘              └──────────┬───────────┘
                                                 │
                                                 ▼
                                       api.anthropic.com
```

1. **Store** — Credentials live in a vault backend (Keychain, 1Password, HashiCorp Vault, or an encrypted file)
2. **Proxy** — Aquaman runs a reverse proxy in a separate process, listening on localhost
3. **Inject** — When the agent makes an API call, the proxy looks up the credential and adds the auth header before forwarding upstream

The agent only knows a localhost URL. It never sees a key.

## Quick Start

### OpenClaw Plugin (recommended)

```bash
cp -r packages/openclaw ~/.openclaw/extensions/aquaman
aquaman credentials add anthropic api_key
# Plugin auto-starts proxy when Gateway launches
```

### Standalone

```bash
npm install -g @aquaman/proxy
aquaman init                            # Create config + generate TLS certs
aquaman credentials add anthropic api_key
aquaman daemon                          # Start proxy
```

## Why Aquaman

**Security** — Process-level isolation, zero-trust credential access, tamper-evident audit logs with SHA-256 hash chains

**DevOps** — Plugs into Keychain, 1Password, and HashiCorp Vault; YAML-based service config; optional TLS between agent and proxy

**Developers** — Transparent reverse proxy, no SDK changes, works with any OpenClaw workflow or standalone app

## Credential Backends

| Backend | Best For | Setup |
|---------|----------|-------|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin` |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |

**Guidance:** Use `keychain` for solo macOS development, `encrypted-file` for Linux servers and CI, `1password` for teams, `vault` for enterprise.

## Plugin vs Standalone

| | Plugin Mode | Standalone Mode |
|-|-------------|-----------------|
| **Setup** | Copy to `~/.openclaw/extensions/` | `npm install -g @aquaman/proxy` |
| **Lifecycle** | Managed by Gateway | Manual `aquaman daemon` / `aquaman stop` |
| **Use case** | OpenClaw users | Any application |
| **Config** | `openclaw.json` | `~/.aquaman/config.yaml` |

The plugin supports two sub-modes: **proxy** (maximum isolation — credentials in a separate process) and **embedded** (simpler setup — credentials loaded in-process with OpenClaw redaction). Both provide audit logging.

## Audit & Compliance

Every credential access is recorded in a hash-chained audit log:

```bash
aquaman audit tail               # View recent credential access events
aquaman audit verify             # Verify chain integrity (detect tampering)
aquaman audit rotate             # Archive current log, start fresh
```

Each log entry includes a SHA-256 hash linking to the previous entry — tampering with any record breaks the chain. Logs are stored as JSONL at `~/.aquaman/audit/` with WAL-based crash recovery.

**What gets logged:** credential access (read/use/rotate), tool calls, and tool results.

## Security Model

**What aquaman protects against:**
- Prompt injection attempting to exfiltrate API keys
- Environment variable scraping (`$ANTHROPIC_API_KEY` doesn't exist)
- Agent process memory dumps (credentials are in a different process)

**What aquaman does NOT protect against:**
- PII or sensitive data in model outputs
- Destructive commands (file deletion, resource modification)
- Compromise of the proxy process itself

Aquaman is complementary to sandbox-based tools — it handles credential isolation while sandboxes handle execution containment.

## Configuration

`~/.aquaman/config.yaml`:

```yaml
credentials:
  backend: keychain          # keychain | encrypted-file | 1password | vault
  proxyPort: 8081
  proxiedServices:
    - anthropic
    - openai
    - github
    - slack
    - discord
  tls:
    enabled: true
    autoGenerate: true

audit:
  enabled: true
  logDir: ~/.aquaman/audit
```

## CLI Reference

**Credentials**
```
aquaman credentials add <service> <key>       Add a credential
aquaman credentials list                      List stored credentials
aquaman credentials delete <service> <key>    Remove a credential
```

**Proxy**
```
aquaman start [--workspace <path>]            Start proxy + launch OpenClaw
aquaman daemon                                Run proxy in foreground
aquaman stop                                  Stop running daemon
aquaman status                                Show config and proxy status
```

**Audit**
```
aquaman audit tail [-n <count>]               Recent audit entries
aquaman audit verify                          Verify hash chain integrity
aquaman audit rotate                          Archive and rotate log
```

**Setup & Services**
```
aquaman init [--force] [--no-tls]             Initialize config + TLS certs
aquaman configure [--method env|dotenv|shell-rc]  Generate env config
aquaman services list [--builtin] [--custom]  List configured services
aquaman services validate                     Validate services.yaml
```

## Custom Services

Aquaman ships with 5 builtin services: **Anthropic**, **OpenAI**, **GitHub**, **Slack**, and **Discord**.

Add your own in `~/.aquaman/services.yaml`:

```yaml
services:
  - name: internal-llm
    upstream: https://llm.company.com/v1
    authHeader: X-API-Key
    credentialKey: api_key
```

## Architecture

Monorepo with three packages:

| Package | Role |
|---------|------|
| `@aquaman/core` | Credential backends, audit logger, crypto utilities |
| `@aquaman/proxy` | HTTP/HTTPS proxy daemon and CLI |
| `@aquaman/openclaw` | OpenClaw Gateway plugin (embedded + proxy modes) |

## License

MIT
