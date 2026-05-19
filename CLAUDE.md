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

## Known Issues & Fixes

### OpenClaw Security Scanner (`openclaw security audit --deep`)

OpenClaw 2026.2.6+ includes a code safety scanner that checks plugin files for dangerous patterns. Two rules affect us:

- **`dangerous-exec`** (CRITICAL): fires if a file imports `child_process` AND calls `exec`/`spawn`/etc.
- **`env-harvesting`** (CRITICAL): fires if `process.env` AND `fetch`/`post`/`http.request` appear in the same file — **including in comments** (the regex `/\bfetch\b/` matches the word "fetch" in JSDoc text).

There is no suppression mechanism (no inline annotations, no `.auditignore`). The only fix is to ensure trigger patterns don't co-exist in the same file.

OpenClaw 2026.2.15+ also reports an environment-level advisory:

- **`tools_reachable_permissive_policy`**: fires when any plugin is enabled and the default tool policy is permissive (no `tools.profile` set). This warns that agents could be prompt-injected into calling plugin tools (like `aquaman_status`) when handling untrusted input. This is the operator's configuration choice — aquaman should NOT force a restrictive profile. The fix is for the operator to set `"tools": { "profile": "coding" }` in `openclaw.json` if their agents handle untrusted input.

There is no suppression mechanism for code findings (no inline annotations, no `.auditignore`). The only fix is to ensure trigger patterns don't co-exist in the same file.

**Current state (v0.11.4+, tested against OpenClaw 2026.5.12):** 2 expected findings: `dangerous-exec` on `dist/src/proxy-manager.js` (true positive — it spawns the proxy process), `tools_reachable_permissive_policy` (environment advisory — not a code issue). 0 env-harvesting findings. The `request-policy.ts` file contains no `child_process`, `process.env`, or `fetch` — zero scanner risk. The scanner recursively scans `src/` and `dist/` subdirectories (since 2026.2.9). Note: OpenClaw 2026.3.x+ fresh installs default `tools.profile` to `messaging` — `aquaman_status` tool may not surface unless the operator configures `tools.profile` to include it.

**Mitigations:**
- `aquaman setup` auto-sets `plugins.allow: ["aquaman-plugin"]` in `openclaw.json` (resolves the `extensions_no_allowlist` audit finding)
- `aquaman doctor` checks for `plugins.allow` and explains the expected `dangerous-exec` finding
- The plugin ships only `dist/` (no `.ts` source) — the scanner sees the compiled `dist/src/proxy-manager.js` once instead of finding the same pattern in both `.ts` and `.js`. See "Plugin build & publish pipeline" below.

**When editing plugin files:** Do NOT add `fetch()` calls or the word "fetch" in comments to files that also reference `process.env`. Do NOT add `child_process` imports to files other than `proxy-manager.ts`. Function names containing "fetch" (e.g. `fetchHostMap`) also trigger the scanner — use alternatives like "load", "request", "get".

### Keytar ESM/CJS Interop (Node 24+)

`keytar` is a CommonJS native module. When imported via `import()` in an ESM context, the exports are wrapped in a `default` property:

```typescript
// BROKEN: keytar.findCredentials is undefined
this.keytar = await import('keytar');

// FIXED: unwrap the default export
const mod: any = await import('keytar');
this.keytar = mod.default || mod;
```

**Location:** `packages/proxy/src/core/credentials/store.ts` — `KeychainStore.getKeytar()`

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

## Plugin build & publish pipeline

The plugin is shipped as compiled JavaScript, not TypeScript source.

- `packages/plugin/tsconfig.json` compiles both the root `index.ts` and `src/**/*.ts` to `packages/plugin/dist/` (`rootDir: "."`, `outDir: "./dist"`).
- `packages/plugin/package.json`:
  - `scripts.build` → `tsc -b` (real compile)
  - `scripts.prepublishOnly` → `npm run build` (so `npm publish` always builds first)
  - `scripts.clean` → `rm -rf dist tsconfig.tsbuildinfo`
  - `files` → `["dist", "openclaw.plugin.json", "LICENSE", "README.md"]` — no `.ts` source in the published tarball
  - `openclaw.extensions` → `["./dist/index.js"]` — OpenClaw loads the compiled entry directly
- The `e2e-openclaw` CI job and the manual end-to-end recipe both **build before copying** the plugin into `~/.openclaw/extensions/aquaman-plugin/`. They copy `package.json`, `openclaw.plugin.json`, and the entire `dist/` directory — never the `.ts` source.
- Docker (`docker/Dockerfile`) likewise `COPY plugin/dist/` — the caller must run `npm run build -w aquaman-plugin && cp -r packages/plugin docker/plugin` before `docker build`.

**Why compiled-only:**
1. ClawHub publishing (since approximately 2026.5) requires `./dist/index.js` (or sibling `./index.js`) for any TS entry. There is no `--source-only` flag.
2. Shipping both `.ts` and `.js` causes the OpenClaw security scanner to find `dangerous-exec` twice (once in source, once in compiled output). Shipping only the compiled form keeps it to a single true-positive finding.
3. OpenClaw 2026.5.x already prefers compiled `dist/` over `.ts` source when both exist, so the compiled entry is what runs in production anyway.

**Publishing flow** (in order):
1. `npm publish --workspace=aquaman-proxy` (its own `prepublishOnly` triggers `tsc`)
2. `npm publish --workspace=aquaman-plugin` (its `prepublishOnly` triggers `tsc -b` → emits `dist/`)
3. `clawhub package publish packages/plugin --clawscan-note "$(cat packages/plugin/.clawhub/publisher-note.md)" --source-repo tech4242/aquaman --source-commit $(git rev-parse HEAD) --source-ref main --source-path packages/plugin` (bundles the local `dist/` — `--source-repo` + `--source-commit` are mandatory together; `--clawscan-note` requires `clawhub` CLI ≥ v0.15.0)

### ClawHub `--clawscan-note` — what we learned

The public docs (https://documentation.openclaw.ai/clawhub/cli and `/clawhub/security-audits`) are sparse on this flag — they describe the *purpose* ("context for behavior that may otherwise look unusual, such as network access, native host access, or provider-specific credentials"), confirm the note is "stored on the published version/release", and provide one example:

```bash
clawhub package publish ./plugin.tgz --clawscan-note "Native host access is limited to the local OpenClaw bridge."
```

Docs do **not** specify max length, markdown support, file conventions, edit/remove paths, or display location. The authoritative source for the technical contract is the clawhub CLI binary itself — `clawhub/dist/schema/clawScanNote.js`:

- **Max 4000 characters** after `.trim()` — longer throws `ClawScan note must be at most 4000 characters.`
- Whitespace-only normalizes to `undefined` (no note sent).
- No format validation in the normalizer — markdown or plain text both pass through.
- **No automatic file pickup.** Our `packages/plugin/.clawhub/publisher-note.md` path is purely a convention so the note is version-controlled and reproducible via `--clawscan-note "$(cat ...)"`; ClawHub doesn't look for that file. `.clawhub/` is excluded from the npm/ClawHub tarball via the plugin's `files` field.
- Per-version: the note is attached to a specific published release. There's no documented post-publish update path. To change a note, publish a new version with the new note.

**Style:** the docs' single example is one terse declarative sentence per concern. We write the note in plain prose (paragraph per finding, no markdown headings) so it renders well even if the ClawHub UI shows the text verbatim. Markdown rendering is not documented anywhere — when in doubt, prefer prose over markup.

**Length budget:** keep the note ≤ 4000 chars after trim. Aim well under (current note is ~1200 chars). If we ever need more, split structurally rather than padding.

## Pre-PR checklist

Run all of these locally before opening a PR (and re-run before merge if the branch was touched). CI runs lint + typecheck + tests but does **not** run the dry-runs or smoke tests — those have caught more real issues than tests this past release.

```bash
# 1. Static checks
npm run typecheck
npm run lint

# 2. Full test suite (~565 tests across ~36 files)
npm test

# 3. Package shape — npm tarball contents
npm pack --dry-run --workspace=aquaman-proxy
npm pack --dry-run --workspace=aquaman-plugin
#   Verify the plugin tarball does NOT include:
#   - dist/tsconfig.tsbuildinfo  (40 KB build cache; tsBuildInfoFile relocates it)
#   - dist/src/index.{js,d.ts}, dist/src/plugin.{js,d.ts}, dist/src/commands.{js,d.ts}
#     (excluded from compilation — old class-based plugin, standalone-test only)
#   - .clawhub/  (excluded by files field)

# 4. ClawHub publish dry-run (whenever the plugin changes)
clawhub package publish packages/plugin \
  --clawscan-note "$(cat packages/plugin/.clawhub/publisher-note.md)" \
  --source-repo tech4242/aquaman \
  --source-commit "$(git rev-parse HEAD)" \
  --source-ref "$(git rev-parse --abbrev-ref HEAD)" \
  --source-path packages/plugin \
  --dry-run
#   Requires `clawhub` CLI >= v0.15.0 (older versions don't have --clawscan-note).
#   The publisher note is plain text or markdown, max 4000 characters AFTER
#   .trim() (per clawhub/dist/schema/clawScanNote.js: normalizeClawScanNote).
#   Whitespace-only normalizes to undefined and no note is sent. There is NO
#   automatic file pickup — the path packages/plugin/.clawhub/publisher-note.md
#   is our convention, not ClawHub's; only the --clawscan-note flag value
#   reaches the registry. .clawhub/ is excluded from the npm/ClawHub tarball
#   via the plugin's `files` field.
#   Verify: file count + size are reasonable, --clawscan-note didn't error,
#   note byte count below 4000, no tsbuildinfo / dead-code files in tarball.

# 5. Smoke tests against a real OpenClaw install (see "Testing the OpenClaw
#    Plugin" → "Quick proxy smoke test" + "Quick plugin CLI smoke test" below).
#    Critical when changing: plugin index.ts, proxy-manager.ts, daemon.ts,
#    request-policy.ts, service-registry.ts, or anything in the publish pipeline.
```

**Definition of done for the checklist:**
- `npm test` is green (565 / 1 skipped / 0 failed at the time of writing).
- `npm pack --dry-run` plugin tarball is ~25 KB / ~24 files. If it's growing past 30 KB or 30 files, something dead-code is leaking.
- `clawhub package publish --dry-run` exits 0 and the file list matches `npm pack --dry-run` (minus `package-lock.json`-type npm metadata).
- Smoke tests show the 5 expected `[plugins]` log lines on plugin load and credential injection returns the expected upstream rejection (401 from Anthropic with a fake key).

## Version Bumps

All packages are pinned to exact versions of each other and must be bumped together:

| File | Fields to update |
|------|-----------------|
| `package.json` (root) | `version` |
| `packages/proxy/package.json` | `version` |
| `packages/plugin/package.json` | `version`, `dependencies.aquaman-proxy` (exact pin), `openclaw.compat`/`build` fields as needed |
| `packages/plugin/openclaw.plugin.json` | `version` |
| `packages/coder/package.json` | `version`, `dependencies.aquaman-proxy` (exact pin) |
| `docker/Dockerfile` | `aquaman-proxy@<version>` in `npm install` |

All `version` fields, the cross-package dependency pins, and the Docker install pin must match the new version.

**Latent bug fixed in v0.12.0:** `packages/proxy/package.json`'s `clean` script previously only removed `dist/` but not `tsconfig.tsbuildinfo`. Stale buildinfo tricked `tsc -b` into a no-op rebuild during publish, producing empty tarballs. v0.12.0 now removes both, and `prepublishOnly` runs `npm run clean && npm run build` for both proxy and plugin (matching coder's pattern).

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

### systemd-creds Backend Internals

**Implementation:** `packages/proxy/src/core/credentials/backends/systemd-creds.ts`

**Requirements:** Linux with systemd ≥ 256 (for `--user` support). No root/sudo required. TPM2 chip recommended but not strictly required.

**File structure:** Each credential is a separate `.cred` file in `~/.aquaman/creds.d/`:

```
~/.aquaman/creds.d/
  anthropic--api_key.cred    # encrypted with systemd-creds --user
  openai--api_key.cred
  _index.cred                # encrypted index of all credentials
```

The `--` separator distinguishes service from key (both may contain single dashes). The `_index.cred` file stores the credential inventory (also encrypted).

**Encryption flow:** Values are piped via stdin to `systemd-creds --user encrypt --name=<credName> - -`, which outputs the encrypted blob to stdout. The proxy writes the blob to a `.cred` file (`mode: 0o600`). Decryption reverses the process via `systemd-creds --user decrypt`. The per-user credential key is managed by systemd — no master password needed. When TPM2 is available, secrets are bound to the machine and can't be decrypted elsewhere.

**In-memory caching:** Decrypted values are cached in a `Map` for the proxy process lifetime. Each credential is decrypted at most once per proxy start.

**Comparison with encrypted-file:**

| | `encrypted-file` | `systemd-creds` |
|---|---|---|
| Master password | Required (12+ chars) | None |
| Hardware binding | No | Yes (TPM2) |
| Portability | Can move between machines | Bound to machine |
| Platform | Any | Linux (systemd ≥ 256) |

**Input validation:** Service and key names must match `/^[a-z0-9][a-z0-9._-]*$/`. The resolved `.cred` file path is checked to not escape `credsDir` (path traversal prevention).

**Auto-detection in `aquaman setup`:** On Linux, if `systemd-creds --version` reports systemd ≥ 256, the setup wizard selects `systemd-creds` as the default backend (before falling back to `encrypted-file`).

## Testing the OpenClaw Plugin

### Manual end-to-end test:

```bash
# 1. Build the plugin (manifest points at ./dist/index.js, must exist)
npm run build -w aquaman-plugin

# 2. Install plugin
openclaw plugins install ./packages/plugin
# or manually: copy package.json, openclaw.plugin.json, and dist/ into the extensions dir

# 3. Sync after code changes
npm run build -w aquaman-plugin
cp packages/plugin/package.json ~/.openclaw/extensions/aquaman-plugin/package.json
cp packages/plugin/openclaw.plugin.json ~/.openclaw/extensions/aquaman-plugin/openclaw.plugin.json
rm -rf ~/.openclaw/extensions/aquaman-plugin/dist
cp -r packages/plugin/dist ~/.openclaw/extensions/aquaman-plugin/dist

# 4. Add test credential (dummy key for testing)
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
k.setPassword('aquaman/anthropic', 'api_key', 'sk-ant-test-key').then(() => console.log('stored'));
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
    "allow": ["aquaman-plugin"],
    "entries": {
      "aquaman-plugin": {
        "enabled": true,
        "config": {
          "backend": "keychain",
          "services": ["anthropic", "openai"]
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
[plugins] aquaman proxy found, will start proxy on gateway start
[plugins] Set ANTHROPIC_BASE_URL=http://aquaman.local/anthropic
[plugins] Set OPENAI_BASE_URL=http://aquaman.local/openai
[plugins] Aquaman plugin registered successfully
{ "payloads": [{ "text": "HTTP 401 authentication_error: invalid x-api-key ..." }] }
```

- **No mismatch warnings** — package name `aquaman-plugin` matches manifest id `"aquaman-plugin"`
- **Plugin loads and sets env vars** — `ANTHROPIC_BASE_URL` pointed to `aquaman.local` (UDS-backed)
- **401 from Anthropic** — confirms the proxy injected the dummy key (real key would get a response)
- **No credentials in agent process** — only the proxy URL was visible to the agent

### Automated tests:

```bash
npm run test:e2e                # All e2e tests (18 files)
npm run test:unit               # All unit tests (18 files)
npm test                        # Everything (~555 tests, 36 files)
```

### Quick proxy smoke test (credential injection + policy + health):

```bash
# 1. Store dummy test credential
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
k.setPassword('aquaman/anthropic', 'api_key', 'sk-ant-smoketest-key').then(() => console.log('stored'));
"

# 2. Start proxy
npx tsx packages/proxy/src/cli/index.ts daemon &
sleep 2

# 3. Credential injection (expect 401 from Anthropic = proxy injected the dummy key)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
# Expect: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}

# 4. Health endpoint
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/_health
# Expect: {"status":"ok","version":"0.11.0",...}

# 5. Policy enforcement (expect 403 — admin API blocked by default policy)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/anthropic/v1/organizations/org123/members
# Expect: {"error":"Request denied by policy: GET /anthropic/v1/organizations/org123/members","fix":"..."}

# 6. Unknown service (expect 404)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/unknown-service/test
# Expect: Not found

# 7. Stop proxy and clean up
npx tsx packages/proxy/src/cli/index.ts stop
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
k.deletePassword('aquaman/anthropic', 'api_key').then(() => console.log('cleaned up'));
"
```

### Quick plugin CLI smoke test (via bundled proxy binary):

```bash
# After installing plugin to ~/.openclaw/extensions/aquaman-plugin/ (see above):
openclaw aquaman status          # Shows proxy status + binary found
openclaw aquaman doctor          # Runs diagnostic checks
openclaw aquaman credentials list # Lists stored credentials
openclaw aquaman policy-list     # Shows request policy rules
openclaw aquaman audit-tail      # Shows recent audit entries
openclaw aquaman services-list   # Lists configured services
```

### Plugin degraded mode smoke test (ClawHub install without setup):

```bash
# Temporarily hide the aquaman binary to simulate missing proxy
mv ~/.openclaw/extensions/aquaman-plugin/node_modules/.bin/aquaman /tmp/aquaman-hidden
# Also remove from PATH if globally installed

# Start OpenClaw — plugin should:
# - Log "aquaman proxy not found" warning
# - NOT set ANTHROPIC_BASE_URL (no sentinel env vars)
# - Still register /aquaman-status command
# - Still register aquaman_status tool
openclaw plugins list 2>&1 | grep -E "aquaman|BASE_URL"
# Expect: "aquaman proxy not found", NO "ANTHROPIC_BASE_URL" lines

# Restore
mv /tmp/aquaman-hidden ~/.openclaw/extensions/aquaman-plugin/node_modules/.bin/aquaman
```

## Manual Testing

Step-by-step guide for manually testing credential injection across all auth modes (providers and channels).

### 1. Store test credentials

```bash
# Store dummy credentials for each auth mode
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
Promise.all([
  // Providers (header auth)
  k.setPassword('aquaman/anthropic', 'api_key', 'sk-ant-manual-test'),
  k.setPassword('aquaman/mistral', 'api_key', 'mistral-manual-test-key'),
  k.setPassword('aquaman/huggingface', 'api_key', 'hf-manual-test-key'),
  // Channels (header auth)
  k.setPassword('aquaman/slack', 'bot_token', 'xoxb-manual-test-token'),
  k.setPassword('aquaman/discord', 'bot_token', 'discord-manual-test-token'),
  // Channels (URL-path auth)
  k.setPassword('aquaman/telegram', 'bot_token', '123456:MANUAL-TEST-TOKEN'),
  // Channels (basic auth)
  k.setPassword('aquaman/twilio', 'account_sid', 'AC-manual-test-sid'),
  k.setPassword('aquaman/twilio', 'auth_token', 'manual-test-auth-token'),
]).then(() => console.log('All test credentials stored'));
"
```

### 2. Start the proxy

```bash
npx tsx packages/proxy/src/cli/index.ts plugin-mode
# Should output JSON with ready:true, proxy listening on ~/.aquaman/proxy.sock
```

### 3. Test each auth mode

#### Providers

**Anthropic (header auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
# Expect: 401 from Anthropic (confirms proxy injected the test key)
```

**Mistral (header auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/mistral/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral-large-latest","messages":[{"role":"user","content":"hi"}]}'
# Expect: 401 from Mistral (confirms Bearer token injected)
```

**Hugging Face (header auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/huggingface/models/meta-llama/Llama-3-8B \
  -H "Content-Type: application/json" \
  -d '{"inputs":"hi"}'
# Expect: 401 from Hugging Face (confirms Bearer token injected)
```

#### Channels

**Slack (header auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/slack/auth.test
# Expect: {"ok":false,"error":"invalid_auth"} (confirms Bearer token injected)
```

**Discord (header auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/discord/api/v10/users/@me
# Expect: 401 from Discord (confirms Bot token injected)
```

**Telegram (URL-path auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/telegram/getMe
# Expect: {"ok":false,"error_code":401} (token injected into URL path)
```

**Twilio (basic auth):**
```bash
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/twilio/2010-04-01/Accounts.json
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
  // Providers
  k.deletePassword('aquaman/anthropic', 'api_key'),
  k.deletePassword('aquaman/mistral', 'api_key'),
  k.deletePassword('aquaman/huggingface', 'api_key'),
  // Channels
  k.deletePassword('aquaman/slack', 'bot_token'),
  k.deletePassword('aquaman/discord', 'bot_token'),
  k.deletePassword('aquaman/telegram', 'bot_token'),
  k.deletePassword('aquaman/twilio', 'account_sid'),
  k.deletePassword('aquaman/twilio', 'auth_token'),
]).then(() => console.log('All test credentials removed'));
"
```

## Manual Policy Smoke Test

Step-by-step guide for manually testing request-level policy enforcement.

### 1. Store test credentials

```bash
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
Promise.all([
  k.setPassword('aquaman/anthropic', 'api_key', 'sk-ant-policy-test'),
  k.setPassword('aquaman/openai', 'api_key', 'sk-openai-policy-test'),
  k.setPassword('aquaman/slack', 'bot_token', 'xoxb-policy-test-token'),
]).then(() => console.log('Test credentials stored'));
"
```

### 2. Write policy config

```bash
cat > ~/.aquaman/config.yaml << 'YAML'
credentials:
  backend: keychain
  proxiedServices: [anthropic, openai, slack]
audit:
  enabled: true
  logDir: ~/.aquaman/audit
services:
  configPath: ~/.aquaman/services.yaml
openclaw:
  autoLaunch: false
  configMethod: env
policy:
  anthropic:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/v1/organizations/**"
        action: deny
  openai:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/v1/organization/**"
        action: deny
      - method: DELETE
        path: "/v1/**"
        action: deny
  slack:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/admin.*"
        action: deny
YAML
```

### 3. Start proxy and test

```bash
npx tsx packages/proxy/src/cli/index.ts daemon &
sleep 2

# Allowed: Anthropic inference (expect 401 from upstream = credential injected)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
# Expect: {"type":"error","error":{"type":"authentication_error",...}}

# Denied: Anthropic admin API (expect 403 from policy)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/anthropic/v1/organizations/org123/members
# Expect: {"error":"Request denied by policy: GET /anthropic/v1/organizations/org123/members","fix":"Check policy rules..."}

# Denied: OpenAI DELETE (expect 403 from policy)
curl -s -X DELETE --unix-socket ~/.aquaman/proxy.sock http://localhost/openai/v1/files/file-abc
# Expect: {"error":"Request denied by policy: DELETE /openai/v1/files/file-abc","fix":"..."}

# Denied: Slack admin method (expect 403 from policy)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/slack/admin.users.list
# Expect: {"error":"Request denied by policy: GET /slack/admin.users.list","fix":"..."}

# Allowed: Slack normal method (expect response from Slack)
curl -s --unix-socket ~/.aquaman/proxy.sock http://localhost/slack/auth.test | head -c 100
# Expect: HTML or JSON from Slack (not 403)

npx tsx packages/proxy/src/cli/index.ts stop
```

### 4. Verify doctor output

```bash
npx tsx packages/proxy/src/cli/index.ts doctor
# Expect: ✓ Policy valid (3 services, 4 rules)
```

### 5. Cleanup

```bash
node -e "
const kt = require('./node_modules/keytar');
const k = kt.default || kt;
Promise.all([
  k.deletePassword('aquaman/anthropic', 'api_key'),
  k.deletePassword('aquaman/openai', 'api_key'),
  k.deletePassword('aquaman/slack', 'bot_token'),
]).then(() => console.log('Test credentials removed'));
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

See `ROADMAP.md` (gitignored) for competitive research, UX analysis, and detailed roadmap.
