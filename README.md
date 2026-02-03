# 🔱🦞🪸 aquaman-clawed

Secure sandbox control plane for OpenClaw - credential isolation, audit logging, and guardrails.

## Prerequisites

- **Docker** (required) - [Install Docker](https://docs.docker.com/get-docker/)
- **Node.js 20+** - For the aquaman CLI
- **macOS or Linux** - Both supported
  - macOS: Uses Keychain for credential storage
  - Linux: Uses encrypted-file backend

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

| Features | How It's Enforced |
|-----------|-------------------|
| **Network isolation** | Docker `internal: true` network - container has NO internet access |
| **Credential isolation** | API keys stored in Keychain, injected via proxy, never in container |
| **API interception** | Container can ONLY reach aquaman proxy - all calls audited |
| **Audit completeness** | All traffic flows through hash-chained, tamper-evident audit log |
| **Approval enforcement** | Dangerous operations actually blocked until approved |
| **No Docker = No run** | Requires Docker - no "local mode" with weaker guarantees |

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
  backend: keychain  # or: encrypted-file

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
