# 🔱🦞🪸 aquaman-clawed

Security control plane for OpenClaw - audit logging, guardrails, and credential isolation.

## Why This Exists

```
┌─────────────────────────────────────────────────────────────────┐
│  WITHOUT aquaman-clawed                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐         ┌─────────────────────────────────┐   │
│  │  OpenClaw   │ ──────> │  ~/.openclaw/auth-profiles.json │   │
│  │   Agent     │  CAN    │  (plaintext API keys!)          │   │
│  │             │  READ   │  - Claude API key               │   │
│  │  "Read my   │         │  - OpenAI key                   │   │
│  │  config"    │         │  - Slack/Discord tokens         │   │
│  └─────────────┘         └─────────────────────────────────┘   │
│        │                                                        │
│        │  Prompt injection → credentials leaked                 │
│        ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Credentials exfiltrated via file_read or message_send   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
npm install -g aquaman-clawed

# Add your API keys to secure storage
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key

# Start the secure sandbox (requires Docker)
aquaman start

# Or run in background
aquaman start --detach
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                          HOST MACHINE                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  aquaman (control plane container)                             │ │
│  │                                                                 │ │
│  │  Gateway Proxy :18790  ──> Intercepts all tool calls          │ │
│  │  Credential Proxy :8081 ──> Injects API keys from Keychain    │ │
│  │  Audit Logger ──────────> Hash-chained tamper-evident logs    │ │
│  │  Alert Engine ──────────> Blocks dangerous patterns           │ │
│  │  Approval Manager ──────> Requires approval for sudo, etc.    │ │
│  │                                                                 │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                               │                                     │
│                    aquaman_net (internal, NO internet)              │
│                               │                                     │
│  ┌───────────────────────────▼───────────────────────────────────┐ │
│  │  openclaw (sandboxed container)                                │ │
│  │                                                                 │ │
│  │  - NO credential files mounted                                 │ │
│  │  - NO access to ~/.ssh, ~/.aws, ~/.gnupg                       │ │
│  │  - Workspace: /workspace (your project, optionally read-only) │ │
│  │  - Can ONLY reach aquaman proxy (no internet)                  │ │
│  │  - OpenClaw sandbox mode enabled for double isolation          │ │
│  │                                                                 │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  Credentials: Stored in macOS Keychain (never in container)        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Security Features

| Feature | Description |
|---------|-------------|
| **Container Isolation** | OpenClaw runs in Docker with no internet access |
| **Credential Proxy** | API keys injected via HTTPS, never in container |
| **TLS Encryption** | Self-signed certs, no external CA needed |
| **Audit Logging** | Hash-chained, tamper-evident logs |
| **Secret Redaction** | 16+ patterns auto-redacted from logs |
| **Approval Workflow** | Block dangerous commands until approved |
| **macOS Keychain** | Native credential storage |
| **Encrypted File** | AES-256-GCM with PBKDF2 |
| **1Password** | Team credential sharing via `op` CLI |
| **HashiCorp Vault** | Enterprise secrets management |
| **Custom Services** | YAML-based service registry |
| **Policy Engine** | Block/allow commands, files, network |

## Credential Backends

| Backend | Use Case | Setup |
|---------|----------|-------|
| `keychain` | macOS local development | Default, no setup |
| `encrypted-file` | Linux, CI/CD | Set encryption password |
| `1password` | Team sharing, enterprise | Install `op` CLI, sign in |
| `vault` | Enterprise secrets management | Vault server + token |

## CLI Commands

```bash
# Sandbox lifecycle
aquaman start                    # Start sandboxed OpenClaw
aquaman start -w ~/myproject     # Custom workspace
aquaman start --read-only        # Read-only workspace
aquaman start --detach           # Run in background
aquaman stop                     # Stop everything
aquaman status                   # Show container status
aquaman logs [-f]                # View logs

# Credentials (stored on host, never in container)
aquaman credentials add <svc> <key>  # Store API key securely
aquaman credentials list             # List stored credentials
aquaman credentials delete <svc> <key>

# Services (custom API configurations)
aquaman services list            # List all configured services
aquaman services validate        # Validate services.yaml

# Audit
aquaman audit tail               # View recent audit entries
aquaman audit verify             # Verify log integrity

# Approval workflow
aquaman pending                  # List pending approvals
aquaman approve <id>             # Approve a request
aquaman deny <id>                # Deny a request
```

## Approval Flow

```
Terminal 1 (aquaman start):             Terminal 2:

  [APPROVAL REQUIRED]                   $ aquaman pending
  Request ID: abc-123
  Tool: bash                              ID: abc-123
  Reason: Sudo command                    Tool: bash
  Params: {"command": "sudo apt..."}      Reason: Sudo command

  Use: aquaman approve abc-123          $ aquaman approve abc-123
                                        Approved: abc-123
```

Or configure Slack/Discord webhooks in `~/.aquaman/config.yaml` for remote approval.

## Configuration

Edit `~/.aquaman/config.yaml`:

```yaml
sandbox:
  openclawImage: "openclaw/openclaw:latest"
  workspace:
    hostPath: "${HOME}/workspace"
    containerPath: "/workspace"
    readOnly: false
  resources:
    cpus: "2"
    memory: "4g"
  enableOpenclawSandbox: true  # Double isolation

audit:
  enabled: true
  logDir: ~/.aquaman/audit
  alertRules:
    - id: dangerous-command-pipe
      pattern: "curl.*\\|.*sh"
      action: block
      severity: critical

permissions:
  files:
    deniedPaths: ['~/.ssh/**', '**/.env', '**/*.pem']
  commands:
    deniedCommands: ['sudo', 'rm -rf /']
  network:
    defaultAction: deny
    allowedDomains: ['api.anthropic.com', 'api.openai.com']

credentials:
  backend: keychain  # or: encrypted-file, 1password, vault
  tls:
    enabled: true
    autoGenerate: true
  # For 1Password backend
  # onePasswordVault: aquaman-clawed
  # For Vault backend
  # vaultAddress: https://vault.company.com:8200

approval:
  timeout: 300
  defaultOnTimeout: deny
  channels:
    - type: console
    # - type: slack
    #   webhook: https://hooks.slack.com/...
```

## aquaman-clawed vs OpenClaw's Sandbox Mode

OpenClaw has its own sandbox mode (`sandbox.mode: "non-main"`). These are **complementary**:

| Feature | OpenClaw Sandbox | aquaman-clawed |
|---------|-----------------|----------------|
| **What it isolates** | Non-main sessions (groups/channels) | Entire OpenClaw instance |
| **Who manages containers** | OpenClaw | aquaman |
| **Credential storage** | Still in OpenClaw config | Keychain (never in container) |
| **Audit logging** | No | Hash-chained, tamper-evident |
| **Approval workflow** | No | Yes, with Slack/Discord |
| **Network isolation** | Per-session | Entire instance |

**Recommended:** Enable both for maximum security. aquaman automatically enables OpenClaw's sandbox mode inside the container (`enableOpenclawSandbox: true`).

## Quick Examples

```bash
# Use 1Password for credentials
aquaman config set credentials.backend 1password
aquaman credentials add anthropic api_key

# Use HashiCorp Vault
export VAULT_ADDR=https://vault.company.com:8200
export VAULT_TOKEN=hvs.xxxxx
aquaman config set credentials.backend vault
aquaman credentials add anthropic api_key

# Add custom service
cat >> ~/.aquaman/services.yaml << EOF
services:
  - name: github
    upstream: https://api.github.com
    authHeader: Authorization
    authPrefix: "Bearer "
    credentialKey: token
  - name: custom-llm
    upstream: https://llm.internal.company.com/v1
    authHeader: X-API-Key
    credentialKey: api_key
EOF
aquaman services validate

# Verify audit log has no leaked secrets
cat ~/.aquaman/audit/current.jsonl | grep -o 'sk-ant-[^"]*'  # Should be redacted
```

## Advanced: Generate Compose File

If you want to customize the Docker setup:

```bash
# Generate docker-compose.yml without starting
aquaman generate-compose -o ./docker-compose.yml

# Edit as needed, then:
docker compose up -d
```

## License

MIT
