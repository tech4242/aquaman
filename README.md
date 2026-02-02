# 🔱🦞🪸 aquaman-clawed

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

- **Credential isolation** - API keys in macOS Keychain, not stored in OpenClaw config files
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

## Security Model & Limitations

**Understand what this is and isn't.**

### What aquaman-clawed Does

- Moves credentials from `~/.openclaw/auth-profiles.json` to macOS Keychain
- Proxies API calls and injects credentials server-side
- Logs all tool calls with tamper-evident hash chains
- Pattern-matches dangerous commands and blocks/requires approval

### What It Does NOT Do

**aquaman-clawed is not a sandbox.** OpenClaw runs as a separate process, not a child process under our control. Security is enforced by:

1. Modifying OpenClaw's config to route traffic through our proxies
2. Trusting that OpenClaw respects that configuration

If OpenClaw (or a prompt injection attack) decides to bypass the proxy and call APIs directly, make raw HTTP requests, or read process memory, there's nothing stopping it.

```
┌─────────────────────────────────────────────────────────────┐
│  What we provide        vs.      What we don't provide      │
├─────────────────────────────────────────────────────────────┤
│  ✓ Credential separation         ✗ Process isolation        │
│  ✓ Tamper-evident audit logs     ✗ Tamper-proof logs        │
│  ✓ Pattern-based guardrails      ✗ Semantic intent analysis │
│  ✓ Configuration-level routing   ✗ Enforced network policy  │
└─────────────────────────────────────────────────────────────┘
```

### Threat Model

**Protected against:**
- Prompt injection trying to read credential files (they're cleared)
- Accidental dangerous commands (`rm -rf /`, `curl | sh`)
- Post-incident forensics (audit trail exists)
- Casual credential exfiltration via OpenClaw's normal tool calls

**NOT protected against:**
- Fully malicious/compromised OpenClaw binary
- Root/admin-level attackers
- Sophisticated command evasion (encoding, quoting tricks)
- Direct network requests bypassing the proxy

### OpenClaw's Built-in Sandboxing

OpenClaw itself offers Docker-based sandboxing for non-main sessions:

```yaml
# In ~/.openclaw/openclaw.yaml
agents:
  defaults:
    sandbox:
      mode: "non-main"  # Isolates group/channel sessions in containers
```

This is **stronger isolation** than aquaman-clawed provides. Consider using both:
- OpenClaw's sandbox for process isolation
- aquaman-clawed for credential separation and audit logging

### For True Isolation

If you need hard security boundaries, run OpenClaw in a container:

```bash
docker run -it --rm \
  --network=host \  # Or restrict to only reach aquaman proxy
  -v ~/workspace:/workspace:ro \
  -e OPENCLAW_API_BASE=http://host.docker.internal:8081 \
  openclaw/openclaw
```

This provides:
- Filesystem isolation (only mounted paths accessible)
- Network namespace (can restrict to proxy only)
- No access to host Keychain, ~/.ssh, etc.

## License

MIT
