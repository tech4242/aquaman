# aquaman-clawed

Security wrapper for OpenClaw - audit logging, guardrails, and credential isolation.

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

## Why a Wrapper, Not a Fork?

OpenClaw is a great project - a truly personal AI assistant across all messaging platforms, self-hosted, hackable. Security just wasn't the first priority, which is understandable for a fast-moving open source project.

aquaman-clawed wraps OpenClaw without forking because:

- **No maintenance burden** - Works with any OpenClaw version
- **Optional by design** - Enable when you need it, disable when you don't
- **Separation of concerns** - Security layer shouldn't be mixed into app code
- **Respect for the project** - Adding security, not competing

## Quick Start

```bash
# Install
npm install -g aquaman-clawed

# Initialize (backs up and configures OpenClaw automatically)
aquaman init

# Add your API keys to secure storage
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key

# Start the security wrapper
aquaman start
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        aquaman-clawed                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  OpenClaw ──> Credential Proxy ──> Anthropic/OpenAI APIs            │
│               localhost:8081       (real credentials added here)    │
│               (no API key)                                          │
│                                                                     │
│  ┌─────────────────┐                                                │
│  │  Audit Logger   │ ──> ~/.aquaman/audit/current.jsonl             │
│  │  (hash-chained) │     (tamper-evident)                           │
│  └────────┬────────┘                                                │
│           │                                                         │
│           │ evaluates every tool call                               │
│           ▼                                                         │
│  ┌─────────────────┐                                                │
│  │  Alert Engine   │ "rm -rf /"    → BLOCKED                        │
│  │                 │ "sudo ..."    → APPROVAL REQUIRED              │
│  │                 │ "~/.ssh/*"    → BLOCKED                        │
│  └─────────────────┘                                                │
│                                                                     │
│  Credentials: macOS Keychain (not in ~/.openclaw/)                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Features

- **Credential isolation** - API keys in macOS Keychain, never exposed to OpenClaw
- **Audit logging** - Hash-chained logs of all tool calls
- **Guardrails** - Block dangerous commands (`rm -rf /`, `curl | sh`, etc.)
- **Approval workflows** - Require approval for sensitive operations (CLI or Slack/Discord)

## CLI Commands

```bash
aquaman init                         # Initialize and configure OpenClaw
aquaman start                        # Start security wrapper

aquaman credentials add <svc> <key>  # Store API key securely
aquaman credentials list             # List stored credentials
aquaman credentials delete <svc> <key>

aquaman audit tail                   # View recent audit entries
aquaman audit verify                 # Verify log integrity

aquaman pending                      # List pending approvals
aquaman approve <id>                 # Approve a request
aquaman deny <id>                    # Deny a request
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
                                        ✓ Approved: abc-123
```

Or configure Slack/Discord webhooks in `~/.aquaman/config.yaml` for remote approval.

## Configuration

Edit `~/.aquaman/config.yaml`:

```yaml
wrapper:
  proxyPort: 18790
  upstreamPort: 18789

audit:
  enabled: true
  logDir: ~/.aquaman/audit

permissions:
  files:
    allowedPaths: ['${HOME}/workspace/**']
    deniedPaths: ['~/.ssh/**', '**/.env', '**/*.pem']
  commands:
    deniedCommands: ['sudo', 'rm -rf /']
    dangerousPatterns: ['curl.*|.*sh']
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

## License

MIT
