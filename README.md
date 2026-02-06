# 🔱🦞 aquaman 

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vitest](https://img.shields.io/badge/Tested_with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Credential isolation proxy for OpenClaw — secrets stay submerged, agents stay dry.

Credential isolation for **OpenClaw Gateway**. API keys and channel tokens never enter the Gateway process—they're stored in secure backends and injected by a separate proxy. Supports 21 services out of the box: LLM providers, messaging channels, voice providers, and more.

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

1. **Store** — Credentials live in a vault backend (Keychain, 1Password, HashiCorp Vault, or an encrypted file)
2. **Proxy** — Aquaman runs a reverse proxy in a separate process, listening on localhost
3. **Inject** — When the agent makes an API call, the proxy looks up the credential and adds the auth header before forwarding upstream

The agent only knows a localhost URL. It never sees a key.

## Quick Start

### OpenClaw Plugin (recommended)

**1. Install the plugin and CLI:**

```bash
openclaw plugins install aquaman-plugin
npm install -g aquaman-proxy
```

**2. Initialize and add credentials:**

```bash
aquaman init
aquaman credentials add anthropic api_key
# Prompts for key — stored in Keychain, never on disk in plaintext
```

**3. Register a placeholder key with OpenClaw:**

OpenClaw requires an API key in its auth store before making requests. The proxy will replace it with the real key from your vault:

```bash
mkdir -p ~/.openclaw/agents/main/agent
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << 'EOF'
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "aquaman-proxy-managed"
    }
  },
  "order": { "anthropic": ["anthropic:default"] }
}
EOF
```

**4. Configure plugin in `~/.openclaw/openclaw.json`:**

```json
{
  "plugins": {
    "entries": {
      "aquaman-plugin": {
        "enabled": true,
        "config": {
          "mode": "proxy",
          "backend": "keychain",
          "services": ["anthropic", "openai"],
          "proxyPort": 8081
        }
      }
    }
  }
}
```

> **Note:** The plugin config schema only accepts `mode`, `backend`, `services`, and `proxyPort`. Other options (TLS, audit, vault settings) are configured in `~/.aquaman/config.yaml`.

**5. Launch OpenClaw:**

```bash
openclaw
```

The plugin auto-starts the proxy, sets `ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic`, and routes all API calls through it. The placeholder key is replaced by the real credential from your vault — it never enters the Gateway process.

**Verify it works:**

```bash
openclaw agent --local --message "hello" --session-id test
```

### Docker (recommended for servers)

Run the proxy from a clean clone with no local Node/npm required:

```bash
git clone https://github.com/tech4242/aquaman.git && cd aquaman
cp docker/.env.example docker/.env
# Edit docker/.env — set AQUAMAN_BACKEND and credentials (see comments in file)
npm run docker:up   # or: docker compose -f docker/docker-compose.yml up -d
```

Add credentials (encrypted-file backend):

```bash
docker compose -f docker/docker-compose.yml run --rm aquaman credentials add anthropic api_key
```

Verify:

```bash
curl http://localhost:8081/_health
# {"status":"ok","uptime":12.3,"services":["anthropic","openai",...]}
```

Run `aquaman credentials guide` inside the container for backend-specific setup commands. For Vault or 1Password backends, set the relevant env vars in `docker/.env` and no credential seeding is needed.

To run OpenClaw with the aquaman plugin (full credential isolation for LLM + channel traffic):

```bash
docker compose -f docker/docker-compose.yml --profile with-openclaw up -d
```

This starts two containers:
- **aquaman** (`aquaman-proxy`) — credential proxy (manages all secrets, has internet access)
- **openclaw** (`openclaw-gateway`) — Gateway with aquaman plugin pre-installed (sandboxed, no direct internet)

The plugin's fetch interceptor redirects all API traffic through the proxy. The OpenClaw container cannot reach external APIs directly. Set `OPENCLAW_GATEWAY_TOKEN` in `docker/.env` for production (defaults to `aquaman-internal`).

For maximum isolation (adds OpenClaw's built-in tool sandbox):

```bash
docker compose -f docker/docker-compose.yml --profile with-openclaw-sandboxed up -d
```

This additionally runs tool execution in ephemeral Docker containers with no capabilities, read-only filesystems, and network access restricted to the aquaman proxy. Requires Docker socket access.

### Standalone

For use outside OpenClaw:

```bash
npm install -g aquaman-proxy
aquaman init                            # Create config + generate TLS certs
aquaman credentials add anthropic api_key
aquaman start                           # Start proxy + launch OpenClaw
# or: aquaman daemon                    # Run proxy only (no OpenClaw launch)
```

## Why Aquaman

**Security** — Process-level credential isolation, tamper-evident audit logs with SHA-256 hash chains

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
| **Setup** | `openclaw plugins install` | `npm install -g aquaman-proxy` |
| **Lifecycle** | Managed by Gateway | Manual `aquaman start` / `aquaman stop` |
| **Use case** | OpenClaw users | Any application |
| **Config** | `~/.openclaw/openclaw.json` | `~/.aquaman/config.yaml` |

The plugin supports two sub-modes:

| | Proxy Mode | Embedded Mode |
|-|------------|---------------|
| **Isolation** | Credentials in separate OS process | Credentials in Gateway process |
| **Security** | Agent cannot access keys even if compromised | Relies on OpenClaw redaction |
| **Setup** | Requires `aquaman` CLI installed | No extra binary needed |
| **Config** | `mode: "proxy"` | `mode: "embedded"` (default) |

Use **proxy mode** for production and high-security environments. Use **embedded mode** for quick local development.

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

### Plugin mode — `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "aquaman-plugin": {
        "enabled": true,
        "config": {
          "mode": "proxy",
          "backend": "keychain",
          "services": ["anthropic", "openai", "github"],
          "proxyPort": 8081
        }
      }
    }
  }
}
```

Plugin config accepts: `mode`, `backend`, `services`, `proxyPort`. For TLS, audit, vault, and 1Password settings, use the standalone config below — the proxy reads both.

### Standalone mode — `~/.aquaman/config.yaml`

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
    - telegram
    - twilio
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
aquaman credentials guide [--backend <b>]     Show setup commands for seeding credentials
                          [--service <name>]
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

**Migration**
```
aquaman migrate openclaw [--config <path>]    Migrate channel creds from openclaw.json
                         [--dry-run]          to secure store
                         [--overwrite]
```

**Setup & Services**
```
aquaman init [--force] [--no-tls]             Initialize config + TLS certs
aquaman configure [--method env|dotenv|shell-rc]  Generate env config
aquaman services list [--builtin] [--custom]  List configured services
aquaman services validate                     Validate services.yaml
```

## Custom Services

Aquaman ships with 21 builtin services covering LLM providers, messaging channels, and voice/media APIs:

| Category | Services |
|----------|----------|
| **LLM / AI** | Anthropic, OpenAI, GitHub |
| **Header auth channels** | Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, ElevenLabs, Zalo |
| **URL-path auth** | Telegram |
| **HTTP Basic auth** | Twilio, BlueBubbles, Nextcloud Talk |
| **OAuth** | MS Teams, Feishu, Google Chat |
| **At-rest storage** | Nostr, Tlon |

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
| `aquaman-core` | Credential backends, audit logger, crypto utilities |
| `aquaman-proxy` | HTTP/HTTPS proxy daemon and CLI |
| `aquaman-plugin` | OpenClaw Gateway plugin (embedded + proxy modes) |

## License

MIT
