# CLAUDE.md

## What This Is

Credential isolation for **AI agents**. API keys, channel tokens, and `.env`-grade secrets never enter the agent's process — they're stored in secure backends (Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, encrypted-file, systemd-creds) and injected by a separate proxy.

Three integration paths as of v0.13.0:

1. **OpenClaw Gateway** (`aquaman-plugin`) — original target. Covers LLM providers (Anthropic, OpenAI, Mistral, Hugging Face, xAI, Cloudflare AI Gateway, ElevenLabs) **and** OpenClaw channel credentials (Telegram, Slack, Discord, MS Teams, Matrix, LINE, Twitch, Twilio, etc.). 25 builtin services across 6 auth modes.
2. **AI coding agents** (`aquaman-coder`, v0.12.0+) — Claude Code today; Codex / OpenCode / Cursor planned. Stops developers from putting plaintext `.env` files into projects just to make their coding agent work. Per-tool-call credential materialization via the `/broker/resolve` UDS endpoint.
3. **Hermes agent host** (`aquaman-hermes`, v0.13.0+) — Hermes, the #2/co-leader agent host. Hermes is a foreign (Python) host that builds its own HTTP client and exposes no transport hook, so the UDS dispatcher can't be injected. Instead the proxy exposes an **opt-in, token-gated loopback TCP listener** (`127.0.0.1:<port>`, default-off) and Hermes is pointed at it via its native `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` env vars + a placeholder api_key (= the loopback token). LLM providers only (Anthropic, OpenAI) for now.

**Target platform:** Unix-like systems (Linux, macOS, WSL2). The OpenClaw Gateway runs as a systemd user service (Linux/WSL2) or LaunchAgent (macOS); the coding-agent path runs alongside the coder's own process.

**Published on npm** as `aquaman-proxy`, `aquaman-plugin`, and (v0.12.0+) `aquaman-coder`. Install OpenClaw plugin via `openclaw plugins install aquaman-plugin`; install the coding-agent adapter via `npm install -g aquaman-coder`. Also publishable to ClawHub for native plugin discoverability. The Hermes plugin (v0.13.0+) ships **on PyPI** as `aquaman-hermes` (`pip install aquaman-hermes`), outside the npm publish order.

## Compliance posture (v0.12.0+)

Aquaman ships runnable conformance tests mapped to:

- **MITRE ATLAS** v5.4.0 — techniques AML.T0055, T0012, T0062, T0090, T0098 (`test/compliance/atlas/`)
- **NIST SP 800-53 Rev 5** — IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10 (`test/compliance/nist/`)
- **CISA/Five-Eyes** *Careful Adoption of Agentic AI Services* (April 2026) — alignment narrative
- **CSA MAESTRO** — layered alignment narrative
- **OWASP Top 10 for Agentic Apps** (2026 list) — ASI02, ASI03, ASI04 alignment

The conformance tests live under `test/compliance/` and run as part of `npm test`. They're **source-repo only** — not bundled in the published npm tarball. Each test file is named for the control it exercises (e.g. `t0055-unsecured-credentials.test.ts`, `au-10-tamper-evident.test.ts`). The mapping doc set lives at `docs/compliance/{atlas-mapping,nist-800-53,agentic-ai-guidance}.md`.

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
│               #   policy, CLI. The slim, "always present" package. Plugin,
│               #   coder, and the Hermes path all depend on it; it never
│               #   depends on them. (The Hermes loopback listener + src/hermes/
│               #   config-writer live HERE — the Python plugin is just sugar.)
├── plugin/     # aquaman-plugin - OpenClaw Gateway adapter (frozen scope)
├── coder/      # aquaman-coder - coding-agent adapter (Claude Code; Codex /
│               #   OpenCode / Cursor planned). NEW in v0.12.0.
└── hermes/     # aquaman-hermes - Hermes plugin (PYTHON, PyPI). Optional
                #   in-session sugar (status command/tool + health hook). NEW
                #   in v0.13.0. The isolation is done proxy-side, not here.
```

Cross-package import rules (codified in `docs/PACKAGES.md`):
- plugin → proxy ✓, coder → proxy ✓
- plugin ↔ coder ✗ (siblings stay independent)
- proxy → plugin / coder ✗ (proxy must remain slim)
- hermes (Python) is decoupled: it talks to the proxy only over the loopback
  HTTP wire contract (no code import in either direction; polyglot by design)

## OpenClaw Gateway Integration

The plugin (`packages/plugin/`) integrates with the OpenClaw Gateway's plugin SDK. Plugins run inside the Gateway process and have access to lifecycle hooks, CLI registration, and tool registration.

**How it works:**
1. Plugin exports `OpenClawPluginDefinition` object (imported from `openclaw/plugin-sdk`)
2. On load: reads `services` from `api.pluginConfig` (defaults to `["anthropic", "openai"]`)
3. On load: auto-generates `auth-profiles.json` with placeholder keys if missing
4. On load: sets `ANTHROPIC_BASE_URL=http://aquaman.local/anthropic`, `OPENAI_BASE_URL=http://aquaman.local/openai` (sentinel hostname routed to UDS)
5. Via `registerService('aquaman-proxy')`: spawns `aquaman openclaw plugin-mode` via `ProxyManager` (from `src/proxy-manager.ts`) — proxy listens on UDS (`~/.aquaman/proxy.sock`). (v0.12.0+ moved this under the `openclaw` namespace; earlier versions used `aquaman plugin-mode`.)
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

**⚠️ OpenClaw ≥ 2026.6.5 — auth profiles moved to SQLite (openclaw/openclaw#89102, shipped 2026.6.5):** the runtime read path for `auth-profiles.json` was removed; provider auth profiles now live in each agent's `openclaw-agent.sqlite`. The plugin still writes the JSON placeholder at load (it's the import source), but on these versions OpenClaw only ingests it via a one-shot `openclaw doctor --fix`, which then archives the file. `aquaman openclaw doctor` is version-aware (`authProfilesAreSqliteOnly()` in `src/openclaw/integration.ts`) and prints the import step. The plugin's `index.ts` cannot run the import itself — it must not import `child_process` (keeps the OpenClaw security scanner clean). **Holistic fix (SecretRef provider integration manifest, openclaw/openclaw#82326) is deferred to the next plugin touch — see ROADMAP.md.**

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

When Claude Code runs `Bash` in `~/code/my-app/anything`, the hook rewrites `command: "X"` → `command: "aquaman-coder exec -- sh -c 'X'"`. The wrapper calls the broker per env var, injects the real values into the subprocess only, and pipes stdout/stderr through the redactor. The redactor prepends a `buildValuePatterns()` entry for each injected value (so the actual resolved strings get scrubbed verbatim, regardless of shape — Atlassian, Notion, internal-API, anything) and then runs BUILTIN_PATTERNS as defense-in-depth for secrets the child surfaces that weren't injected by aquaman.

**End-to-end setup:**

```bash
# 1. Install aquaman-proxy (vault + daemon) and aquaman-coder (adapter)
npm install -g aquaman-proxy aquaman-coder

# 2. Store credentials in your chosen backend
aquaman setup           # vault-only wizard (writes ~/.aquaman/config.yaml, picks backend)
aquaman credentials add anthropic api_key sk-ant-...
aquaman credentials add github token ghp_...

# 3. Start the proxy daemon
aquaman daemon &

# 4. Declare a project
aquaman coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token

# 5. Wire Claude Code hooks
aquaman coder setup claude-code

# 6. Verify
aquaman doctor          # overview — should show vault + coder both green
aquaman coder doctor    # deep diagnostic for the coder integration
```

## Hermes Integration (v0.13.0+)

Hermes is a foreign **Python** agent host. It builds its own httpx
client internally from `(api_mode, base_url, api_key)` and exposes no transport /
socket hook — so unlike the OpenClaw plugin there's no way to inject a UDS-dialing
dispatcher. The integration is therefore **proxy-side**, not a code plugin: the proxy
runs an opt-in loopback TCP listener and Hermes is pointed at it via env vars it
already understands.

**Wire shape:**

```
Hermes (Python host)                         aquaman-proxy
┌──────────────────────────┐                 ┌──────────────────────────────┐
│ ~/.hermes/.env:           │── HTTP/loopback│ 127.0.0.1:<port> listener      │
│  ANTHROPIC_BASE_URL=       │   (token in     │  • token gate (constant-time) │
│   http://127.0.0.1:8585/   │    x-api-key /  │  • strip placeholder          │
│   anthropic                │    Authorization│  • inject real key from vault │
│  ANTHROPIC_API_KEY=         │    Bearer)      │  • policy + hash-chain audit  │
│   <loopback token>         │◀───────────────│  • forward to api.anthropic    │
│ NO real credentials        │                 └──────────────────────────────┘
└──────────────────────────┘                  (UDS listener stays default; the
                                                loopback one is opt-in + default-off)
```

**Why loopback, not UDS** (partially reverses the v0.7.0 UDS-only decision, but only
for foreign-language hosts): a UDS dispatcher can't be injected through any supported
Hermes surface. Mitigations: loopback bind only (never 0.0.0.0); a generated per-install
token required on every request; reuse of the existing request-policy + audit. The token
arrives as the provider api_key Hermes sends (`x-api-key` for Anthropic,
`Authorization: Bearer` for OpenAI) or an explicit `x-aquaman-token`.

**Path mapping** (verified against Hermes `runtime_provider.py` / `anthropic_adapter.py`):
- Anthropic → base_url `http://127.0.0.1:<port>/anthropic` (Hermes special-cases the
  `/anthropic` suffix into `anthropic_messages` mode; SDK appends `/v1/messages`).
- OpenAI → `http://127.0.0.1:<port>/openai/v1` (SDK appends `/chat/completions`). The
  `openai` upstream is `https://api.openai.com` (no `/v1`), so there's no double-`/v1`.

**Key files (proxy side, the real work):**
- `packages/proxy/src/daemon.ts` — second `http.Server` on `127.0.0.1:<port>`, gated by
  `isLoopbackTokenValid()` (constant-time). `/_health` exempt. UDS path unchanged.
- `packages/proxy/src/hermes/config-writer.ts` — generates the `~/.hermes/.env` block
  (base URLs + placeholder key). Honors `HERMES_HOME` (the var the Hermes CLI itself
  uses). Idempotent delimited block.
- `packages/proxy/src/hermes/integration.ts` — detect Hermes, configure, write env.
- `packages/proxy/src/core/types.ts` — `LoopbackConfig` (`enabled`/`port`/`token`/`host`)
  + `HermesConfig`. Config defaults disabled; env overrides `AQUAMAN_LOOPBACK_ENABLED`/
  `_PORT`/`_TOKEN` (no `_HOST` override — the bind stays loopback).
- CLI: `aquaman hermes setup|doctor|status|configure`. `loadLoopbackOptions()` refuses to
  start an enabled-but-tokenless listener (an untokened loopback proxy would be open).

**Python plugin (`packages/hermes/`, optional sugar):** `aquaman-hermes` on PyPI. A
stdlib-only directory plugin (`plugin.yaml` + `register(ctx)`) installed into
`$HERMES_HOME/plugins/aquaman/` via `aquaman-hermes install`, enabled with
`hermes plugins enable aquaman`. Adds `/aquaman-status` slash command, `aquaman_status`
tool, and an `on_session_start` health probe. Holds no credentials; isolation is entirely
proxy-side. **Do NOT put isolation logic here.**

**End-to-end setup:**

```bash
npm install -g aquaman-proxy
aquaman setup
aquaman credentials add anthropic api_key sk-ant-...
aquaman hermes setup            # enable loopback listener, generate token, write ~/.hermes/.env
aquaman daemon &                # start proxy (UDS + loopback)
aquaman hermes doctor           # verify: listener + env wiring + vault creds + Hermes detected
pip install aquaman-hermes && aquaman-hermes install && hermes plugins enable aquaman  # optional
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

## CLI shape (v0.12.0+)

The `aquaman` binary exposes commands at three levels:

**Top-level (vault-only, agent-agnostic):**

```bash
aquaman setup        # vault wizard — backend + creds only
aquaman doctor       # overview health check with persona-aware soft upsells
aquaman status       # proxy daemon overview
aquaman daemon       # run proxy in foreground
aquaman stop         # stop the daemon
aquaman init         # low-level config bootstrap

aquaman credentials add/list/delete/guide
aquaman audit tail/verify/rotate
aquaman services list/validate
aquaman policy list/test
```

**`aquaman openclaw …` (OpenClaw Gateway integration):**

```bash
aquaman openclaw setup       # full bundle: vault + plugin + auth-profiles.json
aquaman openclaw doctor      # deep diagnostic for the OpenClaw integration
aquaman openclaw status      # plugin lifecycle + sentinel env vars
aquaman openclaw start       # spawn proxy + launch OpenClaw
aquaman openclaw configure   # generate env vars for OpenClaw
aquaman openclaw migrate     # migrate plaintext credentials from openclaw.json
# aquaman openclaw plugin-mode is hidden — invoked by the plugin's ProxyManager only
```

**`aquaman coder …` (AI coding-agent integration; delegates to `aquaman-coder` binary):**

```bash
aquaman coder setup <agent>   # install hooks (claude-code today; codex/opencode/cursor planned)
aquaman coder doctor          # deep diagnostic — projects + broker + per-project vault checks
aquaman coder status          # configured projects + hook wiring + broker activity
aquaman coder project list/add/remove
aquaman coder get <ref>       # one-shot resolve of an aquaman://service/key ref
aquaman coder exec <cmd>      # run a command with project env injected + output redacted
# aquaman coder hook is hidden — invoked by Claude Code via stdio
```

**`aquaman hermes …` (Hermes agent-host integration):**

```bash
aquaman hermes setup          # enable loopback listener + generate token + write ~/.hermes/.env
aquaman hermes doctor         # deep diagnostic — loopback config + listener reachable + env wired + vault creds
aquaman hermes status         # loopback config + token (masked) + env wiring + Hermes detection
aquaman hermes configure      # emit/write the Hermes env vars without touching daemon config
```

The triplet pattern (`setup` / `doctor` / `status`) appears at all four levels: top-level shows overview, namespaced versions show deep details.

### Setup wizard (`aquaman setup` vs `aquaman openclaw setup`)

| Command | What it does |
|---|---|
| `aquaman setup` | Vault only — detects platform, picks default backend, prompts for Anthropic + OpenAI keys, applies policy presets. |
| `aquaman openclaw setup` | Vault setup *plus* installs the OpenClaw plugin into `~/.openclaw/extensions/aquaman-plugin/`, writes/merges `~/.openclaw/openclaw.json`, generates `auth-profiles.json` placeholder, optionally auto-migrates plaintext credentials. |
| `aquaman coder setup claude-code` | Writes the Claude Code hook entry into `~/.claude/settings.json` (atomic, mode `0o600`). Idempotent. Vault must already be configured. |

**Common flags (all setup forms):** `--backend <backend>`, `--non-interactive` (for CI; reads from env vars `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AQUAMAN_ENCRYPTION_PASSWORD`, `AQUAMAN_KEEPASS_PASSWORD`, `VAULT_ADDR`, `VAULT_TOKEN`, `BW_SESSION`), `--no-policy` (skip preset configuration).

### Doctor (persona-aware)

| Command | What it shows |
|---|---|
| `aquaman doctor` | Three-section overview: Vault (config + backend + proxy + creds count), OpenClaw integration (one-line if detected; neutral skip if not), Coder integration (one-line if configured; soft upsell suggesting `npm install -g aquaman-coder` if not). |
| `aquaman openclaw doctor` | Deep OpenClaw diagnostic — plugin installed + version match, openclaw.json plugin entry, plugins.allow trust list, auth-profiles.json, unmigrated plaintext credentials. |
| `aquaman coder doctor` | Deep coder diagnostic — projects.yaml exists and parses, broker reachable, each project's declared `aquaman://service/key` refs resolve through the vault, Claude Code hooks installed. |

Exit code: 0 if all green, 1 if any check failed.

## Auto auth-profiles Generation

The plugin (`packages/plugin/index.ts`) auto-generates `~/.openclaw/agents/main/agent/auth-profiles.json` on load if the file doesn't exist. This eliminates the most confusing manual step — users don't need to understand why OpenClaw needs a placeholder key.

## Actionable Error Messages

- **Proxy 401 (credential not found):** Returns JSON `{ "error": "...", "fix": "Run: aquaman credentials add <service> <key>" }`
- **Plugin: proxy start failure:** Checks for stale socket file at `~/.aquaman/proxy.sock`
- **Plugin: CLI not found:** Suggests `npm install -g aquaman-proxy` then `aquaman openclaw setup`

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

Backend selection is auto-detected by `aquaman setup` and `aquaman openclaw setup` (macOS → keychain; Linux → keychain if libsecret, else systemd-creds if systemd ≥ 256, else encrypted-file). Maintainer-level details of each backend (file layout, encryption flow, in-memory caching) are in `OPERATIONS.md`.

## Testing

```bash
npm test            # All tests
npm run test:unit
npm run test:e2e

npx vitest run test/compliance/   # ATLAS + NIST conformance suite
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
| `packages/proxy/src/hermes/config-writer.ts` | Generates `~/.hermes/.env` block (loopback base URLs + placeholder key) |
| `packages/proxy/src/hermes/integration.ts` | Detects Hermes, configures + writes its env |
| `packages/hermes/aquaman_hermes/plugin.py` | Hermes Python plugin: register() + status command/tool + health hook |
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
| `test/e2e/hermes-loopback.test.ts` | Loopback listener E2E (token gating, both provider shapes, isolation, UDS stays token-free) |
| `test/compliance/loopback-listener.test.ts` | Loopback-path compliance (AC-3 token gate, ATLAS T0055/T0090 key isolation, AU-10 audited path) |
| `test/unit/hermes/config-writer.test.ts` | Hermes env-writer unit tests (path mapping, HERMES_HOME, idempotent block) |
| `packages/hermes/tests/test_plugin.py` | Python plugin unit tests (health probe, status text, register wiring) |
| `packages/hermes/tests/test_compliance.py` | Python plugin compliance (ATLAS T0098 / NIST SI-10/AC-6 — status surface never leaks token/key; reads only `*_BASE_URL`) |
| `test/e2e/keychain-proxy-flow.test.ts` | Real keychain backend E2E (macOS only) |
| `test/e2e/cli-plugin-mode.test.ts` | CLI startup/output E2E tests |
| `test/e2e/cli-setup.test.ts` | `aquaman setup` E2E tests |
| `test/e2e/cli-doctor.test.ts` | `aquaman doctor` E2E tests |
| `test/unit/daemon-errors.test.ts` | Actionable error message unit tests |
| `test/helpers/temp-env.ts` | Reusable temp environment helper for CLI tests |

## Roadmap

Public release history lives in [GitHub Releases](https://github.com/tech4242/aquaman/releases). Detailed forward planning is internal.

## Maintainer resources

Two companion docs are gitignored (not on GitHub or npm):

- **`OPERATIONS.md`** — operational runbook: OpenClaw scanner trigger patterns, keytar interop, plugin build & publish pipeline, ClawHub publisher-note mechanics, version-bump procedure, manual end-to-end test recipes, smoke-test scripts for all auth modes and policy denials.
- **`ROADMAP.md`** — forward planning, scoping notes, in-flight investigations.

New maintainers should ask for both. Neither contains secrets, but both contain operational context that doesn't belong in public docs.
