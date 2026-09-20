# AGENTS.md

## What this is

Credential isolation for AI agents. API keys, channel tokens and `.env`-grade secrets never enter the agent's process. They live in a vault backend (Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, encrypted-file, systemd-creds) and a separate proxy injects them at egress. A compromised agent holds a marker, not a key.

Three integration paths:

1. **OpenClaw Gateway** (`aquaman-plugin`, npm + ClawHub). LLM providers and channel credentials, 25 builtin services across 5 auth modes.
2. **Coding agents** (`aquaman-coder`, v0.12.0+, npm). Claude Code today; Codex, OpenCode and Cursor planned. Per-tool-call materialization through `/broker/resolve`.
3. **Hermes** (`aquaman-hermes`, v0.13.0+, PyPI). A Python host with no transport hook, so isolation is proxy-side: a token-gated loopback listener plus (v0.14.0+) an `aquaman` secret source for project secrets.

Target platform: Unix-like (Linux, macOS, WSL2).

We chose process isolation over detection. Detection-based tools redact after the credential is already in agent memory; here it never arrives.

## Monorepo structure

```
packages/
├── proxy/    # aquaman-proxy: daemon, broker, vault, audit, policy, CLI.
│             #   The canonical core. Hermes loopback listener lives here too.
├── plugin/   # aquaman-plugin: OpenClaw adapter (frozen scope)
├── coder/    # aquaman-coder: coding-agent adapter
└── hermes/   # aquaman-hermes: Python plugin (PyPI). Sugar only; the
              #   isolation is proxy-side. Do NOT put isolation logic here.
```

Import rules (`docs/PACKAGES.md`): plugin → proxy ✓, coder → proxy ✓, plugin ↔ coder ✗, proxy → plugin/coder ✗. Hermes talks to the proxy only over the loopback wire contract, no code import either way.

Coder's CLI is spawned from source in tests, so anything it imports at runtime must resolve without a built `packages/proxy/dist`. Keep cross-package runtime imports out of `packages/coder/src` except where already present.

## Transports and access control

| Path | Transport | Access control |
|---|---|---|
| Coding agents, any client that can dial a socket | Unix socket `~/.aquaman/proxy.sock` | File permissions (`0600`) |
| Hermes (v0.13.0+), OpenClaw model traffic (v0.15.0+) | Loopback TCP `127.0.0.1:<port>` | Per-install token, constant-time check, loopback bind |

Hermes and OpenClaw each build their own HTTP client and cannot dial a socket. The token is a capability to reach the local proxy, not a credential: generated per install, stored in `~/.aquaman/config.yaml` (`0600`), stripped by the proxy before the real key is injected. Any local process can reach a loopback port, including other users, where the socket's `0600` shuts them out, so the listener stays off until `aquaman hermes setup` or `aquaman openclaw setup` turns it on.

## Proxy request flow

1. Request arrives at `/<service>/<path>` on either listener (loopback requests must present the token first).
2. Policy check on method + remaining path. Denied returns 403 before any credential lookup.
3. Vault lookup for `<service>/<credentialKey>`.
4. Strip any inbound auth header or token, inject the real credential per the service's `authMode`:
   - `header`: providers (Anthropic, OpenAI, GitHub, xAI, Cloudflare AI, Mistral, Hugging Face, ElevenLabs) and channels (Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, Zalo)
   - `url-path`: `/bot<TOKEN>/method` (Telegram)
   - `basic`: Twilio, BlueBubbles, Nextcloud Talk
   - `oauth`: client-credentials exchange (MS Teams, Feishu, Google Chat)
   - `none`: at-rest storage only, traffic rejected (Nostr, Tlon)
5. Forward upstream, pipe the response back, append a hash-chained audit entry.

Builtin service definitions cannot be overridden through `services.yaml` or `register()`, so a poisoned config can't redirect real credentials to an attacker's host. `override()` is test-only; `ServiceRegistry.isBuiltinService()` is the check.

## Credential broker scope (v0.15.0+)

`POST /broker/resolve` is the one endpoint that returns a credential VALUE rather than injecting it. Through v0.14.x it served any service/key in every mode, including `openclaw plugin-mode`, so any same-user process could read the whole vault. That was the ClawScan `suspicious` finding, present since v0.12.0. Rules now live in `packages/proxy/src/broker-scope.ts`, passed as `createCredentialProxy({ broker })`:

- OpenClaw-hosted proxies (`openclaw plugin-mode`, `openclaw start`) get no scope, so the broker is off: 404 `broker_disabled`, no vault lookup. Never add a scope there.
- `aquaman daemon` serves declared refs only: `projects.yaml` env refs plus config.yaml `broker.allowedRefs` (managed by `aquaman broker list|allow|revoke`, which edit the raw file so env overrides are never persisted). Both files are mtime-reloaded. An unparseable file declares nothing. `broker.enabled: false` or `AQUAMAN_BROKER_ENABLED=false` turns it off.
- Over loopback the Hermes LLM tier is never materialized even when declared: 404 `broker_ref_isolated`.
- The scope is checked before the vault, so refusals reveal nothing about vault contents. Refusals are 404 (not 403) because the Hermes source treats 401/403 as a fatal token error; they carry a machine-readable `code` and are audited.
- Honest limit: declaring a ref opts it into materialization for any process running as you. The scope keeps undeclared and isolated credentials out of reach; it is not an inter-process boundary for one user.
- Both proxies bind the same socket and the last one started wins, so with the plugin's proxy running, coder and Hermes broker calls get `broker_disabled`. `coder doctor` names that case.

Conformance: `test/compliance/broker-scope.test.ts`, including real `plugin-mode` and `daemon` processes.

## OpenClaw integration

The plugin runs inside the Gateway process. On load it reads `services` from `api.pluginConfig`, registers `/aquaman-status`, the `aquaman_status` tool and the `/aquaman` CLI commands, and via `registerService('aquaman-proxy')` spawns `aquaman openclaw plugin-mode` and activates the `globalThis.fetch` interceptor.

Key files: `index.ts` (entry; must not import `child_process` or `fetch`, keeping the OpenClaw scanner clean; SDK types are declared locally because the `openclaw/plugin-sdk` import broke in 2026.3.23, #53403), `src/proxy-manager.ts` (spawn), `src/proxy-health.ts` (fetch calls), `src/http-interceptor.ts`, `openclaw.plugin.json`. Installs to `~/.openclaw/extensions/aquaman-plugin/`. The unscoped package name must equal the manifest `id`.

### Model traffic goes through the loopback listener (v0.15.0)

OpenClaw's model calls use its own `provider-transport-fetch` with its own undici dispatcher. It never calls `globalThis.fetch` and resolves hostnames itself, so the old `aquaman.local` sentinel could not see provider traffic: the placeholder went straight to the provider and a sentinel `baseUrl` failed with `ENOTFOUND` (verified on 2026.7.33 and 2026.9.1).

- `aquaman openclaw setup` enables the loopback listener and writes `models.providers.<svc>.baseUrl = http://127.0.0.1:<port>/<svc>` (`/openai/v1` for OpenAI, matching what each client appends). OpenClaw trusts that exact origin for guarded model requests, plain HTTP included, no SSRF flag needed. A user-set `baseUrl` is never clobbered.
- The SecretRef resolver returns the loopback token, falling back to the `aquaman-proxy-managed` placeholder when no listener is configured. The manifest declares `passEnv: ["HOME","AQUAMAN_CONFIG_DIR"]` so it can read config.yaml under the gateway's near-empty child env.
- The plugin skips its sentinel `*_BASE_URL` vars for providers already routed by config (`loopbackRoutedServices()`).
- `aquaman openclaw doctor` fails when a provider has an apiKey ref but no loopback baseUrl, because that means the proxy is bypassed.

Rejected alternative: a forward proxy. `models.providers.<id>.request.proxy` and `HTTPS_PROXY` both route traffic (`proxy=configured` / `proxy=env`; a loopback proxy also needs `request.allowPrivateNetwork`), but undici CONNECTs for every https target, so a proxy sees an opaque tunnel and cannot inject without terminating TLS with its own CA. There is no plugin hook for outbound HTTP and no Unix-socket support for provider transport.

### Channel egress: Telegram routed, the rest at-rest only

The fetch interceptor stopped covering channels on 2026.7.33+: each channel builds its own undici dispatcher per request and never reads `globalThis.fetch`. Verified live 2026-09-20, `getMe` reached Telegram directly with no audit entry.

Routing therefore needs whatever endpoint override the host exposes, and only Telegram has one.

- `aquaman openclaw setup` writes `channels.telegram.apiRoot = http://127.0.0.1:<port>/telegram` and sets `botToken` to the loopback token. Verified end to end on a live 2026.9.1 gateway: `getMe` went through the proxy, the vault token was injected, and the call was audited.
- The Bot API has no auth header, so the loopback token arrives in the `/bot<TOKEN>` segment. `findUrlPathCredentialSlot()` in `daemon.ts` accepts it there, strips it before the policy check and the request log, and puts the real token back at the same index. Index matters: media downloads are `/file/bot<TOKEN>/<path>`, so prefixing blindly would build `/bot<real>/file/...`.
- Wiring is all-or-nothing per channel. A self-hosted `apiRoot`, a `tokenFile`, multi-account config, or an empty vault means the channel is left untouched and reported, because a half-wired channel is a dead bot.
- Everything else stays at-rest only (vault storage plus `aquaman openclaw migrate`). Discord and Slack expose no override; Matrix, Mattermost and Nextcloud Talk already point at the user's own server. `aquaman openclaw doctor` lists them as unroutable rather than implying coverage.

Gotchas, all verified against the 2026.9.4 bundle:

- `apiRoot` governs every Bot API surface: methods, the `getUpdates` long poll, `/file` downloads, setWebhook/deleteWebhook, probes, membership audits. No surface falls back to the literal host.
- No https-only check anywhere, so a plain `http://` loopback origin is accepted.
- The SSRF guard runs on media downloads only, and a custom `apiRoot` auto-allowlists its own host, so `127.0.0.1` needs no `dangerouslyAllowPrivateNetwork`. A redirect off that host is still blocked.
- Use the literal `127.0.0.1`. One fallback attempt forces `family: 4` unconditionally, so an IPv6-only listener silently loses two of three attempts.
- `getUpdates` holds a poll 30s and the client aborts at 45s; media allows 120s to first byte. The proxy's 30s idle timeout would cut polls short, so the telegram service definition sets `minRequestTimeout: 180000` and the daemon takes the max of that and the configured timeout.
- `channels.telegram.proxy`, `OPENCLAW_PROXY_URL` and `http_proxy`/`https_proxy` all steal the request before it reaches the listener.
- The loopback token is written into openclaw.json, so `isAquamanPlaceholder()` (core/utils/config.ts) treats the `aqm_lb_` prefix as aquaman-owned. Without it the migrator reports our own placeholder as a plaintext credential.

### Manifest rules

`additionalProperties: false`, three config keys: `backend`, `services` (also gates the interceptor's host map), `autoGenerateAuthProfiles`. Do not add config keys; use `~/.aquaman/config.yaml` for advanced settings.

Top-level manifest keys are an allowlist too. The manifest declares exactly `id`, `name`, `version`, `description`, `activation`, `contracts`, `configSchema`, `nonSecretAuthMarkers`, `secretProviderIntegrations`, and `test/e2e/openclaw-plugin.test.ts` asserts that set. v0.14.0 shipped `author`/`license`/`repository`/`permissions` here and tripped ClawHub's `manifest-unknown-fields`; npm metadata belongs in `package.json`.

- `activation.onStartup: true` is required. Current OpenClaw does not startup-load plugins implicitly, and without it the gateway never starts the proxy service.
- `contracts.tools: ["aquaman_status"]` is required. Loaders since 2026.6.34 silently drop undeclared agent tools.
- Do not add `categories` (not a field). `icon` takes an HTTPS URL, not a path. `cliCommands` and `catalog` exist only on 2026.9.x.
- This class of bug is not catchable locally: `clawhub package validate` skips the manifest-field check without an OpenClaw source checkout, so a local PASS proves nothing.

### SecretRef wiring (v0.14.0+, OpenClaw ≥ 2026.6.5)

SecretRef is OpenClaw's canonical credential surface (#82326); auth-profiles.json is "not a runtime format" and the configure flow scrubs plaintext keys.

- Manifest: `secretProviderIntegrations.aquaman` declares an exec resolver (`command: "${node}"`, `args: ["./dist/secrets-resolver.mjs"]`) plus `nonSecretAuthMarkers`.
- Resolver (`packages/plugin/secrets-resolver.mjs`, copied to `dist/` at build): exec protocol v1, dependency-free, no vault or network. Must keep resolving when the daemon is down, since the gateway resolves its snapshot eagerly at startup.
- Config wiring (`packages/proxy/src/openclaw/secretref.ts`, applied by setup, gated by `supportsSecretRefIntegrations()`; `AQUAMAN_OPENCLAW_VERSION` overrides detection): writes `secrets.providers.aquaman` and `models.providers.<svc>.apiKey` refs. Config-level refs are runtime-read on every version, need no SQLite import, and survive plaintext scrubs.
- Trust gate: secret integrations load only from `bundled`/`global` origin plugins. `~/.openclaw/extensions/` qualifies; workspace dev installs do not.
- Sentinels (#102009): SecretRef-backed creds appear as opaque `oc-sent-v1-` (7.x) or `oc-sent-v2.<ciphertext>.end` (2.0) values everywhere except egress. Never read credential values back from auth storage, and never compare key values in health checks.

### OpenClaw 2.0 (2026.8.1+) behaviors

- A legacy `auth-profiles.json` blocks providers with `AUTH_PROFILE_MIGRATION_REQUIRED` (#114033). The plugin never writes it on gateways ≥ 2026.6.5 (they read SQLite instead), and doctor fails on a leftover file, pointing at the one-time `openclaw doctor --fix`.
- `register()` runs in several modes. `api.registrationMode` is `"full"` for a real load and `"discovery"`/`"tool-discovery"` for `plugins inspect|doctor|install`. Register everything in every mode; do side effects only on `full` (or when the field is absent). `api.runtime.version` gives the gateway version without `child_process`; `api.version` is the plugin's own; `meta.lastTouchedVersion` is unreliable.
- Capability consent gates third-party install/enable: `--accept-capabilities`, plus `--force` for npm/local specs (`clawhub:` specs need only the consent flag). Setup uses the `clawhub:` source, lets OpenClaw prompt interactively, and passes the flag only with `--non-interactive`.
- `plugins.installs` in openclaw.json is rejected on 9.x; install records moved to `state/openclaw.sqlite`.
- `plugins.allow` governs OpenClaw's own plugins too, so a list containing only `aquaman-plugin` blocks the stock `anthropic`/`openai` providers ("Unknown model"). Setup only appends to an existing list and never creates one; doctor flags lists that exclude the configured providers.
- CI lanes: 2026.7.33 (extended-stable) and 2026.9.1 (clawstat.us flags 9.4 as skip). 2026.7.33's shrinkwrap omits `@openclaw/ai` (openclaw#151657), so CI installs it alongside when missing. Node ≥ 24.15 required.

## Coding agents (aquaman-coder)

```
~/.claude/settings.json ──hooks──> aquaman-coder hook <──stdio── Claude Code
                                          ▼
   ~/.aquaman/projects.yaml ─> match cwd ─> rewrite Bash cmd (updatedInput)
                                          ▼
                             aquaman-coder exec -- <cmd>
                                          ▼
              BrokerClient ─> /broker/resolve ─> vault ─> inject env, redact output
```

Key files in `packages/coder/src/`: `projects.ts` (projects.yaml resolver, longest-prefix match, realpath on both sides for macOS `/var` → `/private/var`), `broker-client.ts` (UDS client, typed `BrokerError` with the daemon's `code`), `adapters/claude-code/{hook,setup}.ts`, `cli/index.ts`.

A project maps paths to env vars keyed by `aquaman://service/key`. The hook rewrites `Bash` commands to run under `aquaman-coder exec --`, which resolves each ref, injects values into the subprocess only, and pipes output through the redactor. The redactor scrubs each injected value verbatim (any shape), then applies BUILTIN_PATTERNS for secrets the child surfaced itself. Those patterns do not yet cover GitLab token families, which Claude Code added first-party redaction for in 2.1.232.

### Claude Code hook contract (verified 2026-09-18 at 2.1.276)

- Supported and stable since 2.1.203: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext` for PreToolUse; `additionalContext` and `updatedToolOutput` for PostToolUse; exit 2 via stderr.
- There is no `PreToolUse.additionalEnvVars`. Earlier notes here claimed one; it appears nowhere in the docs, changelog or tracker. The only hook env mechanism is SessionStart's `CLAUDE_ENV_FILE`. Credentials must never transit hook output regardless.
- `updatedToolOutput` is adopted (v0.14.0): the redactor rewrites every tool's output before it reaches the transcript. `AQUAMAN_DISABLE_OUTPUT_REWRITE=1` degrades to warning-only. Caveats: a shape-mismatched output is ignored, and OTel spans record the pre-hook output, so redaction does not reach telemetry.
- Hook stdout must be schema-valid JSON: 2.1.214 fixed exit-2 not blocking on invalid JSON, and 2.1.248 made JSON-looking-but-invalid stdout a hook error. `test/unit/coder-hook.test.ts` pins this.
- Verify against the live docs when extending, not from memory.

### Claude Code sandbox

The sandbox denies every Unix-socket connect unless allowlisted, so a sandboxed `exec` cannot reach the broker by default (verified with `@anthropic-ai/sandbox-runtime` 0.0.76: default settings give `connect EPERM`; file-read rules never gate the connect).

- macOS: `sandbox.network.allowUnixSockets` takes exact paths or a parent directory, `~` expands, globs are ignored. `coder setup claude-code` adds exactly the socket, never a directory, never `allowAllUnixSockets`, and never touches `sandbox.enabled`.
- Linux/WSL2: the list is ignored (seccomp cannot filter by path), so only `allowAllUnixSockets: true` works, which opens every socket.
- `coder doctor` merges user, managed and project settings. `BrokerClient` maps EPERM/EACCES to a sandbox hint. Never recommend `excludedCommands`, which unsandboxes the whole wrapped command.
- Claude Code has its own `sandbox.credentials` substitution (2.1.214/2.1.221), scoped to sandboxed sessions, with no vault backends or per-read audit. Don't claim local Claude Code has no first-party credential isolation.

## Hermes integration

Hermes builds its own httpx client from `(api_mode, base_url, api_key)` and exposes no transport hook, so the integration is proxy-side: the loopback listener plus env vars Hermes already understands. The token arrives as the provider api_key (`x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI) or an explicit `x-aquaman-token`.

Path mapping (verified against Hermes `runtime_provider.py` / `anthropic_adapter.py`): Anthropic → `<origin>/anthropic` (the SDK appends `/v1/messages`); OpenAI → `<origin>/openai/v1` (the SDK appends `/chat/completions`, and the upstream has no `/v1`, so no doubling).

Proxy-side files: `daemon.ts` (second `http.Server`, `isLoopbackTokenValid()` constant-time, `/_health` exempt), `hermes/config-writer.ts` (idempotent `~/.hermes/.env` block, honors `HERMES_HOME`, emits `AQUAMAN_LOOPBACK_URL`/`_TOKEN`), `hermes/integration.ts`, `core/types.ts` (`LoopbackConfig`, env overrides for enabled/port/token but never host). `loadLoopbackOptions()` refuses to start an enabled-but-tokenless listener.

Operational notes: a root-owned managed `.env` (`/etc/hermes/.env`, relocatable with `HERMES_MANAGED_DIR`) overrides both `~/.hermes/.env` and shell exports, silently bypassing the proxy; `hermesManagedEnvPath()` and doctor detect it. `gateway.multiplex_profiles` scopes env per profile, so each profile needs the aquaman block.

### Secret source (v0.14.0+, Hermes ≥ 0.18.1)

The Python plugin registers an `aquaman` `SecretSource` through `ctx.register_secret_source()` (feature-detected with `hasattr`). Users bind `secrets.aquaman.env: { GITHUB_TOKEN: aquaman://github/token }` and the source resolves them at startup through the token-gated `/broker/resolve`.

- Two-tier rule, non-negotiable: LLM provider keys are refused by the source and by the proxy, so they stay process-isolated. Project secrets do materialize into Hermes' env, which is not process isolation, and the docs must keep saying so.
- Contract (api v1): `fetch()` never raises, never prompts, never writes `os.environ`; per-ref failures are warnings, proxy-down/timeout/auth failures are typed fatal errors, and Hermes always starts. No disk cache.
- `protected_env_vars()` covers the token var and wired placeholders. Every surfaced string is scrubbed of the token.
- v0.15.0: each bound ref must also be declared with `aquaman broker allow <ref>`. `aquaman hermes doctor` reads `$HERMES_HOME/config.yaml` and lists undeclared bindings.
- Env reads on the fetch path go through `_source_env()` because the orchestrator installs a per-fetch environment view under profile multiplexing.
- Hermes' own conformance kit is vendored at `packages/hermes/tests/_hermes_conformance.py`; CI runs it against the real host pinned by `HERMES_VERSION`. PyPI serves 0.19.0 only (0.20.x and later are GitHub tags), and `SECRET_SOURCE_API_VERSION` is still 1 as of 0.21.3.

## CLI shape

Run `aquaman --help` (and `aquaman <namespace> --help`) rather than duplicating the surface here. The shape: vault-level commands at the top, then `openclaw`, `coder` and `hermes` namespaces, with `setup`/`doctor`/`status` at every level (top-level is an overview, namespaced goes deep). Doctor exits 1 if any check fails.

Gotchas the help text doesn't tell you:

- `aquaman openclaw plugin-mode` and `aquaman coder hook` are hidden. They are spawned by the plugin and by Claude Code, never run by hand.
- `aquaman coder *` delegates to the separate `aquaman-coder` binary, so it can be missing while the rest of the CLI works.
- `--non-interactive` reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AQUAMAN_ENCRYPTION_PASSWORD`, `AQUAMAN_KEEPASS_PASSWORD`, `VAULT_ADDR`, `VAULT_TOKEN`, `BW_SESSION`.
- `aquaman openclaw setup` does far more than the vault wizard: plugin install, openclaw.json merge, SecretRef plus loopback wiring, optional credential migration.
- Errors carry fixes. A proxy 401 returns `{ error, fix: "Run: aquaman credentials add <service> <key>" }`; keep that convention when adding failure paths.

## Credential backends

Seven backends; the list and their trade-offs are in the root README, the internals in OPERATIONS.md. Setup auto-detects: macOS → keychain; Linux → keychain with libsecret, else systemd-creds (systemd ≥ 256), else encrypted-file.

Gotchas:

- `keepassxc` needs `npm i -g kdbxweb argon2`, which are optional peers rather than dependencies (see Dependency posture).
- `keepassxc`, `systemd-creds` and `encrypted-file` cache internally for the daemon's lifetime with no TTL, so a credential added while the daemon runs is invisible until restart.
- `CachingStore` (`core/credentials/caching-store.ts`) is a TTL'd in-memory decorator applied only in daemon contexts, because 1Password prompts biometrics per `op` spawn, Bitwarden spawns `bw`, and Vault does an HTTP round-trip. Default 900 s for `1password`/`bitwarden`/`vault`, off elsewhere; `credentials.cacheTtlSeconds` or `AQUAMAN_CACHE_TTL` overrides, `0` disables. No negative caching, write-through invalidation, errors never cached, memory only, audit stays per-request. Conformance: `test/compliance/cache-residency.test.ts`.
- For zero prompts with 1Password use `OP_SERVICE_ACCOUNT_TOKEN`; doctor prints the hint. `OP_CONNECT_HOST`/`OP_CONNECT_TOKEN` win if both are set.

## Dependency posture

A consumer's `npm audit` of our tarball is a published security signal: it is what flipped the ClawHub scan of 0.14.0 to `suspicious`.

- `kdbxweb` and `argon2` are optional **peer** deps of the proxy, not dependencies. `optionalDependencies` would not work (npm installs those); optional peers are the only form npm skips. Both are lazily imported.
- `openclaw` is an optional peer of the plugin, so `npm i aquaman-plugin` doesn't pull an 86 MB gateway into consumer trees.
- `undici` and `@sinclair/typebox` are exact-pinned in the plugin; Dependabot bumps them.
- The gateway is not in the lockfile (v0.15.0+). It was only the e2e harness, and 2026.7.33 ships a shrinkwrap pinning vulnerable transitives that root `overrides` cannot reach. CI installs it globally per lane and the e2e test calls `$OPENCLAW_BIN`. Never use `npx openclaw` there: with no local install it silently downloads `latest`. `packaging-posture.test.ts` fails if it comes back.
- Lockfile regeneration uses `--legacy-peer-deps`, pinned by the root `.npmrc`. Without it npm follows the optional peer edges and marks those subtrees `devOptional`, which `npm audit --omit=dev` keeps, so the shipped-deps gate audits the wrong tree. Whether Dependabot honors the `.npmrc` is not yet confirmed.
- npm ≥ 11.19 no longer runs install scripts unless allowlisted; `npm rebuild <pkg>` still does, which is what CI relies on for keytar.

## Development

```bash
npm test                          # everything, including test/compliance
npm run test:unit | test:e2e
npm run build | typecheck | lint
npx vitest run test/compliance/   # ATLAS + NIST conformance suite
```

A vitest globalSetup (`test/helpers/ensure-build.ts`) builds missing package dists and restores the exec bit on bin entrypoints, because several e2e tests spawn a CLI from source or via the installed bin and those child processes don't get vitest's aliases.

Compliance tests are source-repo only, never shipped, and named for the control they exercise: MITRE ATLAS v5.4.0 (T0055, T0012, T0062, T0090, T0098) and NIST SP 800-53 Rev 5 (IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10). Mapping docs live in `docs/compliance/`. CISA/Five-Eyes, CSA MAESTRO and OWASP Agentic Top 10 are alignment narratives.

Manual smoke recipes (install paths, all auth modes, policy denials, real-gateway checks, publish pipeline) live in OPERATIONS.md. Run them against isolated `HOME`/`AQUAMAN_CONFIG_DIR` dirs: several would otherwise overwrite your real Keychain entries or config.

## Files to know

| File | Purpose |
|---|---|
| `packages/proxy/src/daemon.ts` | Both listeners, auth modes, broker endpoint |
| `packages/proxy/src/broker-scope.ts` | Declared-ref scope for the broker |
| `packages/proxy/src/request-policy.ts` | Method + path policy, presets, `lintPolicyConfig` |
| `packages/proxy/src/service-registry.ts` | 25 builtin services, host map |
| `packages/proxy/src/cli/index.ts` | The whole CLI |
| `packages/proxy/src/core/credentials/` | Backends, `store.ts`, `caching-store.ts` |
| `packages/proxy/src/core/audit/logger.ts` | Hash-chained audit log |
| `packages/proxy/src/openclaw/secretref.ts` | SecretRef + loopback baseUrl wiring |
| `packages/proxy/src/openclaw/integration.ts` | Version gates, detection, launch |
| `packages/proxy/src/hermes/config-writer.ts` | `~/.hermes/.env` block, managed-scope detection |
| `packages/plugin/index.ts` | Plugin entry the Gateway loads |
| `packages/plugin/openclaw.plugin.json` | Manifest (allowlisted keys) |
| `packages/plugin/secrets-resolver.mjs` | SecretRef exec resolver |
| `packages/plugin/src/proxy-manager.ts` | Spawns the proxy, parses its ready line |
| `packages/coder/src/broker-client.ts` | UDS broker client, typed errors |
| `packages/coder/src/adapters/claude-code/` | Hook protocol + settings writer |
| `packages/hermes/aquaman_hermes/plugin.py` | Python plugin: status surface + secret source |

Tests mirror these names under `test/unit`, `test/e2e` and `test/compliance`.

## Design principles

Credentials never in agent memory. Tamper-evident audit for every use. Bring your own vault. Follow each host's native patterns rather than fighting them.

## Maintainer resources

Two gitignored companions: **OPERATIONS.md** (runbook: release procedure, smoke recipes, scanner patterns, publish pipeline) and **ROADMAP.md** (planning, competitive research, in-flight investigations, release history). New maintainers should ask for both. Neither holds secrets.
