# CLAUDE.md

## What This Is

Credential isolation for **AI agents**. API keys, channel tokens, and `.env`-grade secrets never enter the agent's process — they're stored in secure backends (Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, encrypted-file, systemd-creds) and injected by a separate proxy.

Two integration paths as of v0.12.0:

1. **OpenClaw Gateway** (`aquaman-plugin`) — original target. Covers LLM providers (Anthropic, OpenAI, Mistral, Hugging Face, xAI, Cloudflare AI Gateway, ElevenLabs) **and** OpenClaw channel credentials (Telegram, Slack, Discord, MS Teams, Matrix, LINE, Twitch, Twilio, etc.). 25 builtin services across 6 auth modes.
2. **AI coding agents** (`aquaman-coder`, v0.12.0+) — Claude Code today; Codex / OpenCode / Cursor planned. Stops developers from putting plaintext `.env` files into projects just to make their coding agent work. Per-tool-call credential materialization via the `/broker/resolve` UDS endpoint.

**Target platform:** Unix-like systems (Linux, macOS, WSL2). The OpenClaw Gateway runs as a systemd user service (Linux/WSL2) or LaunchAgent (macOS); the coding-agent path runs alongside the coder's own process.

**Published on npm** as `aquaman-proxy`, `aquaman-plugin`, and (v0.12.0+) `aquaman-coder`. Install OpenClaw plugin via `openclaw plugins install aquaman-plugin`; install the coding-agent adapter via `npm install -g aquaman-coder`. Also publishable to ClawHub for native plugin discoverability.

## Compliance posture (v0.12.0+)

Aquaman ships runnable conformance tests mapped to:

- **MITRE ATLAS** v5.3 — techniques AML.T0055, T0012, T0062, T0090 (`tests/compliance/atlas/`)
- **NIST SP 800-53 Rev 5** — IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10 (`tests/compliance/nist/`)
- **CISA/Five-Eyes** *Careful Adoption of Agentic AI Services* (April 2026) — alignment narrative
- **CSA MAESTRO** — layered alignment narrative
- **OWASP Top 10 for Agentic Apps** — ASI02, ASI03 alignment

Run `aquaman compliance check` (human output) or `aquaman compliance check --json` (machine-readable evidence report keyed by control ID). Source: `docs/compliance/{atlas-mapping,nist-800-53,agentic-ai-guidance}.md`. The conformance tests are **source-repo only** — they're not bundled in the published npm tarball; they're for CI / audit pipelines that check out the repo.

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
│ ANTHROPIC_BASE_URL │──UDS────>│ Keychain/Vault/1P  │
│ = aquaman.local    │  (.sock) │ Injects auth header│
│                    │<─────────│ Forwards to API    │
│ NO credentials     │           │ Writes audit log   │
└────────────────────┘           └────────────────────┘
```

## Monorepo Structure

```
packages/
├── proxy/      # aquaman-proxy - canonical core: daemon, broker, vault, audit,
│               #   policy, CLI. The slim, "always present" package. Plugin and
│               #   coder both depend on it; it never depends on them.
├── plugin/     # aquaman-plugin - OpenClaw Gateway adapter (frozen scope)
└── coder/      # aquaman-coder - coding-agent adapter (Claude Code; Codex /
                #   OpenCode / Cursor planned). NEW in v0.12.0.
```

Cross-package import rules (codified in `docs/PACKAGES.md`):
- plugin → proxy ✓, coder → proxy ✓
- plugin ↔ coder ✗ (siblings stay independent)
- proxy → plugin / coder ✗ (proxy must remain slim)

## OpenClaw Gateway Integration

The plugin (`packages/plugin/`) integrates with the OpenClaw Gateway's plugin SDK. Plugins run inside the Gateway process and have access to lifecycle hooks, CLI registration, and tool registration.

**How it works:**
1. Plugin exports `OpenClawPluginDefinition` object (imported from `openclaw/plugin-sdk`)
2. On load: reads `services` from `api.pluginConfig` (defaults to `["anthropic", "openai"]`)
3. On load: auto-generates `auth-profiles.json` with placeholder keys if missing
4. On load: sets `ANTHROPIC_BASE_URL=http://aquaman.local/anthropic`, `OPENAI_BASE_URL=http://aquaman.local/openai` (sentinel hostname routed to UDS)
5. Via `registerService('aquaman-proxy')`: spawns `aquaman plugin-mode` via `ProxyManager` (from `src/proxy-manager.ts`) — proxy listens on UDS (`~/.aquaman/proxy.sock`)
6. Via `registerService('aquaman-proxy')`: activates `globalThis.fetch` interceptor to redirect channel API traffic through proxy
7. Via `registerService('aquaman-proxy')` stop: deactivates interceptor, stops proxy via `ProxyManager`
8. Registers `/aquaman-status` command (human-facing), `aquaman_status` tool (agent-facing), and `/aquaman` CLI commands

**Key files:**
- `index.ts` - Plugin entry source with `OpenClawPluginDefinition` object export (`export default plugin`). **Compiled to `dist/index.js` at publish time** — the manifest's `openclaw.extensions` points at `./dist/index.js` and only `dist/` is shipped in the published package. Does NOT import `child_process` or `fetch` directly (separated to avoid OpenClaw security scanner false positives). SDK types (`OpenClawPluginApi`, `OpenClawPluginDefinition`) are defined locally to avoid `openclaw/plugin-sdk` import resolution failures on OpenClaw 2026.3.23+ (see #53403). Registers commands/tools in ALL modes (even without proxy binary) for graceful degradation. CLI commands delegate to `execAquamanProxyCli()` / `execAquamanProxyInteractive()` from `proxy-manager.ts`.
- `src/proxy-manager.ts` - Spawns/manages the proxy child process (contains `child_process` import)
- `src/proxy-health.ts` - Proxy health check and host map fetching (contains `fetch` calls)
- `src/plugin.ts` - Class-based plugin implementation (alternative architecture, used by standalone tests)
- `openclaw.plugin.json` - Manifest with `id: "aquaman-plugin"`, config schema
- `package.json` - Has `openclaw.extensions: ["./index.ts"]`, package name `aquaman-plugin`

**Installation location:** `~/.openclaw/extensions/aquaman-plugin/`

### Plugin Config Schema

The `openclaw.plugin.json` manifest defines `additionalProperties: false` with only these keys:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` \| `"keepassxc"` \| `"systemd-creds"` \| `"bitwarden"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy. Also gates the HTTP interceptor's host map: only services in this list have their traffic redirected through the proxy (v0.11.4+). |
| `autoGenerateAuthProfiles` | `boolean` | `true` | Auto-generate `~/.openclaw/agents/<id>/agent/auth-profiles.json` with placeholder API-key entries for `anthropic` + `openai` when the file doesn't exist. Set `false` to manage your own (v0.11.4+). |

**Do NOT add extra keys** (like `proxyAutoStart`, `auditEnabled`) to `openclaw.json` — OpenClaw validates against the manifest schema and will reject them. Use `~/.aquaman/config.yaml` for advanced settings.

**HTTP interceptor scope (v0.11.4+):** `activateHttpInterceptor()` in `packages/plugin/index.ts` filters the resolved host map (dynamic from proxy `/_hostmap`, or builtin `FALLBACK_HOST_MAP`) by `configuredServices` before activating the interceptor. Hosts whose service is not in the plugin's `services` config are never redirected. This narrows the attack surface (closes ClawScan ASI02) and matches user intent.

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

## aquaman-coder / Claude Code Integration (v0.12.0+)

The `aquaman-coder` package extends aquaman to AI coding agents. v0.12.0 ships the Claude Code adapter; Codex / OpenCode / Cursor adapters are planned for v0.13.0+.

**Wire shape (Claude Code):**

```
~/.claude/settings.json        ──hooks──>   aquaman-coder hook   <──stdio──   Claude Code
                                                  │
                                                  ▼
~/.aquaman/projects.yaml  ──>  match cwd  ──>  rewrite Bash cmd via updatedInput
                                                  │
                                                  ▼
                                          aquaman-coder exec --
                                                  │
                                                  ▼
                                          BrokerClient ──>  proxy /broker/resolve  ──>  vault
                                                  │
                                                  ▼
                                          inject env + redact stdout/stderr
```

**Key files** (`packages/coder/src/`):
- `projects.ts` — `~/.aquaman/projects.yaml` resolver. Each project owns paths + an env map keyed by `aquaman://service/key` references. Longest-prefix match wins; symlinks (macOS `/var` → `/private/var`) handled via realpath on both sides.
- `broker-client.ts` — UDS HTTP client for `POST /broker/resolve` and `GET /_health`. Clean error mapping for ENOENT / ECONNREFUSED.
- `adapters/claude-code/hook.ts` — Real Claude Code hook protocol (verified against https://code.claude.com/docs/en/hooks). **PreToolUse** rewrites Bash `command` via `updatedInput.command` to wrap with `aquaman-coder exec --` (since hooks have no env-injection API). **PostToolUse** warns via `additionalContext` when the redactor detects secrets in tool output. Exit 2 routes through stderr per docs.
- `adapters/claude-code/setup.ts` — Writes `~/.claude/settings.json` atomically (mode 0o600, parent dir 0o700). Idempotent via substring-match on the hook command.
- `cli/index.ts` — Commander-based CLI: `setup <agent>`, `project list/add/remove`, `get <ref>`, `exec <cmd...>`, `hook`, `doctor`.

**Critical hook-protocol gotcha:** Earlier drafts of the adapter used fabricated fields (`additionalEnvVars` for PreToolUse env injection, `updatedToolOutput` for PostToolUse rewriting). These do not exist — Claude Code silently ignores them. The real protocol only supports `permissionDecision` / `permissionDecisionReason` / `updatedInput` / `additionalContext` for PreToolUse and `additionalContext` for PostToolUse. When extending, **verify against the live Claude Code docs**, not training-data memory.

**Project map example** (`~/.aquaman/projects.yaml`):

```yaml
version: 1
projects:
  my-app:
    paths:
      - ~/code/my-app
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
      DATABASE_URL: aquaman://supabase/db_url
```

When Claude Code runs `Bash` in `~/code/my-app/anything`, the hook rewrites `command: "X"` → `command: "aquaman-coder exec -- sh -c 'X'"`. The wrapper calls the broker per env var, injects the real values into the subprocess only, and pipes stdout/stderr through the redactor so secret-shaped strings never reach the agent transcript.

**End-to-end setup:**

```bash
# 1. Install aquaman-proxy (vault + daemon) and aquaman-coder (adapter)
npm install -g aquaman-proxy aquaman-coder

# 2. Store credentials in your chosen backend
aquaman setup           # writes ~/.aquaman/config.yaml, picks backend
aquaman credentials add anthropic api_key sk-ant-...
aquaman credentials add github token ghp_...

# 3. Start the proxy daemon
aquaman daemon &

# 4. Declare a project
aquaman-coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token

# 5. Wire Claude Code hooks
aquaman-coder setup claude-code

# 6. Verify
aquaman-coder doctor
```

## Architecture Notes

### Proxy Request Flow

**Standard (header auth):**
1. Agent sends request to `http://aquaman.local/anthropic/v1/messages` (routed to UDS via undici dispatcher)
2. Proxy parses service name from path (`anthropic`)
3. **Policy check:** evaluates method + remaining path against `config.yaml` policy rules (if configured). Denied → 403 JSON, request never gets credentials
4. Looks up credential from vault: `anthropic/api_key`
5. Strips any existing auth header from the request
6. Injects real auth header: `x-api-key: <actual-key-from-vault>`
7. Forwards to upstream: `https://api.anthropic.com/v1/messages`
8. Response piped back to agent
9. Access logged in audit trail with hash chaining

**Channel traffic (via fetch interceptor):**
1. Channel code calls `fetch('https://api.telegram.org/bot.../sendMessage')`
2. `globalThis.fetch` interceptor matches hostname → service name
3. Rewrites URL to `http://aquaman.local/telegram/sendMessage` (dispatched over UDS)
4. Proxy handles auth based on `authMode`:
   - `header`: injects auth header
     - **Providers:** Anthropic, OpenAI, GitHub, xAI, Cloudflare AI Gateway, Mistral, Hugging Face, ElevenLabs
     - **Channels:** Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, Zalo
   - `url-path`: rewrites path to `/bot<TOKEN>/method` (Telegram)
   - `basic`: injects `Authorization: Basic base64(user:pass)` (Twilio, BlueBubbles, Nextcloud Talk)
   - `oauth`: exchanges client credentials for access token (MS Teams, Feishu, Google Chat)
   - `none`: at-rest storage only, proxy rejects traffic (Nostr, Tlon)
5. Forwards to upstream, response piped back

### Proxy Access Control

UDS socket file permissions (`chmod 0o600`) restrict proxy access to the owning user. No shared-secret token needed — only processes running as the same user can connect to the socket.

### Builtin Service Protection

Builtin service definitions (anthropic, openai, telegram, etc.) cannot be overridden via `~/.aquaman/services.yaml` or `register()`. This prevents attackers from redirecting traffic + real credentials to malicious servers by poisoning the config file.

- YAML with a builtin name → logged warning, entry ignored, builtin definition preserved
- `register()` with a builtin name → throws error
- `validateConfigFile()` → reports builtin name conflicts as errors
- `override()` still works — only used programmatically in tests (requires code-level access)
- `ServiceRegistry.isBuiltinService(name)` checks whether a name is protected

### Docker Single-Container Architecture

- Single `docker/Dockerfile` — multi-stage build (builder + runtime)
- Proxy listens on UDS inside the container (`~/.aquaman/proxy.sock`)
- No multi-container networking required — proxy and Gateway run in the same container
- Socket file permissions (`chmod 0o600`) provide access control

## CLI: `aquaman setup`

All-in-one guided onboarding wizard. Replaces 6 manual steps with one command:

```bash
aquaman setup                           # Interactive — prompts for API keys
aquaman setup --non-interactive         # Uses env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY)
aquaman setup --backend encrypted-file  # Override auto-detected backend
aquaman setup --no-openclaw             # Skip plugin installation
```

**What it does:**
1. Detects platform → picks default backend (macOS=keychain, Linux=keychain if libsecret, else systemd-creds if available, else encrypted-file)
2. Runs `init` internally (creates `~/.aquaman/`, config.yaml, audit dir)
3. Prompts for Anthropic + OpenAI API keys (interactive) or reads from env vars (non-interactive)
4. Detects OpenClaw (`~/.openclaw/` or `which openclaw`)
5. If OpenClaw found: installs plugin, writes openclaw.json, generates auth-profiles.json
6. Prints success message

**Non-interactive env vars:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AQUAMAN_ENCRYPTION_PASSWORD`, `AQUAMAN_KEEPASS_PASSWORD`, `VAULT_ADDR`, `VAULT_TOKEN`, `BW_SESSION`

## CLI: `aquaman doctor`

Diagnostic tool that checks configuration and prints fixes:

```bash
aquaman doctor    # Exit code 0 = all pass, 1 = issues found
```

**Checks:**
1. `~/.aquaman/config.yaml` exists
2. Backend accessible
3. Credentials stored (count and names)
4. Proxy running on socket (`/_health` via UDS)
5. OpenClaw detected
6. Plugin installed in extensions dir
7. `openclaw.json` has aquaman-plugin entry
8. `auth-profiles.json` exists
9. Unmigrated plaintext credentials (cross-references against secure store — already-migrated show "Cleanup needed" instead of "Unmigrated")

## Auto auth-profiles Generation

The plugin (`packages/plugin/index.ts`) auto-generates `~/.openclaw/agents/main/agent/auth-profiles.json` on load if the file doesn't exist. This eliminates the most confusing manual step — users don't need to understand why OpenClaw needs a placeholder key.

## Actionable Error Messages

- **Proxy 401 (credential not found):** Returns JSON `{ "error": "...", "fix": "Run: aquaman credentials add <service> <key>" }`
- **Plugin: proxy start failure:** Checks for stale socket file at `~/.aquaman/proxy.sock`
- **Plugin: CLI not found:** Suggests `npm install -g aquaman-proxy` then `aquaman setup`

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
| `keepassxc` | Any (with .kdbx file) | Users with existing KeePass databases |
| `1password` | Any (via `op` CLI) | Team credential sharing |
| `vault` | Any (via HTTP API) | Enterprise secrets management |
| `systemd-creds` | Linux (systemd ≥ 256) | TPM2-backed, no root needed, no master password |
| `bitwarden` | Any (via `bw` CLI) | Bitwarden users |

Backend selection is auto-detected by `aquaman setup` (macOS → keychain; Linux → keychain if libsecret, else systemd-creds if systemd ≥ 256, else encrypted-file). Maintainer-level details of each backend (file layout, encryption flow, in-memory caching) are in `OPERATIONS.md`.

## Testing

```bash
npm test            # All tests
npm run test:unit
npm run test:e2e

npx tsx packages/proxy/src/cli/index.ts compliance check   # ATLAS + NIST conformance (13 controls)
```

Manual smoke-test recipes for the OpenClaw plugin install path, channel auth modes (header / url-path / basic / oauth), policy enforcement, and the publish pipeline live in `OPERATIONS.md` (gitignored maintainer doc — see "Maintainer resources" below).

## Key Design Principles

1. **Credentials never in agent memory** - Proxy injects auth, agent sees nothing
2. **Hash-chained audit logs** - Tamper-evident, compliance-ready
3. **Multiple backends** - From Keychain (simple) to Vault (enterprise)
4. **OpenClaw-native** - Plugin follows OpenClaw SDK patterns exactly

## Files to Know

| File | Purpose |
|------|---------|
| `packages/proxy/src/core/credentials/store.ts` | Backend abstraction (keychain, encrypted-file, memory) |
| `packages/proxy/src/core/credentials/backends/` | 1Password, Vault, KeePassXC, systemd-creds, and Bitwarden backend implementations |
| `packages/proxy/src/core/audit/logger.ts` | Hash-chained logging |
| `packages/proxy/src/daemon.ts` | HTTP proxy server on UDS (header, url-path, basic, oauth auth modes) |
| `packages/proxy/src/request-policy.ts` | Request-level policy enforcement (method+path rules, segment-based glob matching) |
| `packages/proxy/src/cli/index.ts` | CLI (Commander.js, 20 commands incl. `setup`, `doctor`, `policy list/test`, `migrate openclaw`) |
| `packages/proxy/src/service-registry.ts` | Builtin service definitions (25 services) |
| `packages/proxy/src/oauth-token-cache.ts` | OAuth client credentials token exchange + caching |
| `packages/proxy/src/migration/openclaw-migrator.ts` | Migrates channel + plugin creds from openclaw.json to secure store |
| `packages/proxy/src/openclaw/env-writer.ts` | Generates env vars for OpenClaw integration |
| `packages/proxy/src/openclaw/integration.ts` | Detects and launches OpenClaw with env vars |
| `packages/plugin/index.ts` | OpenClaw plugin entry point (what Gateway loads) |
| `packages/plugin/openclaw.plugin.json` | Plugin manifest + config schema |
| `packages/plugin/src/plugin.ts` | Class-based plugin (standalone/test use) |
| `packages/plugin/src/proxy-manager.ts` | Spawns/manages proxy child process |
| `packages/plugin/src/proxy-health.ts` | Proxy health check + host map fetching (isolated `fetch` calls) |
| `packages/plugin/src/http-interceptor.ts` | `globalThis.fetch` override for channel traffic interception (uses `undici.Agent` with UDS dispatcher) |
| `test/e2e/openclaw-plugin.test.ts` | Plugin integration tests |
| `test/e2e/credential-proxy.test.ts` | Proxy E2E tests |
| `test/e2e/channel-credential-injection.test.ts` | Channel auth mode E2E tests (Telegram, Twilio, Twitch, Slack, etc.) |
| `test/e2e/provider-credential-injection.test.ts` | LLM/AI provider auth E2E tests (xAI, Cloudflare AI, Mistral, Hugging Face, ElevenLabs) |
| `test/e2e/oauth-credential-injection.test.ts` | OAuth flow E2E tests (mock token server) |
| `test/e2e/request-policy.test.ts` | Request policy enforcement E2E tests (403 responses, audit logging, backward compat) |
| `test/unit/request-policy.test.ts` | Request policy unit tests (path matching, policy evaluation, validation, presets) |
| `test/e2e/keychain-proxy-flow.test.ts` | Real keychain backend E2E (macOS only) |
| `test/e2e/cli-plugin-mode.test.ts` | CLI startup/output E2E tests |
| `test/e2e/cli-setup.test.ts` | `aquaman setup` E2E tests |
| `test/e2e/cli-doctor.test.ts` | `aquaman doctor` E2E tests |
| `test/unit/daemon-errors.test.ts` | Actionable error message unit tests |
| `test/helpers/temp-env.ts` | Reusable temp environment helper for CLI tests |
| `docker/Dockerfile` | Single-container Docker build (builder + runtime) |
| `docker/openclaw-config.json` | Plugin config for Docker OpenClaw container |
| `docker/auth-profiles.json` | Placeholder auth profiles for Docker |
| `docker/.env.example` | Template for Docker env var configuration |

## Roadmap

Public release history lives in [GitHub Releases](https://github.com/tech4242/aquaman/releases). Detailed forward planning is internal.

## Maintainer resources

Two companion docs are gitignored (not on GitHub or npm):

- **`OPERATIONS.md`** — operational runbook: OpenClaw scanner trigger patterns, keytar interop, plugin build & publish pipeline, ClawHub publisher-note mechanics, version-bump procedure, manual end-to-end test recipes, smoke-test scripts for all auth modes and policy denials.
- **`ROADMAP.md`** — forward planning, scoping notes, in-flight investigations.

New maintainers should ask for both. Neither contains secrets, but both contain operational context that doesn't belong in public docs.
