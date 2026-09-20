# CLAUDE.md

## What This Is

Credential isolation for **AI agents**. API keys, channel tokens, and `.env`-grade secrets never enter the agent's process — they're stored in secure backends (Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, encrypted-file, systemd-creds) and injected by a separate proxy.

Three integration paths as of v0.13.0:

1. **OpenClaw Gateway** (`aquaman-plugin`) — original target. Covers LLM providers (Anthropic, OpenAI, Mistral, Hugging Face, xAI, Cloudflare AI Gateway, ElevenLabs) **and** OpenClaw channel credentials (Telegram, Slack, Discord, MS Teams, Matrix, LINE, Twitch, Twilio, etc.). 25 builtin services across 5 auth modes.
2. **AI coding agents** (`aquaman-coder`, v0.12.0+) — Claude Code today; Codex / OpenCode / Cursor planned. Stops developers from putting plaintext `.env` files into projects just to make their coding agent work. Per-tool-call credential materialization via the `/broker/resolve` UDS endpoint.
3. **Hermes agent host** (`aquaman-hermes`, v0.13.0+) — Hermes, the #2/co-leader agent host. Hermes is a foreign (Python) host that builds its own HTTP client and exposes no transport hook, so the UDS dispatcher can't be injected. Instead the proxy exposes an **opt-in, token-gated loopback TCP listener** (`127.0.0.1:<port>`, default-off) and Hermes is pointed at it via its native `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` env vars + a placeholder api_key (= the loopback token). LLM providers: Anthropic + OpenAI. v0.14.0 adds an `aquaman` **secret source** (Hermes ≥ 0.18.1 `ctx.register_secret_source` contract) for project/tool secrets — vault-resolved at startup via the loopback broker; LLM keys stay on the proxy path.

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
3. On a full load (not discovery) of a gateway < 2026.6.5 only: auto-generates `auth-profiles.json` with placeholder keys if missing (newer gateways get the SecretRef wiring instead)
4. On load: sets `ANTHROPIC_BASE_URL=http://aquaman.local/anthropic`, `OPENAI_BASE_URL=http://aquaman.local/openai` (sentinel hostname routed to UDS) — **skipped for providers already routed by an openclaw.json loopback `baseUrl`** (v0.15.0; see "Model traffic goes through the loopback listener")
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

**Manifest top-level keys are an allowlist too (v0.14.1 fix).** OpenClaw's loader reads only documented manifest fields ("Avoid custom top-level keys" — `docs/plugins/manifest.md`), and ClawHub's package validator raises `manifest-unknown-fields` for anything else. v0.14.0 shipped `author`, `license`, `repository`, and `permissions` here and tripped it. npm metadata belongs in `package.json`; `permissions` was never an OpenClaw field at all (it was our v0.11.1-era ClawScan declaration) — the host surface we touch is now disclosed in the plugin README instead. The manifest currently declares exactly: `id`, `name`, `version`, `description`, `activation`, `contracts`, `configSchema`, `nonSecretAuthMarkers`, `secretProviderIntegrations`. A regression test in `test/e2e/openclaw-plugin.test.ts` asserts that set. **`contracts.tools: ["aquaman_status"]` (v0.15.0) is required, not optional:** loaders since at least 2026.6.34 drop any agent tool not declared there (`plugin must declare contracts.tools before registering agent tools`), and `aquaman_status` was being silently dropped on 7.33 and 9.1. Don't add `categories` (not a manifest field on either line). `icon` exists but takes an HTTPS URL, not a path. `cliCommands` and `catalog` exist only on 2026.9.x. **Note: this class of bug is NOT catchable locally** — `clawhub package validate` skips the manifest-field check unless it can inspect an OpenClaw *source checkout* (an installed npm package yields `targetOpenClaw.status: "missing"`), so a local `PASS` proves nothing here.

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

**Model traffic goes through the loopback listener (v0.15.0), not the fetch interceptor.** OpenClaw's model calls run through its own `provider-transport-fetch` with its own undici dispatcher: it never calls `globalThis.fetch` and resolves hostnames itself, so the `aquaman.local` sentinel + UDS design cannot see provider traffic (verified on 2026.7.33 and 2026.9.1: the placeholder went straight to `api.anthropic.com`; a sentinel `baseUrl` dies with `ENOTFOUND`). The fix is OpenClaw's documented local-provider pattern:
- `aquaman openclaw setup` enables the token-gated loopback listener and writes `models.providers.<svc>.baseUrl = http://127.0.0.1:<port>/<svc>` (`/openai/v1` for OpenAI — same path shapes as the Hermes path, matching what each client appends). OpenClaw trusts that exact `scheme://host:port` origin for the guarded fetch path, plain HTTP included, with no SSRF flag needed.
- The **SecretRef resolver returns the loopback token** instead of the static placeholder (falling back to the placeholder when no listener is configured). The token has to travel as the provider api key because the listener is token-gated. It is a capability to reach 127.0.0.1, not a credential; the proxy strips it and injects the real key. The manifest declares `passEnv: ["HOME","AQUAMAN_CONFIG_DIR"]` so the resolver can find config.yaml under the gateway's near-empty child env.
- The plugin skips its sentinel `*_BASE_URL` env vars for providers already routed by config (`loopbackRoutedServices()`), so nothing hands a sidecar an unresolvable URL.
- `aquaman openclaw doctor` fails when an apiKey ref is wired but the provider still has no loopback baseUrl — that combination means the proxy is bypassed.
- Verified end-to-end on 2026.7.33 and 2026.9.1: real gateway, real agent turn, `[model-fetch]` hitting `127.0.0.1`, and an `anthropic use OK` audit entry.

**Channels bypass the fetch interceptor too — verified live 2026-09-20, unfixed.** With the interceptor active for `api.telegram.org` on a real 2026.7.33 gateway, Telegram's `getMe` went straight to Telegram and produced no audit entry. Telegram, Discord and Matrix each construct their own undici dispatcher per request; only MS Teams still reads the global fetch, and this build ships no Slack channel. So on 2026.7.33+ the plugin covers channel credentials at rest (storage + `aquaman openclaw migrate`) but NOT egress injection. Routing needs a per-channel endpoint override: `channels.telegram.apiRoot` exists; Discord and Slack have none; Matrix/Mattermost/Nextcloud Talk point at the user's own server. A Telegram route would also need the loopback gate to accept the token from the `/bot<token>` path segment (the Bot API client sends no headers we gate on) and to strip that segment before injecting — designed, not built. Tracked in ROADMAP as the v0.16.0 channel-routing item.

**Rejected alternative (investigated 2026-09-18):** routing provider traffic through a forward proxy. `models.providers.<id>.request.proxy` (`explicit-proxy` + `url`, needs `request.allowPrivateNetwork: true` for a loopback proxy) and env `HTTPS_PROXY` both work — the log shows `proxy=configured` / `proxy=env` — but undici's ProxyAgent CONNECTs for every https target, so the proxy sees only an opaque tunnel and cannot inject a header without terminating TLS with its own CA. That is the deferred v1.x+ "TLS interception via custom CA" item, and it would put a machine-local MITM CA into a credential-isolation product. OpenClaw's own secret egress proxy does exactly this (ephemeral CA per gateway start) but only for gateway-hosted exec, and exposes no extension point. There is no plugin hook for outbound HTTP and no Unix-socket support for provider transport.

**Fixed in v0.15.0 from the same real-gateway runs:** (1) no `activation` block meant the gateway never started the plugin (current OpenClaw doesn't startup-load implicitly; the gateway listened with "0 plugins" and the aquaman-proxy service's `start()` never ran). The manifest now declares `activation.onStartup: true`. (2) ProxyManager parsed only stdout line 0 for `{"ready":true}`, but plugin-mode prints "Credential proxy listening on …" first. It timed out after 10 s and killed the healthy proxy; it now scans every line (`test/e2e/proxy-manager-start.test.ts`). (3) `aquaman openclaw setup` created `plugins.allow: ["aquaman-plugin"]`, which also blocks OpenClaw's stock `anthropic`/`openai` provider plugins ("Unknown model"). Setup now only appends to an existing list, and doctor flags lists that exclude the configured provider plugins.

**OpenClaw 2.0 (= 2026.8.1, marketing name, not an SDK major) — verified 2026-09-18 on 2026.7.33 and 2026.9.1:**
- **Legacy `auth-profiles.json` now locks providers out** (#114033). Beside the SQLite store it makes `models status` and every agent turn fail with `requires legacy credential migration; run openclaw doctor --fix`, even when other profiles exist. `doctor --fix` archives the file (`*.migrated-*`), but aquaman-plugin ≤ 0.14.x rewrote it on every load, so the lockout came back. 7.33 just ignores the file. **v0.15.0: the plugin never writes it when `api.runtime.version` ≥ 2026.6.5.** `aquaman openclaw doctor` fails on a leftover file on ≥ 2026.8.1 (`legacyAuthProfilesBlockProviders()`) and prints the one-time `openclaw doctor --fix`.
- **`register()` runs in several modes.** `api.registrationMode` is `"full"` for a real gateway load and `"discovery"` / `"tool-discovery"` for `plugins inspect|doctor|install`. Before v0.15.0 we wrote files and env in every mode. Register everything always; side effects only on `full` (or when the field is absent on older hosts). `api.runtime.version` is the gateway version, so the plugin can gate without `child_process`. `api.version` is the plugin's own. Don't trust `meta.lastTouchedVersion`, which records the last writer.
- **Capability consent** (#130168/#131301/#134183) for third-party install/enable: `--accept-capabilities`, plus `--force` for npm/local specs (a `clawhub:` spec doesn't need it). A setup-style copy into `extensions/` with no install record loads without consent. `aquaman openclaw setup`'s fallback uses `clawhub:aquaman-plugin`, lets OpenClaw prompt interactively, and passes `--accept-capabilities` only with `--non-interactive` (`pluginInstallNeedsCapabilityConsent()`). Install records moved to `state/openclaw.sqlite`, and **`plugins.installs` in openclaw.json is rejected on 9.x** (`Unrecognized key`).
- Sentinels are `oc-sent-v2.<ciphertext>.end` on 2.0 (7.33 still `oc-sent-v1-`). Unknown sentinel-shaped values fail closed. We never read them back.
- First-party competition in-gateway: a default-off secret egress proxy (#123216, loopback MITM, per-secret `allowed_hosts`), a plaintext-SQLite shared secret store (#121559), and a 1Password broker (#106133). OpenClaw's own docs say sentinels "are not process isolation" and recommend "an external credential proxy".
- **CI lanes: 2026.7.33 (extended-stable) + 2026.9.1** (clawstat.us flags 9.4 "skip"). 2026.7.33's npm-shrinkwrap omits `@openclaw/ai` (openclaw/openclaw#151657), so doctor/agent paths crash on a clean `npm i -g`. CI installs the matching `@openclaw/ai` alongside when it's missing, and so must a local install. Node ≥ 24.15 is required (≥ 24.16 from 9.4).

**⚠️ OpenClaw ≥ 2026.6.5 — auth profiles moved to SQLite (openclaw/openclaw#89102, shipped 2026.6.5):** the runtime read path for `auth-profiles.json` was removed; provider auth profiles now live in each agent's `openclaw-agent.sqlite`. The plugin still writes the JSON placeholder at load (it's the import source), but on these versions OpenClaw only ingests it via a one-shot `openclaw doctor --fix`, which then archives the file. `aquaman openclaw doctor` is version-aware (`authProfilesAreSqliteOnly()` in `src/openclaw/integration.ts`) and prints the import step. The plugin's `index.ts` cannot run the import itself — it must not import `child_process` (keeps the OpenClaw security scanner clean). **This whole flow is LEGACY as of v0.14.0 — superseded by the SecretRef integration below on OpenClaw ≥ 2026.6.5; kept only for older gateways.**

### SecretRef provider integration (v0.14.0+, OpenClaw ≥ 2026.6.5)

OpenClaw's canonical credential surface is the **SecretRef** (upstream #82326, shipped 2026-05-29; docs call auth-profiles.json "not a runtime format" and the configure flow scrubs plaintext keys by default). Aquaman adopts it:

- **Manifest** (`openclaw.plugin.json`): `secretProviderIntegrations.aquaman` declares an exec resolver — `command: "${node}"`, `args: ["./dist/secrets-resolver.mjs"]` — plus `nonSecretAuthMarkers: ["aquaman-proxy-managed"]` (effective for bundled-origin plugins only in 2026.6.x; declared for forward compat).
- **Resolver** (`packages/plugin/secrets-resolver.mjs`, copied to `dist/` at build): speaks exec protocol v1 (request on stdin, `{protocolVersion:1,values:{...}}` on stdout) and returns the **static placeholder** for every id — no vault, no proxy, no env reads. The proxy strips whatever key the gateway presents and injects the real one upstream, so the SecretRef changes how the *placeholder* reaches the gateway, not the isolation boundary. Static-by-design: the gateway resolves its secrets snapshot eagerly at startup, possibly before `aquaman daemon` is up.
- **Config wiring** (`packages/proxy/src/openclaw/secretref.ts`, applied by `aquaman openclaw setup`, version-gated via `supportsSecretRefIntegrations()` ≥ 2026.6.5; `AQUAMAN_OPENCLAW_VERSION` env overrides detection): writes `secrets.providers.aquaman = { source: "exec", pluginIntegration: { pluginId: "aquaman-plugin", integrationId: "aquaman" } }` and `models.providers.<svc>.apiKey = { source: "exec", provider: "aquaman", id: "<svc>/api_key" }` into `~/.openclaw/openclaw.json`. Config-level refs deliberately (not auth-profile keyRef): runtime-read on every version, no SQLite import step, and they survive OpenClaw's plaintext scrubs. Never clobbers a user-set apiKey; upgrades the legacy literal placeholder in place.
- On SecretRef-wired installs, setup **skips** generating auth-profiles.json and the plugin's `ensureAuthProfiles()` skips too (`secretRefWiringPresent()` — a plain fs read of openclaw.json, no new imports for the scanner). `aquaman openclaw doctor` reports wiring state: active ✓ / half-migrated ✗ / available → (upgrade hint, not a failure).
- **2026.7.1+ sentinels (#102009):** SecretRef-backed model creds appear as opaque sentinels everywhere except network egress (`oc-sent-v1-...` on 7.x, `oc-sent-v2.<ciphertext>.end` on 2.0). Never read credential values back from auth storage/introspection; health checks must not compare key values. `openclaw secrets audit --allow-exec` resolves our resolver cleanly on both 7.33 and 9.1 (`refsChecked: 2`, `unresolved=0`).
- Trust gate: secret integrations only load from `bundled`/`global`-origin plugins — `~/.openclaw/extensions/` is `global`, so the standard install location qualifies; workspace-dir dev installs do NOT.

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

**Critical hook-protocol notes (re-verified 2026-09-18 against the live hooks reference + raw changelog @ Claude Code 2.1.276; stable 2.1.267):** Our contract (`permissionDecision` / `permissionDecisionReason` / `updatedInput` for PreToolUse; `additionalContext` + `updatedToolOutput` for PostToolUse; exit-2 via stderr) is fully supported; no field changes 2.1.203–2.1.276. (1) **There is no `PreToolUse.additionalEnvVars`.** Earlier notes here claimed one; it appears nowhere in the hooks reference, the changelog, or the tracker (checked 2026-09-18). PreToolUse outputs are exactly the four fields above; the only hook env mechanism is SessionStart's `CLAUDE_ENV_FILE`. Credentials must never transit hook output regardless. (2) **`PostToolUse.updatedToolOutput` — ADOPTED in v0.14.0**: `handlePostToolUse` runs the redactor over every tool's output (string via `redact`, structured via `redactDeep`, shape preserved) and rewrites it before it reaches the transcript. Opt-out `AQUAMAN_DISABLE_OUTPUT_REWRITE=1` (pre-2.1.170 hosts) degrades to warning-only `additionalContext`. Docs caveats: an `updatedToolOutput` that doesn't match the tool's output shape is ignored, and **OTel tool spans record the pre-hook output**, so our redaction doesn't reach telemetry exports. (3) **2.1.214** fixed exit-2 not blocking when the hook's stdout JSON fails schema validation, and **2.1.248** made JSON-looking-but-invalid stdout a hook error. Our hook output is locked down by schema-validity regression tests (`test/unit/coder-hook.test.ts`). (The exit-2 citation was wrong twice before: 2.1.210, then 2.1.217. It is **2.1.214**.) (3a) Compatible additions since: **2.1.222/2.1.224** (auto-allow in background tasks; hook-timeout misreported as rejection), **2.1.236** optional PostToolUse `classifierContext`, **2.1.251** `PreModelSwitch`/`PostModelSwitch` events. **2.1.232** added first-party redaction for GitLab token families (`glpat-`, `glrt-`, `gloas-`, …); our BUILTIN_PATTERNS don't cover those yet. (4) **Sandbox: a UDS IS an allowlist subject — corrected in v0.15.0.** v0.14.1 claimed the broker's UDS was "not an allowlist subject". That holds for HOST allowlists (`allowedDomains`, 2.1.219 `strictAllowlist`) but is wrong for sockets: the sandbox denies every Unix-socket connect unless the path is in `sandbox.network.allowUnixSockets` (macOS only; exact path or parent dir, `~` ok, globs ignored) or `allowAllUnixSockets: true` (the only option on Linux/WSL2, where seccomp can't filter by path — since 2.1.92). Verified empirically 2026-09-18 with `@anthropic-ai/sandbox-runtime` 0.0.76 (the runtime Claude Code embeds): default → `connect EPERM`; file-read rules never gate the connect. v0.15.0: `coder setup claude-code` adds exactly the socket on macOS, `coder doctor` checks merged user/managed/project settings, `BrokerClient` maps EPERM/EACCES to a sandbox hint, and the README carries the one-line Linux limitation. Hook commands themselves run unsandboxed; only the rewritten Bash command is sandboxed. Never recommend `excludedCommands` for `aquaman-coder exec` (it unsandboxes the whole wrapped command). (5) **First-party credential substitution exists in the sandbox**: `sandbox.credentials` (`extract` / `decode: "jwt"` + `maskClaims` / `awsPairs` / `sigv4`, 2.1.214; `mode: "mask"` for credential files on Linux/WSL, 2.1.221) — our placeholder-plus-egress pattern, scoped to sandboxed sessions. 2.1.246 stopped honoring project/local-scope `sandbox.credentials`; 2.1.251 requires approval for managed settings that inject credentials or terminate TLS. No vault backends, no per-read audit, no cross-host story, but any copy claiming local Claude Code has *no* first-party credential isolation is wrong. #29910 (built-in secrets management) still open. When extending, **verify against the live Claude Code docs**, not training-data memory.

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
  (base URLs + placeholder key; v0.14.0+ also always emits `AQUAMAN_LOOPBACK_URL` +
  `AQUAMAN_LOOPBACK_TOKEN` for the secret source). Honors `HERMES_HOME` (the var the
  Hermes CLI itself uses). Idempotent delimited block.
- `packages/proxy/src/hermes/integration.ts` — detect Hermes, configure, write env.
- `packages/proxy/src/core/types.ts` — `LoopbackConfig` (`enabled`/`port`/`token`/`host`)
  + `HermesConfig`. Config defaults disabled; env overrides `AQUAMAN_LOOPBACK_ENABLED`/
  `_PORT`/`_TOKEN` (no `_HOST` override — the bind stays loopback).
- CLI: `aquaman hermes setup|doctor|status|configure`. `loadLoopbackOptions()` refuses to
  start an enabled-but-tokenless listener (an untokened loopback proxy would be open).

**Hermes >=0.17/0.18 operational notes (verified 2026-07-07 vs hermes-agent 0.18.0):** the base-URL detection, plugin contract, `--version` format, and `HERMES_HOME`/`.env` loading are all compatible — no integration changes needed. Three additions to know: (1) **managed scope** — a root-owned `/etc/hermes/.env` overrides `~/.hermes/.env` AND shell exports; if it pins our env vars the proxy is silently bypassed (`aquaman hermes doctor`/`status` now detect this via `managedScopeShadowedKeys()`); (2) `gateway.multiplex_profiles` (off by default) scopes env per profile — multi-profile users need the aquaman block in each profile's env; (3) Hermes cron jobs pairing `provider: anthropic` with an explicit off-host `base_url` override are refused by its 0.18 exfil guard — jobs inheriting the session runtime (our env-var path) are unaffected.

**Python plugin (`packages/hermes/`):** `aquaman-hermes` on PyPI. A
stdlib-only directory plugin (`plugin.yaml` + `register(ctx)`) installed into
`$HERMES_HOME/plugins/aquaman/` via `aquaman-hermes install`, enabled with
`hermes plugins enable aquaman`. Adds `/aquaman-status` slash command, `aquaman_status`
tool, and an `on_session_start` health probe. The status/command/hook surface holds no
credentials; LLM-key isolation is entirely proxy-side. **Do NOT put isolation logic here.**

**Secret source (v0.14.0+, Hermes ≥ 0.18.1):** the plugin also registers an `aquaman`
`SecretSource` via `ctx.register_secret_source()` (feature-detected with `hasattr`, so
0.18.0 hosts stay sugar-only). Users bind project/tool secrets in Hermes' config.yaml —
`secrets.aquaman.env: { GITHUB_TOKEN: aquaman://github/token }` — and the source resolves
them at Hermes startup through the **token-gated loopback `POST /broker/resolve`**
(token from `AQUAMAN_LOOPBACK_TOKEN`, written into the `~/.hermes/.env` managed block by
`aquaman hermes setup` alongside `AQUAMAN_LOOPBACK_URL`). Design rules, all
conformance-tested (`tests/test_secret_source.py`, `tests/test_compliance.py`, and
`tests/test_conformance.py` — Hermes' OWN kit against a real install; see below):
- **Two-tier security model, non-negotiable:** LLM provider keys (ANTHROPIC/OPENAI) are
  REFUSED by the source — they stay on the loopback proxy path (process-isolated
  placeholder). Project secrets materialize into Hermes' env (same residency as any
  Hermes secret source — this is NOT process isolation and the docs say so), backed by
  the user's vault with per-read hash-chained audit instead of a plaintext `.env` line.
- Contract compliance (`agent/secret_sources/base.py` api v1): `fetch()` never raises,
  never prompts, never writes `os.environ`; per-ref failures are warnings (one bad ref
  never sinks the rest); proxy-down/timeout/auth failures are typed fatal errors; Hermes
  always starts regardless. No disk cache (would defeat residency posture).
- `protected_env_vars()` covers the token var + wired provider placeholders, so no other
  secret source can overwrite the loopback wiring; `override_existing` defaults true.
- Every surfaced error/warning string is scrubbed of the token (`_scrub_secret_text`).
- **v0.15.0: each bound ref must also be declared to the daemon** (`aquaman broker allow
  <ref>`), and the proxy refuses anthropic/openai over loopback server-side. Refusals are
  404s, so the source records them as per-ref warnings, not the fatal token error.
  `aquaman hermes doctor` reads `$HERMES_HOME/config.yaml` (`hermesSecretSourceRefs()`) and
  lists undeclared bindings.

**Hermes 0.19 contract notes (v0.14.1, verified 2026-08-03 against the 0.19.0 wheel AND
`main`):** 0.19.0 (2026-07-20) rewrote the orchestrator — mapped-beats-bulk precedence,
first-claim-wins, conflict warnings, per-var provenance, `secrets.sources: [...]` ordering.
Our source still registers unchanged (the registry gates on `api_version` / `shape` /
`scheme` / name, all of which we declare). Three additions handled in v0.14.1:
- **Per-fetch environment view** — `get_source_environment()` (a ContextVar the
  orchestrator installs around `fetch()`). It was `main`-only when v0.14.1 was written and
  **shipped in the 0.20.x line** (present in `agent/secret_sources/base.py` at tag
  `v2026.8.16.2`) — so this is live host behavior, not forward-compat. Every env read on
  the fetch path goes through `_source_env()`, which feature-detects it and falls back to
  `os.environ`. It matters under `gateway.multiplex_profiles`, where the view is the
  *profile's* env — reading `os.environ` would resolve another profile's token and URL.
- **`config_schema()`** (present in 0.19.0) and **`remediation(kind, cfg)`** (`main` when
  written, also shipped in 0.20.x) are now implemented; remediation points at aquaman's
  verbs, since Hermes' generic default suggests a `hermes secrets aquaman setup` command
  we don't ship.
- **Conformance kit** — Hermes' docs call green conformance "the review bar." The kit is
  repo-only (the wheel ships `agent/secret_sources/` but not `tests/`), so it's vendored
  verbatim at `packages/hermes/tests/_hermes_conformance.py` with provenance;
  `test_conformance.py` subclasses it and self-skips without hermes-agent. CI runs it
  against the real host, pinned via the workflow-level `HERMES_VERSION`.
Also note: Hermes 0.19 ships **built-in Bitwarden + 1Password secret sources**, and its
docs list a generic command-helper source in-tree — the bundled set is closed and all
other backends must be plugins, which is the lane we occupy.

**Hermes 0.20 notes (checked 2026-08-17):** 0.20.0 landed 2026-08-03 and 0.20.1/.2/.3
followed through 2026-08-17. **`SECRET_SOURCE_API_VERSION` is still `1`** at tag
`v2026.8.16.2`, and the ABC surface we implement (`fetch` / `is_enabled` /
`override_existing` / `protected_env_vars` / `fetch_timeout_seconds` / `config_schema` /
`remediation`) is unchanged — our source registers as-is. What did change: the generic
**command-helper secret source is now in-tree** (the #44509 concept, plus a `run_secret_cli`
helper in `base.py`); vault-injected keys are **scoped per profile home**; the orchestrator
gained `preserve_existing` + profile aliasing; `${env:VAR}` SecretRef parity now spans
config.yaml and MCP config, and **secret-source env vars reach stdio MCP servers** (widens
where materialized project secrets land — the two-tier docs should say so). **PyPI still
serves 0.19.0 only** — 0.19.1 and the 0.20.x line are GitHub-tagged releases — so CI's
`HERMES_VERSION: "0.19.0"` remains the newest installable wheel and the vendored
conformance kit is still the 0.19 one.

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

### Credential broker scope (v0.15.0+)

`POST /broker/resolve` is the one endpoint that returns a credential VALUE instead of
injecting it. Through v0.14.x it was routed before `allowedServices`/policy in every mode,
including `openclaw plugin-mode`, so any same-user process (an OpenClaw agent's exec tool,
`curl --unix-socket ~/.aquaman/proxy.sock`) could read any vault entry. That is the
ClawScan `suspicious` finding against aquaman-plugin 0.14.x, present since v0.12.0. Rules
now (`packages/proxy/src/broker-scope.ts`, passed to `createCredentialProxy({ broker })`):
- **OpenClaw-hosted proxies get no scope → broker off** (`openclaw plugin-mode`,
  `openclaw start`): 404 `broker_disabled`, no vault lookup. Never add a scope there.
- **`aquaman daemon` serves declared refs only**: `projects.yaml` env refs ∪ config.yaml
  `broker.allowedRefs` (managed by `aquaman broker list|allow|revoke`, which edit the raw
  file so env overrides are never persisted). Both files are mtime-reloaded (no restart);
  an unparseable file declares nothing. `broker.enabled: false` / `AQUAMAN_BROKER_ENABLED=false`
  turns it off.
- **Loopback never materializes the Hermes LLM tier** (`HERMES_SUPPORTED_SERVICES`), even
  if declared: 404 `broker_ref_isolated`. It's the Python client's two-tier rule,
  enforced server-side.
- The scope is checked **before** the vault, so refusals don't reveal vault contents. 404
  (not 403) because the Hermes source treats 401/403 as a fatal token error; refusals carry a
  machine-readable `code` and are audited.
- Honest limit: same-user processes can reach the socket and edit `~/.aquaman/*`.
  Declaring a ref opts it into materialization for them. The scope keeps *undeclared* and
  *isolated* credentials out of reach; it is not an inter-process boundary for one user.
- Both proxies bind `~/.aquaman/proxy.sock`, and the last one started wins (pre-existing).
  With the OpenClaw plugin's proxy on the socket, coder/Hermes broker calls get
  `broker_disabled` — `coder doctor` names that case.
- Conformance: `test/compliance/broker-scope.test.ts` (in-process + real `plugin-mode` /
  `daemon` processes).

### Credential caching (v0.13.1+)

`CachingStore` (`packages/proxy/src/core/credentials/caching-store.ts`) is a TTL'd in-memory decorator over any `CredentialStore`, applied **only in daemon contexts** (the three `createCredentialProxy` sites in `cli/index.ts`, via `wrapWithCache(store, resolveCacheTtl(config))`). One-shot CLI commands never cache. Rationale: 1Password prompts biometrics per `op` spawn (making unattended agents unusable), Bitwarden spawns `bw` (~1–2 s), Vault does an HTTP round-trip — per request/broker-resolve without the cache.

- **Default policy** (`resolveCacheTtl()` in `core/utils/config.ts`): ON at 900 s for `CACHED_BY_DEFAULT_BACKENDS` (`1password`, `bitwarden`, `vault`); OFF for the rest (keychain is fast; keepassxc/systemd-creds/encrypted-file already cache internally for the daemon lifetime — with no TTL, so the new cache is strictly tighter). Explicit `credentials.cacheTtlSeconds` (or `AQUAMAN_CACHE_TTL`) overrides for any backend; `0` disables.
- **Semantics:** no negative caching (misses always hit the backend); `set`/`delete` write through and invalidate that key (rotation via aquaman is visible immediately; external rotation lands within TTL); `list`/`exists` pass through; errors propagate, never cached, and no stale value is served after expiry.
- **Security invariants** (conformance-tested in `test/compliance/cache-residency.test.ts`): memory-only (the module imports nothing but the store type — no fs/net/child_process); audit stays per-request (cache hits still emit `onRequest` events); policy denial happens before the cache; the isolation boundary is unchanged — the cache extends how long values reside in the proxy process, where they already transit per request.
- **1Password zero-prompt path:** `OP_SERVICE_ACCOUNT_TOKEN` (service account scoped to the `aquaman` vault) — `op` inherits the daemon's env, no code path needed. `aquaman doctor` and `aquaman hermes doctor` print the hint when the backend is `1password` in biometric mode (`printOnePasswordModeHint()` in `cli/index.ts`). `OP_CONNECT_HOST`/`OP_CONNECT_TOKEN` take precedence over the service-account token if both are set.

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
aquaman broker list/allow/revoke   # v0.15.0+: which refs the daemon may hand out
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

The plugin (`packages/plugin/index.ts`) auto-generates `~/.openclaw/agents/main/agent/auth-profiles.json` on load if the file doesn't exist — **only on gateways older than 2026.6.5 and only on a full load** (v0.15.0+). Newer gateways don't read the file (SQLite), and the 2.0 line locks providers out when it exists; they get the SecretRef wiring from `aquaman openclaw setup` instead, and the plugin warns when that wiring is missing.

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
| `keepassxc` | Any (with .kdbx file) | Users with existing KeePass databases — **needs `npm i -g kdbxweb argon2`** (v0.14.1+) |
| `1password` | Any (via `op` CLI) | Team credential sharing |
| `vault` | Any (via HTTP API) | Enterprise secrets management |
| `systemd-creds` | Linux (systemd ≥ 256) | TPM2-backed, no root needed, no master password |
| `bitwarden` | Any (via `bw` CLI) | Bitwarden users |

Backend selection is auto-detected by `aquaman setup` and `aquaman openclaw setup` (macOS → keychain; Linux → keychain if libsecret, else systemd-creds if systemd ≥ 256, else encrypted-file). Maintainer-level details of each backend (file layout, encryption flow, in-memory caching) are in `OPERATIONS.md`.

### Dependency posture (v0.14.1+)

The published packages carry as little as possible, because a consumer's `npm audit` of
our tarball is a **published security signal** — it is what flipped the ClawHub scan of
0.14.0 to `suspicious`.

- **`kdbxweb` + `argon2` are optional peer deps of `aquaman-proxy`, not dependencies.**
  `kdbxweb@2.1.1` (latest) requires `@xmldom/xmldom@^0.7.4`, whose 0.7.x line is unfixed
  (5 high advisories) — and the repo-root `overrides` pin to 0.8.13 **does not publish**,
  so every `npm i -g aquaman-proxy@0.14.0` resolved a vulnerable @xmldom. `optionalDependencies`
  would NOT have fixed this (npm installs those by default); optional *peers* are the only
  form npm skips. Both are lazily imported (`backends/keepassxc.ts`) and the existing
  error text already tells users to `npm install kdbxweb argon2`. They stay in the repo's
  root devDependencies so the KeePassXC tests keep running.
- **`openclaw` is an optional peer of `aquaman-plugin`.** Non-optional peers are
  auto-installed by npm ≥ 7, so `npm i aquaman-plugin` was pulling an ~86 MB copy of the
  gateway into consumer trees (and its advisories into their audits). The host always
  provides itself.
- **`undici` and `@sinclair/typebox` are exact-pinned** in the plugin (ClawScan flagged
  caret ranges as reproducibility risk for a credential proxy). Dependabot bumps them.
- **The OpenClaw gateway is not in the lockfile (v0.15.0+).** It was a root devDependency
  only to serve as the e2e harness, and extended-stable 2026.7.33 ships an
  `npm-shrinkwrap.json` pinning vulnerable hono/@hono/node-server/protobufjs/qs that root
  `overrides` can't reach. CI's e2e job installs the pinned gateway globally per lane
  (`2026.7.33`, `2026.9.1`), and `test/e2e/openclaw-plugin.test.ts` calls `$OPENCLAW_BIN`
  (default `openclaw` on PATH). **Never `npx openclaw`** there: with no local install it
  silently downloads `latest`. Lockfile went 508 → 203 packages; `npm audit` (dev
  included) = 0. `packaging-posture.test.ts` fails if openclaw comes back.
- **Lockfile regeneration uses `--legacy-peer-deps`**, now pinned by a root `.npmrc`
  (`legacy-peer-deps=true`), the same flag CI's `npm ci` passes. Without it npm follows the
  optional peer edges (proxy → kdbxweb/argon2) and marks those subtrees `devOptional`,
  which `npm audit --omit=dev` keeps, so the shipped-deps gate audits the wrong tree. That
  is what broke Dependabot PRs #62/#63 (superseded in v0.15.0). Whether Dependabot honors
  the `.npmrc` is unverified — check the next Dependabot PR's lockfile.

Verified shape (v0.14.1): a fresh install of the `aquaman-proxy` + `aquaman-plugin`
tarballs is **43 packages, 0 vulnerabilities**, with no `@xmldom/xmldom` and no `openclaw`.
npm ≥ 11.19 (bundled with Node 24.21) no longer runs install scripts unless allowlisted;
`npm rebuild <pkg>` still runs them (it warns), which is what CI relies on for keytar.

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
| `packages/proxy/src/core/credentials/caching-store.ts` | TTL'd in-memory cache decorator (daemon-only; v0.13.1+) |
| `packages/proxy/src/core/audit/logger.ts` | Hash-chained logging |
| `packages/proxy/src/daemon.ts` | HTTP proxy server on UDS (header, url-path, basic, oauth auth modes) |
| `packages/proxy/src/request-policy.ts` | Request-level policy enforcement (method+path rules, segment-based glob matching) |
| `packages/proxy/src/broker-scope.ts` | Credential-broker scope: declared refs (projects.yaml + broker.allowedRefs), loopback LLM-tier denial (v0.15.0+) |
| `packages/proxy/src/cli/index.ts` | CLI (Commander.js, 20 commands incl. `setup`, `doctor`, `policy list/test`, `migrate openclaw`) |
| `packages/proxy/src/service-registry.ts` | Builtin service definitions (25 services) |
| `packages/proxy/src/oauth-token-cache.ts` | OAuth client credentials token exchange + caching |
| `packages/proxy/src/migration/openclaw-migrator.ts` | Migrates channel + plugin creds from openclaw.json to secure store |
| `packages/proxy/src/openclaw/env-writer.ts` | Generates env vars for OpenClaw integration |
| `packages/proxy/src/openclaw/integration.ts` | Detects and launches OpenClaw with env vars |
| `packages/proxy/src/openclaw/secretref.ts` | SecretRef wiring for openclaw.json (version gate, merge, doctor status; v0.14.0+) |
| `packages/plugin/secrets-resolver.mjs` | SecretRef exec resolver (protocol v1, static placeholder; shipped as `dist/secrets-resolver.mjs`) |
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
| `test/compliance/broker-scope.test.ts` | Broker-scope compliance (AC-3/AC-6/AU-2, ATLAS T0055/T0098) incl. real `plugin-mode` + `daemon` processes |
| `test/compliance/cache-residency.test.ts` | Credential-cache compliance (AU-2 audit parity, AC-3 deny-before-cache, SC-28 memory-only, T0055 isolation, IA-5 invalidation) |
| `test/unit/credentials/caching-store.test.ts` | CachingStore unit tests (TTL, invalidation, no negative caching, error transparency) |
| `test/unit/hermes/config-writer.test.ts` | Hermes env-writer unit tests (path mapping, HERMES_HOME, idempotent block, loopback wiring vars) |
| `test/unit/openclaw-secretref.test.ts` | SecretRef unit tests (version gate, wiring merge/idempotency, resolver exec-protocol spawn tests) |
| `packages/hermes/tests/test_plugin.py` | Python plugin unit tests (health probe, status text, register wiring) |
| `packages/hermes/tests/test_secret_source.py` | Secret source unit tests (fetch paths, error taxonomy, provider-key refusal, real-HTTP broker tests) |
| `packages/hermes/tests/test_compliance.py` | Python plugin compliance (ATLAS T0098/T0055, NIST SI-10/AC-3/AC-6 — status + secret-source surfaces never leak token/values; isolation not downgradeable) |
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
