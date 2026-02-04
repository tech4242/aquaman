# CLAUDE.md

## What This Is

Zero-trust credential isolation for **OpenClaw Gateway**. API keys never enter the Gateway process—they're stored in secure backends and injected by a separate proxy.

**Target platform:** OpenClaw Gateway on Unix-like systems (Linux, macOS, WSL2). The Gateway is OpenClaw's core server component—a Node.js/TypeScript service that runs as a systemd user service (Linux/WSL2) or LaunchAgent (macOS).

## Architecture Decision: Isolation vs Detection

We chose **process isolation** over **detection-based** approaches.

| Approach | How It Works | Weakness |
|----------|--------------|----------|
| **Detection** | Intercepts tool calls, redacts secrets after exposure | Credentials ARE in agent memory—redaction happens after the fact |
| **Isolation** (aquaman) | Credentials in separate process, agent only sees proxy URL | Even RCE in agent can't exfiltrate keys |

The proxy architecture means a compromised agent literally cannot access credentials—they exist in a different address space.

```
Agent Process                    Proxy Process (aquaman)
┌────────────────────┐           ┌────────────────────┐
│ ANTHROPIC_BASE_URL │──HTTP───>│ Keychain/Vault/1P  │
│ = localhost:8081   │           │ Injects auth header│
│                    │<─────────│ Forwards to API    │
│ NO credentials     │           │ Writes audit log   │
└────────────────────┘           └────────────────────┘
```

## Monorepo Structure

```
packages/
├── core/       # @aquaman/core - credential stores, audit logger, crypto
├── proxy/      # @aquaman/proxy - HTTP proxy daemon, CLI
└── openclaw/   # @aquaman/openclaw - OpenClaw plugin
```

## OpenClaw Gateway Integration

The plugin (`packages/openclaw/`) integrates with the OpenClaw Gateway's plugin SDK. Plugins run inside the Gateway process and have access to lifecycle hooks, CLI registration, and tool registration.

**How it works:**
1. Plugin exports `register(api)` function (not a class)
2. On load: sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` to route through proxy
3. On `onGatewayStart`: spawns `aquaman plugin-mode --port 8081` as child process
4. On `onGatewayStop`: kills proxy process (SIGTERM)
5. Registers `/aquaman` CLI commands and `aquaman_status` tool

**Why this matters:** The Gateway makes LLM API calls (Anthropic, OpenAI) on behalf of agents. By intercepting these at the environment variable level, we route all LLM traffic through our proxy without modifying OpenClaw itself.

**Key files:**
- `index.ts` - Plugin entry point with `export default function register(api)`
- `openclaw.plugin.json` - Manifest with `id: "aquaman"`, config schema
- `package.json` - Has `openclaw.extensions: ["./index.ts"]`

**Installation location:** `~/.openclaw/extensions/aquaman/`

**Why plugin + proxy (not pure plugin):**
A pure plugin would fetch credentials into Gateway memory—defeating isolation. Our plugin only manages the proxy lifecycle; credentials never enter OpenClaw's process.

**Unix assumption:** The plugin uses `which aquaman` to detect the CLI and spawns processes with Unix semantics. This matches the Gateway's supported platforms.

## Development Commands

```bash
npm test                    # All tests
npm run test:e2e            # E2E tests (including OpenClaw plugin)
npm run build               # Build all packages
npm run typecheck           # TypeScript validation
npm run lint                # oxlint

# Run proxy directly
npm start                   # Start daemon
npm run dev                 # Dev mode with watch
```

## Credential Backends

Since the Gateway runs on Unix-like systems, backend choice depends on deployment:

| Backend | Platform | Use Case |
|---------|----------|----------|
| `keychain` | macOS (LaunchAgent) | Local dev, personal machines |
| `encrypted-file` | Linux, WSL2, CI/CD | Servers without native keyring |
| `1password` | Any (via `op` CLI) | Team credential sharing |
| `vault` | Any (via HTTP API) | Enterprise secrets management |

## Testing the OpenClaw Plugin

```bash
# Install plugin to OpenClaw
cp -r packages/openclaw ~/.openclaw/extensions/aquaman

# Verify it loads
openclaw plugins list 2>&1 | grep -A2 aquaman

# Run E2E tests
npm run test:e2e -- test/e2e/openclaw-plugin.test.ts
```

## Key Design Principles

1. **Credentials never in agent memory** - Proxy injects auth, agent sees nothing
2. **Hash-chained audit logs** - Tamper-evident, compliance-ready
3. **Multiple backends** - From Keychain (simple) to Vault (enterprise)
4. **OpenClaw-native** - Plugin follows OpenClaw SDK patterns exactly

## Files to Know

| File | Purpose |
|------|---------|
| `packages/core/src/credentials/store.ts` | Backend abstraction |
| `packages/core/src/audit/logger.ts` | Hash-chained logging |
| `packages/proxy/src/daemon.ts` | HTTP proxy server |
| `packages/openclaw/index.ts` | OpenClaw plugin entry |
| `test/e2e/openclaw-plugin.test.ts` | Plugin integration tests |
