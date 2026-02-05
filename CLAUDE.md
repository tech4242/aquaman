# CLAUDE.md

## What This Is

Zero-trust credential isolation for **OpenClaw Gateway**. API keys and channel tokens never enter the Gateway process—they're stored in secure backends and injected by a separate proxy. Covers LLM providers (Anthropic, OpenAI) **and** all OpenClaw channel credentials (Telegram, Slack, Discord, MS Teams, Matrix, LINE, Twitch, Twilio, etc.).

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
├── core/       # aquaman-core - credential stores, audit logger, crypto
├── proxy/      # aquaman-proxy - HTTP proxy daemon, CLI
└── openclaw/   # aquaman-plugin - OpenClaw plugin
```

## OpenClaw Gateway Integration

The plugin (`packages/openclaw/`) integrates with the OpenClaw Gateway's plugin SDK. Plugins run inside the Gateway process and have access to lifecycle hooks, CLI registration, and tool registration.

**How it works:**
1. Plugin exports `register(api)` function (not a class)
2. On load: sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` to route through proxy
3. On `onGatewayStart`: spawns `aquaman plugin-mode --port 8081` as child process
4. On `onGatewayStart`: activates `globalThis.fetch` interceptor to redirect channel API traffic through proxy
5. On `onGatewayStop`: deactivates interceptor, kills proxy process (SIGTERM)
6. Registers `/aquaman` CLI commands and `aquaman_status` tool

**Key files:**
- `index.ts` - Plugin entry point with `export default function register(api)` — this is the actual running code OpenClaw loads
- `src/plugin.ts` - Class-based plugin implementation (alternative architecture, used by standalone tests)
- `openclaw.plugin.json` - Manifest with `id: "aquaman-plugin"`, config schema
- `package.json` - Has `openclaw.extensions: ["./index.ts"]`, package name `aquaman-plugin`

**Installation location:** `~/.openclaw/extensions/aquaman-plugin/`

### Plugin Config Schema

The `openclaw.plugin.json` manifest defines `additionalProperties: false` with only these keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `"embedded"` \| `"proxy"` | `"embedded"` | Isolation mode |
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy |
| `proxyPort` | `number` | `8081` | Proxy listen port |

**Do NOT add extra keys** (like `proxyAutoStart`, `tlsEnabled`, `auditEnabled`) to `openclaw.json` — OpenClaw validates against the manifest schema and will reject them. Use `~/.aquaman/config.yaml` for advanced settings.

### OpenClaw Auth Profiles

OpenClaw checks its own auth store (`~/.openclaw/agents/<id>/agent/auth-profiles.json`) BEFORE making API calls. If no key is found, the request never reaches the proxy.

**Solution:** Register a placeholder key so OpenClaw proceeds with the request. The proxy strips it and injects the real credential.

```json
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
```

**Auth resolution order:** auth-profiles.json → env vars → config file → error

### Plugin ID Naming

The unscoped package name must match the manifest `id`.

- **Correct:** `aquaman-plugin` (package name matches manifest id `"aquaman-plugin"`)
- **Wrong:** `aquaman-openclaw` (name `aquaman-openclaw` ≠ manifest id `"aquaman-plugin"`)

## Known Issues & Fixes

### Keytar ESM/CJS Interop (Node 24+)

`keytar` is a CommonJS native module. When imported via `import()` in an ESM context, the exports are wrapped in a `default` property:

```typescript
// BROKEN: keytar.findCredentials is undefined
this.keytar = await import('keytar');

// FIXED: unwrap the default export
const mod: any = await import('keytar');
this.keytar = mod.default || mod;
```

**Location:** `packages/core/src/credentials/store.ts` — `KeychainStore.getKeytar()`

### Proxy Request Flow

**Standard (header auth):**
1. Agent sends request to `http://127.0.0.1:8081/anthropic/v1/messages`
2. Proxy parses service name from path (`anthropic`)
3. Looks up credential from vault: `anthropic/api_key`
4. Strips any existing auth header from the request
5. Injects real auth header: `x-api-key: <actual-key-from-vault>`
6. Forwards to upstream: `https://api.anthropic.com/v1/messages`
7. Response piped back to agent
8. Access logged in audit trail with hash chaining

**Channel traffic (via fetch interceptor):**
1. Channel code calls `fetch('https://api.telegram.org/bot.../sendMessage')`
2. `globalThis.fetch` interceptor matches hostname → service name
3. Rewrites URL to `http://127.0.0.1:8081/telegram/sendMessage`
4. Proxy handles auth based on `authMode`:
   - `header`: injects auth header (Anthropic, OpenAI, GitHub, Slack, Discord, Matrix, Mattermost, LINE, Twitch, ElevenLabs, Telnyx, Zalo)
   - `url-path`: rewrites path to `/bot<TOKEN>/method` (Telegram)
   - `basic`: injects `Authorization: Basic base64(user:pass)` (Twilio, BlueBubbles, Nextcloud Talk)
   - `oauth`: exchanges client credentials for access token (MS Teams, Feishu, Google Chat)
   - `none`: at-rest storage only, proxy rejects traffic (Nostr, Tlon)
5. Forwards to upstream, response piped back

## Development Commands

```bash
npm test                    # All tests
npm run test:e2e            # E2E tests (including OpenClaw plugin)
npm run build               # Build all packages
npm run build:core          # Build core only (needed after editing store.ts)
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

### Manual end-to-end test:

```bash
# 1. Install plugin
openclaw plugins install ./packages/openclaw
# or: cp -r packages/openclaw ~/.openclaw/extensions/aquaman-plugin

# 2. Sync after code changes
cp packages/openclaw/package.json ~/.openclaw/extensions/aquaman-plugin/package.json
cp packages/openclaw/index.ts ~/.openclaw/extensions/aquaman-plugin/index.ts
cp -r packages/openclaw/src/ ~/.openclaw/extensions/aquaman-plugin/src/

# 3. Rebuild core if store.ts changed
npm run build:core

# 4. Add test credential (dummy key for testing)
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
k.setPassword('aquaman', 'anthropic:api_key', 'sk-ant-test-key').then(() => console.log('stored'));
"

# 5. Create auth-profiles.json placeholder
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

# 6. Ensure openclaw.json has plugin config
cat > ~/.openclaw/openclaw.json << 'EOF'
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
EOF

# 7. Test via OpenClaw agent
openclaw agent --local --message "hello" --session-id test --json 2>&1 | head -8
```

### What success looks like:

```
[plugins] Aquaman plugin loaded
[plugins] aquaman CLI found, will start proxy on gateway start
[plugins] Set ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic
[plugins] Set OPENAI_BASE_URL=http://127.0.0.1:8081/openai
[plugins] Aquaman plugin registered successfully
{ "payloads": [{ "text": "HTTP 401 authentication_error: invalid x-api-key ..." }] }
```

- **No mismatch warnings** — package name `aquaman-plugin` matches manifest id `"aquaman-plugin"`
- **Plugin loads and sets env vars** — `ANTHROPIC_BASE_URL` pointed to localhost proxy
- **401 from Anthropic** — confirms the proxy injected the dummy key (real key would get a response)
- **No credentials in agent process** — only the proxy URL was visible to the agent

### Automated tests:

```bash
npm run test:e2e                # All e2e tests (11 files)
npm run test:unit               # All unit tests (13 files)
npm test                        # Everything (~283 tests, 24 files)
```

### Quick proxy-only smoke test:

```bash
# Start proxy
npx tsx packages/proxy/src/cli/index.ts daemon &

# Curl through it (expect 401 with dummy key = proxy injected it)
curl -sk https://localhost:8081/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'

# Stop
npx tsx packages/proxy/src/cli/index.ts stop
```

## Manual Channel Testing

Step-by-step guide for manually testing credential injection across all auth modes.

### 1. Store test credentials

```bash
# Store dummy credentials for each auth mode
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
Promise.all([
  // Header auth
  k.setPassword('aquaman', 'anthropic:api_key', 'sk-ant-manual-test'),
  k.setPassword('aquaman', 'slack:bot_token', 'xoxb-manual-test-token'),
  k.setPassword('aquaman', 'discord:bot_token', 'discord-manual-test-token'),
  // URL-path auth
  k.setPassword('aquaman', 'telegram:bot_token', '123456:MANUAL-TEST-TOKEN'),
  // Basic auth
  k.setPassword('aquaman', 'twilio:account_sid', 'AC-manual-test-sid'),
  k.setPassword('aquaman', 'twilio:auth_token', 'manual-test-auth-token'),
]).then(() => console.log('All test credentials stored'));
"
```

### 2. Start the proxy

```bash
npx tsx packages/proxy/src/cli/index.ts plugin-mode --port 18081
# Should output JSON with ready:true
```

### 3. Test each auth mode

**Header auth (Anthropic):**
```bash
curl -s http://127.0.0.1:18081/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
# Expect: 401 from Anthropic (confirms proxy injected the test key)
```

**Header auth (Slack):**
```bash
curl -s http://127.0.0.1:18081/slack/auth.test
# Expect: {"ok":false,"error":"invalid_auth"} (confirms Bearer token injected)
```

**Header auth (Discord):**
```bash
curl -s http://127.0.0.1:18081/discord/api/v10/users/@me
# Expect: 401 from Discord (confirms Bot token injected)
```

**URL-path auth (Telegram):**
```bash
curl -s http://127.0.0.1:18081/telegram/getMe
# Expect: {"ok":false,"error_code":401} (token injected into URL path)
```

**Basic auth (Twilio):**
```bash
curl -s http://127.0.0.1:18081/twilio/2010-04-01/Accounts.json
# Expect: 401 from Twilio (Basic auth header injected)
```

### 4. Verify via CLI commands

```bash
# List stored credentials
npx tsx packages/proxy/src/cli/index.ts credentials list

# Check proxy status
npx tsx packages/proxy/src/cli/index.ts status
```

### 5. Check audit logs

```bash
# Logs are written to ~/.aquaman/audit.log
cat ~/.aquaman/audit.log | tail -20
```

### 6. Cleanup test credentials

```bash
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
Promise.all([
  k.deletePassword('aquaman', 'anthropic:api_key'),
  k.deletePassword('aquaman', 'slack:bot_token'),
  k.deletePassword('aquaman', 'discord:bot_token'),
  k.deletePassword('aquaman', 'telegram:bot_token'),
  k.deletePassword('aquaman', 'twilio:account_sid'),
  k.deletePassword('aquaman', 'twilio:auth_token'),
]).then(() => console.log('All test credentials removed'));
"
```

## Key Design Principles

1. **Credentials never in agent memory** - Proxy injects auth, agent sees nothing
2. **Hash-chained audit logs** - Tamper-evident, compliance-ready
3. **Multiple backends** - From Keychain (simple) to Vault (enterprise)
4. **OpenClaw-native** - Plugin follows OpenClaw SDK patterns exactly

## Files to Know

| File | Purpose |
|------|---------|
| `packages/core/src/credentials/store.ts` | Backend abstraction (keychain, encrypted-file, memory) |
| `packages/core/src/credentials/backends/` | 1Password and Vault backend implementations |
| `packages/core/src/audit/logger.ts` | Hash-chained logging |
| `packages/proxy/src/daemon.ts` | HTTP/HTTPS proxy server (header, url-path, basic, oauth auth modes) |
| `packages/proxy/src/cli/index.ts` | CLI (Commander.js, 16 commands incl. `migrate openclaw`) |
| `packages/proxy/src/service-registry.ts` | Builtin service definitions (21 services) |
| `packages/proxy/src/oauth-token-cache.ts` | OAuth client credentials token exchange + caching |
| `packages/proxy/src/migration/openclaw-migrator.ts` | Migrates channel creds from openclaw.json to secure store |
| `packages/proxy/src/openclaw/env-writer.ts` | Generates env vars for OpenClaw integration |
| `packages/proxy/src/openclaw/integration.ts` | Detects and launches OpenClaw with env vars |
| `packages/openclaw/index.ts` | OpenClaw plugin entry point (what Gateway loads) |
| `packages/openclaw/openclaw.plugin.json` | Plugin manifest + config schema |
| `packages/openclaw/src/plugin.ts` | Class-based plugin (standalone/test use) |
| `packages/openclaw/src/proxy-manager.ts` | Spawns/manages proxy child process |
| `packages/openclaw/src/http-interceptor.ts` | `globalThis.fetch` override for channel traffic interception |
| `test/e2e/openclaw-plugin.test.ts` | Plugin integration tests |
| `test/e2e/credential-proxy.test.ts` | Proxy E2E tests |
| `test/e2e/channel-credential-injection.test.ts` | Channel auth mode E2E tests (Telegram, Twilio, Twitch, etc.) |
| `test/e2e/oauth-credential-injection.test.ts` | OAuth flow E2E tests (mock token server) |
| `test/e2e/keychain-proxy-flow.test.ts` | Real keychain backend E2E (macOS only) |
| `test/e2e/cli-plugin-mode.test.ts` | CLI startup/output E2E tests |
