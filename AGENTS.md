# AGENTS.md

## What this is

Credential isolation for AI agents. API keys, channel tokens and `.env`-grade secrets never enter the agent's process. They live in a vault backend (Keychain, 1Password, HashiCorp Vault, Bitwarden, Keeper, KeePassXC, encrypted-file, systemd-creds) and a separate proxy injects them at egress. A compromised agent holds a marker, not a key.

Four integration paths:

1. **OpenClaw Gateway** (`aquaman-plugin`, npm + ClawHub). LLM providers and channel credentials, 27 builtin services across 6 auth modes.
2. **Coding agents** (`aquaman-coder`, v0.12.0+, npm). Claude Code, and Codex since v0.16.0. Per-tool-call materialization through `/broker/resolve`.
3. **Hermes** (`aquaman-hermes`, v0.13.0+, PyPI). A Python host with no transport hook, so isolation is proxy-side: a token-gated loopback listener plus (v0.14.0+) an `aquaman` secret source for project secrets.
4. **NVIDIA OpenShell** (v0.17.0+, no extra package). `aquaman daemon` serves OpenShell's external credential driver protocol; OpenShell isolates, aquaman sources, scopes and audits.

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
   - `sigv4`: the proxy signs the request with AWS Signature Version 4 (the `aws` builtin; see "AWS requests")
   - `none`: at-rest storage only, traffic rejected (Nostr, Tlon)
5. Forward upstream, append a hash-chained audit entry, pipe the response back.

The audit entry gates what is handed out. `/broker/resolve` (so `aquaman get` and `aquaman-coder exec`) and the OpenShell driver's Resolve write the entry first and refuse with `audit_unavailable` and a fix if the write fails. A forwarded request has already gone upstream by the time its outcome is known, so there the response is withheld (500 `audit_unavailable`) rather than the request. Refusals and errors hand nothing out and stand even when their own entry cannot be written. An audit failure is printed as `AUDIT FAILURE: ...` on stderr and never takes the daemon down: `onRequest` must return the logger's promise, and `recordRequest()` in `daemon.ts` is the only caller. Conformance: `test/compliance/audit-fail-closed.test.ts`.

The request target is read once, by `parseRequestTarget()` in `packages/proxy/src/request-target.ts`, and that one reading supplies the service name, the path policy sees and the path sent upstream. It refuses (400) anything two parsers could read differently: backslashes, `.`/`..` segments in any encoding, encoded backslashes and control characters, double-encoded separators, malformed escapes, fragments. The query is split off and never part of policy matching. Rules for anyone touching this path:

- Never build the upstream URL with `new URL(clientPath, upstream)`. A client path that parses as scheme-relative (`//host`, or `/\host`, since WHATWG URL treats `\` as `/`) replaces the host, and the injected credential goes with it. The daemon sets `pathname` and `search` on the upstream origin and checks the origin did not change.
- Policy is evaluated over every reading of the request the proxy knows an upstream might apply: `policyPathInterpretations()` adds the path as seen by a server that decodes `%2F` or drops `;params`; `policyPathOverrides()` adds a path named by `X-Original-URL` or `X-Rewrite-URL` (one the parser refuses denies the request for a service that has rules); `policyMethods()` adds every method named by `X-HTTP-Method-Override`, `X-Method-Override`, `X-HTTP-Method` (a comma-separated value and a repeated header count as several) or a `_method` query parameter. One denied combination denies the request.
- A deny rule matches its path without regard to case; an allow rule matches exactly. Lower-casing a reading for allow rules would deny paths a default-deny policy legitimately allows (`/sendMessage`), so the folding lives in `matchPolicy()`, on deny rules only.
- Not covered, and written as `it.fails` rows so they are visible: a segment with a trailing dot or space, Unicode compatibility forms, and a `_method` field in a request body (the body is streamed, not read).
- The proxy does not follow upstream redirects; the client gets the 3xx.
- Conformance: `test/compliance/request-target-integrity.test.ts` sends raw bytes to a real proxy with a second upstream standing in for an attacker's host, and `test/compliance/policy-evasion.test.ts` attacks one deny rule with every spelling, one table row each. Add a row for any new way of spelling a path or a method.

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
- Everything else stays at-rest only (vault storage plus `aquaman openclaw migrate`). Matrix, Mattermost and Nextcloud Talk already point at the user's own server. `aquaman openclaw doctor` lists the rest as not routed rather than implying coverage.
- Discord is not routed, but not because the host lacks an override (earlier notes here said it had none). OpenClaw reads `DISCORD_API_URL` (openclaw#118067; in the 2026.9.37 and 2026.11.3 bundles and `docs/channels/discord.md`, absent in 2026.6.10): a process-wide env var, not config, that also moves Gateway discovery, the WebSocket, media, webhooks and OAuth to that origin, accepts plain HTTP/WS on loopback, and disables voice. Routing through it means proxying the Discord WebSocket, which the proxy does not do. Untested; a feature of its own if it is ever built. Slack is reported to read `SLACK_API_URL`; not found in the 2026.11.3 core bundle (the Slack channel ships separately), so treat that as unverified.

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
- CI lanes: 2026.10.33 (the `extended-stable` dist-tag) and 2026.11.5 (`latest`). OpenClaw supports one extended-stable line at a time, so 2026.7.33 and 2026.9.37 are retired. CI still installs `@openclaw/ai` alongside when a shrinkwrap omits it (openclaw#151657, seen on 2026.7.33). Both lines declare Node ≥ 24.16.
- 2026.6.10 is still 73% of OpenClaw's npm downloads (2026-11-14) and is not a CI lane; the plugin e2e suite passed against it (35/35) when run by hand for v0.17.1.

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

Key files in `packages/coder/src/`: `projects.ts` (projects.yaml resolver, longest-prefix match, realpath on both sides for macOS `/var` → `/private/var`), `broker-client.ts` (UDS client, typed `BrokerError` with the daemon's `code`), `adapters/claude-code/{hook,setup}.ts`, `adapters/codex/{hook,setup}.ts`, `cli/index.ts`.

A project maps paths to env vars keyed by `aquaman://service/key`. The hook rewrites `Bash` commands to run under `aquaman-coder exec --`, which resolves each ref, injects values into the subprocess only, and pipes output through the redactor. The redactor scrubs each injected value verbatim (any shape), then applies BUILTIN_PATTERNS for secrets the child surfaced itself. Output is redacted as a stream (`createStreamRedactor()`), which holds back the end of the text while it could still be the start of an injected value, and the unfinished last line, so a value split across two chunks is still caught; redacting chunk by chunk would let both halves through. A finished line that does not end like the start of a value is written at once: that is what lets a stdio MCP server run under `exec` (`test/e2e/exec-stdio-server.test.ts`; run live in Claude Code 2.1.330), so do not go back to holding a fixed number of characters. `exec` passes SIGTERM, SIGINT and SIGHUP on to the command. It does not catch a value the command deliberately transforms (base64, reversed, one character per line): the wrapped command holds the real value, so redaction guards against accidents, not against the command itself. They cover the GitLab `glpat-`, `glrt-` and `gloas-` families (v0.16.0), matching Claude Code 2.1.232's first-party redaction.

### Claude Code hook contract (verified live 2026-11-14 at 2.1.325)

- Supported and stable since 2.1.203: `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext` for PreToolUse; `additionalContext` and `updatedToolOutput` for PostToolUse; exit 2 via stderr.
- There is no `PreToolUse.additionalEnvVars`. Earlier notes here claimed one; it appears nowhere in the docs, changelog or tracker. The only hook env mechanism is SessionStart's `CLAUDE_ENV_FILE`. Credentials must never transit hook output regardless.
- `updatedToolOutput` is adopted (v0.14.0): the redactor rewrites every tool's output before it reaches the transcript. `AQUAMAN_DISABLE_OUTPUT_REWRITE=1` degrades to warning-only. Caveats: a shape-mismatched output is ignored, and OTel spans record the pre-hook output, so redaction does not reach telemetry.
- Hook stdout must be schema-valid JSON: 2.1.214 fixed exit-2 not blocking on invalid JSON, and 2.1.248 made JSON-looking-but-invalid stdout a hook error. `test/unit/coder-hook.test.ts` pins this.
- **Permission rules see the rewritten command (2.1.290+).** Rules are matched against the input the hook returns, and a Bash rule never looks inside `sh -c '...'`. A bare wrapper therefore hid the real command from every `deny` and `ask` rule while the hook answered `allow`: verified live on 2.1.325, a denied command ran inside an aquaman project (v0.17.0 and earlier). The rewrite now ends with `exit` and then the original command on its own lines (`withPermissionTail()` in `hook.ts`). Claude Code splits the text into subcommands and applies its own matcher to the original, from every rule source; the shell stops at `exit`, with the wrapper's status. Use a bare `exit`, not `exit $?`: a variable makes Claude Code refuse to pre-check the command when a rule asks. Codex rewrites do not get the tail.
- The hook still answers `allow` for a command it wraps, so in an aquaman project a Bash command that no deny or ask rule matches runs without a prompt. That predates this note and is a design question, not a bug fix; see ROADMAP.
- 2.1.300 validates `updatedInput` like native input (unknown keys dropped, rejected input denies the call). The hook spreads `tool_input` and replaces `command`, which passes.
- `onFailure: "block"` (2.1.295+) makes a hook that cannot start, times out or prints invalid JSON block the call; unset, the call goes ahead. `coder setup claude-code --fail-closed` sets it on the PreToolUse handler only (PostToolUse runs after the tool, so blocking there withholds nothing). Opt-in, because with it an uninstalled `aquaman` blocks every tool call, and a hook that fails open runs the command without credentials rather than leaking any. The hook's own errors already exit 2.
- Monitor-tool commands (2.1.314+): with our `*` matcher the hook receives the Monitor call's own input (`tool_name: "Monitor"`), which the handler ignores, so they run unwrapped and without credentials.
- Verify against the live docs when extending, not from memory.

### Codex hook contract (verified 2026-09-23 against openai/codex main)

- Hooks are `Stage::Stable`, default on, in `$CODEX_HOME/hooks.json` (`{"hooks":{...}}`, unknown fields rejected) or an inline `[hooks]` table. The shell tool reports `tool_name: "Bash"`, `tool_input: {command}`.
- A rewrite is `permissionDecision: "allow"` plus `updatedInput.command`; only `command` is read. Invalid output fails OPEN (the unwrapped command runs), so the Codex handler strips everything else, including `additionalContext`.
- New or changed user hooks are skipped until trusted in the startup review (`[hooks.state."<path>:pre_tool_use:<g>:<h>"] trusted_hash` in config.toml). Setup does not write that entry; doctor reports it.
- PostToolUse has no shell output rewrite (`updatedMCPToolOutput` is rejected), so the Codex handler only warns. `continue:false` + `reason` replaces model-visible output but was not verified end to end; do not adopt it without a live check.
- The rewritten command runs in Codex's sandbox. Verified with `codex sandbox` on macOS by connecting to a real socket under each config:
  - 0.169.0 (2026-11-14): default is `EPERM`. Only a `default_permissions` profile with `network.enabled = true` reaches the socket, and `enabled` alone is enough: it opens every Unix socket (a `unix_sockets` entry is not consulted, not even `"deny"`) and outbound HTTPS. `unix_sockets` alone stays `EPERM`. A `[permissions]` table without `default_permissions` is a config error. `codex sandbox` no longer evaluates legacy `sandbox_mode`, so `network_access = true` and `danger-full-access` could not be re-verified.
  - 0.156.1 (2026-09-23): `network.enabled = true` needed the socket listed too, and `sandbox_workspace_write.network_access = true` reached it.
  - `codexSandboxStatus()` (`adapters/codex/setup.ts`) reads `config.toml` with `smol-toml` and `coder doctor` reports it: anything it cannot read, parse or recognise fails rather than passing. It sees the file only, not `-c`, `-p` or `--permission-profile`.
  - Hook trust and a full model-driven loop are still not verified live.

### Claude Code sandbox

The sandbox denies every Unix-socket connect unless allowlisted, so a sandboxed `exec` cannot reach the broker by default (verified with `@anthropic-ai/sandbox-runtime` 0.0.76: default settings give `connect EPERM`; file-read rules never gate the connect).

- macOS: `sandbox.network.allowUnixSockets` takes exact paths or a parent directory, `~` expands, globs are ignored. `coder setup claude-code` adds exactly the socket, never a directory, never `allowAllUnixSockets`, and never touches `sandbox.enabled`.
- Linux/WSL2: the list is ignored (seccomp cannot filter by path), so only `allowAllUnixSockets: true` works, which opens every socket.
- `coder doctor` merges user, managed and project settings. `BrokerClient` maps EPERM/EACCES to a sandbox hint. Never recommend `excludedCommands`, which unsandboxes the whole wrapped command.
- Claude Code has its own `sandbox.credentials` substitution (2.1.214/2.1.221), scoped to sandboxed sessions, with no vault backends or per-read audit. Don't claim local Claude Code has no first-party credential isolation.

### Agent-run setup and credential requests

Two commands exist so an agent can set aquaman up and obtain credentials without a person typing in a terminal and without the agent handling a secret. Both print JSON with `--json`; the contract is `docs/agent-setup.md`.

- `aquaman init --agent claude-code|codex` (proxy CLI, `initForAgent()`): creates the config with the auto-detected backend if there is none, starts the daemon detached if it is not running, then delegates to `aquaman-coder init`, which registers the current directory as a project, installs the hooks, installs the `aquaman-credentials` skill and writes a marked block into `CLAUDE.md` or `AGENTS.md` (`packages/coder/src/agent-setup.ts`). Never prompts, never takes a secret, safe to repeat. Things only a person can do come back in `human_steps`.
- `--no-hooks` on either `init` installs no hook and writes nothing to the host's settings. `init` reports `mode: exec` and the agent runs commands that need credentials as `aquaman-coder exec -- <command>`; the instructions block is the exec variant (`agentsBlock('exec')`) and the skill, which is user-level and shared by projects in both modes, explains both. Hooks already installed are user-level and keep wrapping, so the run reports `mode: hook` and leaves them. This is the form the docs tell an agent to use unprompted: no host setting and no permission prompt changes. It gives up PostToolUse redaction of other tools' output and the sandbox socket allowlist entry.
- **Routing the agent's app through the proxy (`--via-proxy`).** `aquaman-coder bind NAME=ref --via-proxy URL_ENV [--base-path /v1]` (and `aquaman request ... --via-proxy`) records `routes.NAME = { url_env, base_path }` beside the env map in `projects.yaml`. For a routed binding `exec` calls `POST /broker/route` instead of `/broker/resolve`: `NAME` gets the route token, `URL_ENV` gets `http://127.0.0.1:<port>/<service><base_path>`, and the credential value is never fetched into `exec` or the command. Rules, each of which closes something a review reproduced:
  - **The route token is not the loopback token.** It is made per daemon start (`aqm_rt_`, memory only) and accepted on the loopback listener only for forwarding to a routed service. Every `/broker/*` and `/_*` path answers it 401 or 404. Handing a program the Hermes/OpenClaw loopback token would let it call `/broker/resolve` and read the key it was being kept from, plus every other declared ref.
  - **A ref bound only through the proxy is not declared for materialization.** `loadProjectRefs` puts it in `routedRefs`, not `refs`, so `/broker/resolve` refuses it on both listeners (`aquaman get` too). `/broker/available` still counts it, over the socket, so the hook wraps. `POST /broker/request` with `routed: true` stores the value and never adds the ref to `broker.allowedRefs`.
  - **A route opens forwarding for the route token only.** `isServiceRouted()` requires `authMode: header`, `basic` or `sigv4` and the routed ref to be a key a program presents the route token in place of (`routableKeys()` in `route-auth.ts`: `credentialKey`, and for basic also `additionalCredentialKeys[0]`; for sigv4 the access key id only). url-path, oauth and none stay unroutable. The loopback token and the Unix socket still forward only for `credentials.proxiedServices`; a `routes` line must never widen what agent hosts can reach.
  - `/broker/route`: Unix socket only, off without a broker scope, routed-ref check first (so a refusal says nothing about the vault or registry), then listener, definition, auth mode, key, vault (every key the proxy injects must be stored, so both halves of a basic pair, and for sigv4 the secret access key: `routeRequiredKeys()`). Returns `{ url, token }`, plus `env` for sigv4 (variables the program also needs, none of them a stored value), never a value; a success is audited. `exec` sets what `env` names except loader variables, names the project binds and the `url_env` of any route.
  - The route token is accepted in `Authorization` (`Bearer` or `token`, which Octokit sends), `x-api-key`, `x-aquaman-token` and the service's own auth header, and for a routed basic service as either half of an inbound `Authorization: Basic` (read strictly by `parseBasicAuthorization()`; the loopback token is never accepted there). No header carrying either local token, plain or inside a Basic value, is forwarded upstream. A token base64-encoded into a header without the `Basic` scheme is not recognised (an `it.fails` row in `test/compliance/app-route-basic.test.ts`).
  - The loopback listener refuses a `Host` that is not `127.0.0.1`, `localhost` or `[::1]` (DNS rebinding), and `loadLoopbackOptions` refuses to bind a non-loopback host. Tokenless `/_health` still reports version and services because the Hermes plugin reads them.
  - `init --agent --loopback` edits the raw config by temp file and rename at 0600, and only after every reason to refuse has been checked (a proxy it cannot restart, an encrypted-file password that is missing or too short), so a run that stops with an error leaves the listener and the file as it found them. It checks the password before stopping anything, and signals a pid only when the proxy on the socket reports that pid in `/_health` (socket only). It is never on by default.
  - `url_env` and new binding names cannot be loader variables (`PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, proxies: `isLoaderEnvName()`); `ROUTE_BASE_PATH` refuses dot segments.
  - Conformance: `test/compliance/app-route.test.ts`. Stripe is a builtin since this change; the plugin's own host list is not extended.
- **`aquaman-coder exec --raw` needs a terminal on stdout.** With `--no-hooks` the agent composes the `exec` command itself, and unredacted output captured by a shell tool is the value in the transcript. In exec mode the user's deny and ask rules also do not see the command behind the prefix (there is no hook to add the permission tail); the docs and the skill say so and tell the agent not to use the prefix around a rule.
- `aquaman request <ref> [--env NAME]` posts to `POST /broker/request` on the daemon. The daemon, not the CLI, shows the dialog (`packages/proxy/src/credential-prompt.ts`: `/usr/bin/osascript` on macOS, `zenity` on Linux with a desktop session, both by absolute path with a fixed environment and the message passed as an argument, never as script text). The value goes from the dialog into the vault and the ref is added to `broker.allowedRefs`. Statuses: `ready`, `stored`, `approved`, `declined`, `pending`; exit codes 0, 0, 0, 2, 3, 4 when the daemon cannot take the request, and 1 for a wrong command. The dialog waits 90 seconds by default (`--timeout`, clamped to 10-600 by the daemon), which is under the two minutes Claude Code allows a Bash call.
- Rules for the endpoint: it never returns a value and never replaces a stored one (checked again after the dialog closes); Unix socket only; off without a broker scope, so OpenClaw-hosted proxies answer `broker_disabled`; one dialog at a time, at most six per ten minutes, and a declined ref is not asked about again for ten minutes; every dialog outcome is audited (`rotate`; a `ready` answer and 4xx refusals are not). A `declined` reply carries no `fix`: a command that completes what the person refused must not be handed back.
- The dialog says what a caller can obtain once the person agrees, and it differs by request (`CONSEQUENCE` in `credential-prompt.ts`): an ordinary request ends with the ref declared, so the dialog says commands in the project are given the value and other software running as the user can ask for it; a `routed: true` request ends with the value stored and not declared, so it says the app gets a local token and the proxy adds the key. Never write a sentence there that is false for the case it is shown in. Conformance: `test/compliance/owasp-agentic/asi09-human-in-the-loop.test.ts` compares each dialog with what `/broker/resolve` then does.
- The dialog is where a person decides, and the caller chooses the ref and the `project` string. `displayText()` reduces caller text to one bounded line (control and format characters, bidi overrides, U+2028/2029 and backslashes removed), service and key are capped at 64 characters, and the reported lines come last, after aquaman's own wording (the vault item of a link request, shown whole, then the project). Do not move caller text above the fixed sentences. zenity 3.44 (checked in a container): `--entry` swallows a single `_` and turns `\n` into a newline, so entry text doubles underscores; `--question --no-markup` shows both literally.
- The hook wraps and answers `allow` only when `POST /broker/available` says at least one of the project's refs would resolve; otherwise it returns context only and the command runs under the host's own permissions. Without that check, `init` plus a made-up binding switched permission prompts off. If the proxy cannot answer the question the hook wraps, and `exec` refuses to run a command for which nothing resolved. `/broker/available` returns booleans, scope before vault, never a value.
- `aquaman-coder init` refuses the home directory or an ancestor of it as a project, and the instructions block and skill are never written through a symlink.
- `--env` binds through `aquaman-coder bind`, which never creates a project: outside a registered one it fails, and `request` runs `bind --check` before posting so no dialog is shown for a request that cannot finish. A project made from wherever the command happened to run (a home directory, say) would hand the value to everything beneath it.
- When the daemon is unreachable the hook returns `null`, instead of `deny`, for a command whose first word is `aquaman` or `aquaman-coder` (`isAquamanCommand()`). Otherwise a stopped daemon would deny the command that starts it. Only then: while the daemon is up those commands are wrapped like any other, so `aquaman get <bound ref>` output stays under value redaction. `init --agent` is the restart an agent can use; `aquaman daemon` is foreground. Without the login item (`aquaman service install`, below) the daemon is gone after a reboot.
- With the `encrypted-file` backend `init --agent` checks the vault password before starting the daemon and returns the person's step instead of a generic start failure.
- The guide is `docs/agent-setup.md`, not `docs/agents.md`: on a case-insensitive filesystem that name is read as a nested `AGENTS.md` and loaded as project instructions by agent hosts.
- It is not a boundary against same-user software, which can already edit `projects.yaml` and `config.yaml`. Say so wherever it is documented.
- Skill locations, verified 2026-11-16: Claude Code reads `~/.claude/skills/<name>/SKILL.md`; Codex 0.169 reads `~/.agents/skills/<name>/SKILL.md` and requires `name` (64 characters at most) and `description` in the frontmatter.
- Do not add an environment variable or flag that replaces the prompter: the daemon may have been started by the agent, and such a switch would let the agent answer its own request.
- Conformance: `test/compliance/credential-request.test.ts` (scripted prompter), `test/e2e/cli-agent-init.test.ts`. The real dialogs were exercised by hand with a one-second timeout.

## AWS requests (`authMode: sigv4`, v0.21.0+)

A program routed to the builtin `aws` service signs with the route token as its access key id and a fixed placeholder as its secret. The proxy reads the region and the signing name from that `Authorization` header, drops the signature, and signs the request it sends with `aws/access_key_id`, `aws/secret_access_key` and, when stored, `aws/session_token`. Files: `sigv4.ts` (pure, Node `crypto` only: strict header reader, host, canonical forms, signer), `forwardSigV4()` in `daemon.ts`, `routableKeys()` and `routeRequiredKeys()` in `route-auth.ts`. Guide: `docs/aws.md`.

- **The host is built, never taken.** `resolveSigV4Target()` assembles `<service>.<region>.amazonaws.com` from labels that each matched `[a-z0-9-]`; the region must also have the shape of a region code, and regions of other partitions (`cn-`, `us-iso`) are refused. `/aws/_host/<prefix>` puts one label in place of the service (an endpoint whose name is not its signing name), `/aws/_global` drops the region and signs for `us-east-1`. The suffix is a constant. Never build the host from a client string, and never with `new URL(clientPath, upstream)`.
- **The `_host` prefix is one label.** `<bucket>.s3` would address a bucket by its virtual-hosted name with the bucket gone from the path, and a policy rule on `/<bucket>/**` would no longer see it. Do not allow more labels without an answer for policy.
- The builtin's `upstream` is the suffix only. `override()` in tests moves the connection to a stand-in; the Host header and the signature still name the AWS host. `sigv4` is refused in `services.yaml` and `register()`.
- **Nothing of the client's signature is kept.** `Authorization`, `X-Amz-Date`, `X-Amz-Security-Token`, `X-Amz-Content-Sha256`, `Host` and hop-by-hop headers are dropped (`isSigV4StrippedHeader()`), as is any header carrying a local token or the placeholder. The date is the proxy's clock and the body hash is computed from the bytes that are sent. The URL is forwarded as sent, so one that carries a local token or the placeholder is refused. Signed: `host`, every `x-amz-*` header, `content-type`, `content-md5`. The Host header is always signed, which is what makes a signature useless at another host.
- **The route token is read from the access key id of a strictly parsed header** (`parseSigV4Authorization()`: exact algorithm, one credential, four scope fields, nothing before or after), and only for a sigv4 service. The loopback token is never accepted there. A SigV4A header is read for its access key id alone, so a routed client is told `sigv4a_unsupported` and not that it has no token.
- **Refuse, never forward half-signed.** Chunk-signed bodies (`STREAMING-AWS4-*`), query-string authentication, SigV4A, a `+` in the query, a doubled slash. Each refusal has `error`, `code` and `fix`, is audited, and happens before any vault read. The body is read (up to `SIGV4_MAX_BUFFERED_BODY`, 16 MiB) before the vault as well. `UNSIGNED-PAYLOAD` and `STREAMING-UNSIGNED-PAYLOAD-TRAILER` are kept for signing name `s3` only, and the body is then streamed.
- Do not answer a refusal with `Connection: close` while the request body is still arriving: Node closes the socket with unread input, the kernel resets it, and the client never sees the answer. The 413 path reads and drops what is left for two seconds.
- Path: `parseRequestTarget()` drops empty segments, so `forwardSigV4()` puts the trailing slash back (it is part of what AWS routes on and of what is signed) and refuses `//`. For S3 the path is sent in the one encoding S3 signs (`sigV4WireSegments()`); other services get the segments as sent and the canonical URI encodes them again. The query is forwarded verbatim.
- **Policy matches the path AWS receives**: `sigV4RoutingSegmentCount()` removes the host selectors before `matchPolicy()`, so a rule holds whichever way the host was chosen. Policy does not see `X-Amz-Target`, the body or the AWS service; both are `it.fails` rows. Never write that it does.
- Routing: only `aws/access_key_id` is routable (a token in the secret would never reach the proxy). `/broker/route` answers `env` from `sigV4RouteEnv()`: the placeholder secret, `AWS_ENDPOINT_URL_IAM` and `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`. The listener is HTTP/1.1; the SDK for JavaScript's Bedrock Runtime client defaults to HTTP/2 and needs `NodeHttpHandler`.
- Limits, each an `it.fails` row: a token base64-encoded into a header without the `Basic` scheme, a token in the request body, an action named in `X-Amz-Target`, and a path rule not telling services apart.
- Nothing has been run against AWS. The stand-in (`test/helpers/aws-stand-in.ts`) signs each received request again with `@smithy/signature-v4` and the stored secret and applies AWS's documented rules; public text says what the tests do and makes no claim about AWS itself. A child-process daemon cannot be pointed at a stand-in (builtins cannot be overridden), so a test never sends it a request it would forward.
- Conformance: `test/compliance/app-route-sigv4.test.ts` (one row per attack), `test/unit/sigv4.test.ts` (AWS's published test-suite vectors under `test/fixtures/aws-sig-v4-test-suite`, copied unchanged from awslabs/aws-c-auth; never edit one to fit the code), `test/e2e/approute-aws-sdk.test.ts` (AWS SDK for JavaScript v3 clients through `bind` and `exec`).

## Links to existing vault items

`credentials.links` in `config.yaml` maps `"<service>/<key>"` to a locator of an item that already exists in the configured vault, so a person does not retype a secret. Files: `core/credentials/links.ts` (locator parser, reading and writing the map), `core/credentials/linked-store.ts` (`LinkedStore`, `createCredentialLinker`), `link-request.ts`, `cli/links.ts`.

- One scheme per backend, and a link is valid only for the configured backend: `op://`, `bw://`, `vault://` (KV v2), `keychain://`, `keepassxc://`, `keeper://`. `encrypted-file` and `systemd-creds` take none. The parser is strict (200 characters, no control or format characters, no part starting with `-`, no `.`/`..`, decoded once, and an escape only for `/`, `#`, `?` and `%`, so a name cannot be spelled in a way that reads as something else); a locator in a request (`from`) is printable ASCII only, because the person decides by reading it; locator parts reach vendor CLIs as separate argv entries or URL segments, never through a shell.
- aquaman only reads a linked item. `set` and `delete` through a link are refused, a link never replaces a stored value and a stored value never replaces a link, a link cannot be re-pointed (unlink first), and a link cannot name an item aquaman wrote itself or the reserved service.
- Decorator order is `CachingStore(LinkedStore(backend))`. `storeOptionsFromConfig` sets `links: 'always'` for serving processes so a link made later reaches a running daemon; the map is re-read when `config.yaml` changes, and a value cached through a link is good only until the file changes (`linkStamp()` carries the locator and a counter of config changes), so a link removed and written back is checked against the vault again. `caching-store.ts` keeps exactly one import (`cache-residency.test.ts` asserts it).
- Creating a link is a person's decision, because it makes aquaman read an item it did not write, and the decision is taken in the daemon's dialog. A terminal is not proof of a person: a program can give itself one. `POST /broker/request` with `from` shows an approval dialog that names the item and answers `linked`. `aquaman request <ref> --from <locator>` links and declares. `aquaman credentials link <ref> <locator>` posts the same request with `declare: false` (link-only: linked, not declared, dialog wording `CONSEQUENCE.link.only`, used only when the reference is not already declared; `ready` when the link is already in place and approved) and exits 0 linked, 2 declined, 3 nobody answered or rate limited, 1 refused or daemon not running. Only when the daemon answers `pending` with `code: 'prompt_unavailable'` (its prompter cannot show a dialog) does the command ask for a typed `yes` at a terminal and then call `establish()` itself; without a terminal it fails with a fix. Do not add another way to reach that fallback.
- **A link is honoured only with an approval in the vault.** `LinkApprovals` (`linked-store.ts`) keeps `{ v: 1, links: { "<service>/<key>": "<locator>" } }` at `aquaman_internal/link_approvals` (`reserved.ts`). `LinkedStore` reads a linked reference only if the record has exactly that name and locator; otherwise `get` throws with the fix and `exists` is false, so a link written into `config.yaml` by hand reads nothing and a request for it is asked about like a new link. `establish()` writes the approval first, then the link; `remove()` and `credentials unlink` remove both. `CredentialStore` has optional `approveLink`, `revokeLink`, `linkApproved`, passed through by `CachingStore`. An approval seen once is answered from memory; the record is read again when memory has no match and whenever `config.yaml` changes, so a link removed by another process and written back by hand is not read on the old approval. A malformed record approves nothing.
- Before the person agrees only the locator's syntax, the link map and, for a link already in the file, aquaman's own approval record are looked at, never an item, so a request cannot be used to learn which items exist; the stored-value check and the first read happen after approval (`establish()`), and those refusals are audited. A routed request is not declared, as without `from`. The dialog's routed wording ("a local token, not the key") is used only when the reference is not already declared some other way (`keptFromCallers` in the request handler); otherwise the value is handed out and the dialog says so, for links and for ordinary requests alike. A serving process writes an audit entry when a link appears, changes or goes away while it runs (`onLinkChange`), whoever edited the file; a link made while no process is serving is not recorded.
- Everything above the store (broker scope, policy, injection, OpenShell reference mode, audit) is unchanged: a linked but undeclared ref is not resolvable.
- Limits: software that can write to the vault itself (the vault's own CLI or API) can write the approval record (`it.fails` row); on a machine where no dialog can be shown the typed `yes` at a terminal is the only check, and a program can give itself a terminal; a value already in the daemon's `CachingStore` is served until its TTL if the link is removed by another process and written back by hand before the next use, though the item is not read again (`it.fails` row); a locator in plain ASCII can still carry words meant to persuade (shown on the caller's own line); a locator that goes to the dialog is printable ASCII only, so an item with another name is linked by its ID; aliasing an aquaman-written item is not caught for a 1Password item addressed by ID or for Keeper; linked reads were tested against stand-ins (mocked `op`, `bw`, keytar, `fake-keeper.mjs`, `test/helpers/fake-vault.ts`, a generated KeePassXC database), not live accounts.
- `VaultStore` normalises its mount path (no empty parts), so the check that refuses a link to an aquaman-written item, the anchor included, cannot be sidestepped by a trailing slash in the config.
- Conformance: `test/compliance/vault-links.test.ts`. Add a row per new locator spelling in `test/unit/links-locator.test.ts`. A test never sends `POST /broker/request` (or `credentials link`, `request --from`) to a child-process daemon: on macOS that daemon shows a real dialog. The dialog path is tested in-process with a scripted prompter, and the CLI against a server the test owns on the proxy socket (`fakeProxy`); a child daemon is used only for what it does without asking (`aquaman get`), with the link made in the test process through `establish()`.

## Ask first

A reference can be marked "ask first": the daemon hands its value out only after a person allowed it in the daemon's dialog, and remembers a yes for a window. Opt-in per reference; a reference that is not marked is served as before. Files: `ask-first.ts` (`AskFirstMarks`, `AskFirstGate`, `handleAskFirst`), `credential-prompt.ts` (the wording), `cli/ask-first.ts`.

- **The mark is a record in the vault**, `{ v: 1, refs: ["<service>/<key>"] }` at `aquaman_internal/ask_first` (`ASK_FIRST_KEY` in `reserved.ts`), so editing `config.yaml` or `projects.yaml` cannot remove it. The daemon reads it at its first resolve and answers from memory after that, because a read costs a prompt or a process on some backends and misses are not cached. It reads again after a change made through it and after `POST /broker/ask-first { reload: true }`. A vault that cannot be read is a 500 and no value.
- **A record that is there and cannot be read as one marks every reference.** Fail closed means "ask", not "refuse": the person is still in front of each read and can still say yes, and a damaged record never switches the dialog off. `mark()` writes nothing over such a record (a list would unmark the rest). An approved `unmark()` writes it again with every declared reference still marked except the one the person agreed about.
- **Setting a mark tightens, so no one is asked.** `aquaman broker ask <ref>`, `broker allow <ref> --ask` and `request <ref> --ask` go through the daemon (`POST /broker/ask-first { service, key, ask: true }`), which enforces the mark from the next request. With no daemon, or a proxy without a broker on the socket, the CLI writes the record itself. `allow --ask` and `request --ask` mark before they declare, so a reference is never declared without its mark.
- **Removing a mark loosens, so a person decides in the daemon's dialog**, exactly like creating a link: `aquaman broker ask <ref> --off` posts `ask: false`, exits 0 removed or not marked, 2 declined, 3 nobody answered or rate limited, 1 refused or daemon not running. Only when the daemon answers `pending` with `code: 'prompt_unavailable'` does the command ask for a typed `yes` at a terminal, change the record itself and send `reload`. Do not add a flag or an environment variable that answers, and do not add another way to reach that fallback.
- **Enforcement is `AskFirstGate.authorize()`, after the scope check and before the vault read, on every path that returns a value**: `/broker/resolve` on both listeners and the OpenShell driver's Resolve in reference mode (the driver is handed the proxy's gate, `credentialProxy.askFirstGate`, so approvals and the dialog budget are shared). A proxy with a broker scope always has a gate; without a prompter a marked reference is refused. A new path that returns a value must call it. Forwarding and `/broker/route` hand no value to the caller and are not gated; OpenShell's Store in reference mode only checks the reference and is not gated; a copy (`aquaman://openshell/...`) is the gateway's own value.
- **The approval is in the gate's memory only**: one reference, until `broker.askFirstWindowSeconds` after the yes (default 28800, clamped to 60-86400 by `clampAskFirstWindow()`, read at daemon start) or until the daemon stops. A second request for the same reference while its dialog is up waits for the same answer. Removing a mark drops its approval.
- **The dialog** goes through `askApproval` with `read: { windowSeconds, via }` or `unmark: true` on the `PromptRequest`, and `promptMessage()` returns fixed wording for both (`READ_OPENING`, `readConsequence()`, `UNMARK_CONSEQUENCE`). The daemon does not know which program is asking. The opening names the listener the request came in on (socket, loopback token, OpenShell driver), which is all it knows, and the consequence says that it cannot tell and that the yes covers every program running as the user for the stated window. Never write a sentence there that names or implies a particular program, and keep the stated window equal to what the gate keeps (`windowText()` uses whole units). Caller text (`project`, or `OpenShell provider <name>`) is one `displayText()` line after aquaman's own.
- **Limits are `/broker/request`'s, through the same `PromptLimiter`**: one dialog at a time, six per ten minutes, a ten-minute cooldown after a decline (keyed `read:<name>` and `unmark:<name>`, so a declined credential request does not count as a declined read), no `fix` on a decline.
- **Refusals from `/broker/resolve` are 404 with a `code`** (the Hermes source treats 401/403 as fatal): `ask_first_declined` (no `fix`), `ask_first_unanswered` (timeout, another dialog open, too many), `prompt_unavailable` (`fix` names `aquaman broker ask <ref> --off`), and `ask_first_required` for a request that carries `"ask": false`, which never raises a dialog. `ask_timeout_seconds` (clamped like `--timeout`, default 90) and `project` are the other two body fields.
- **Clients ask twice.** `aquaman get` and `aquaman-coder exec` first send `ask: false` inside their usual timeout (15 s and 5 s), and only on `ask_first_required` send the request that waits for the dialog, with a longer socket timeout. `aquaman get` exits 2 declined, 3 unanswered or `prompt_unavailable`. `coder doctor` and the Hermes secret source send `ask: false` only: a check and a source never prompt.
- **`/broker/available` answers `true` for a marked, declared, stored reference while a person could still say yes, and `false` during the cooldown after a no** (`wouldServe()`), and `false` when the marks cannot be read. The hook therefore still wraps, the resolve raises the dialog, and `exec` leaves a refused variable unset with the reason on stderr and does not run a command for which nothing was handed out, so the hook's `allow` is never for a command that then runs with nothing. Answering `false` until approved would mean the hook never wraps and nobody is ever asked. `exec` skips rather than stops on a decline: the dialog is about the value, and a no means the value is not handed out, which is what happens.
- **Audit:** every dialog outcome and every change to a mark is an entry (`BROKER_ASK`, logged as `rotate`; a yes and a mark change carry a `note`, the others an `error`). The read after a yes is the usual `read` entry, and a refused resolve is the usual refusal entry with the code. No values.
- **A reference bound `--via-proxy` only is refused by `aquaman broker ask`** (and `request --ask --via-proxy`): its value is never handed out, and a mark that gates nothing would read as protection. The check is in the CLI; the endpoint accepts any non-reserved name, so a reference can be marked before it is declared.
- Limits, each an `it.fails` row: software that can write to the vault itself can delete the record, and inside the window any program running as the user reads without a dialog (`test/compliance/ask-first.test.ts`); where no dialog can be shown the typed `yes` is the only check on removing a mark, and a program can give itself a terminal (`test/e2e/cli-ask-first.test.ts`). Not gated and not a row: forwarding for the marked reference's service.
- The real dialog was not shown by the tests. A test never sends a real daemon a resolve for a marked reference without `"ask": false`, nor `ask: false` to `/broker/ask-first`: on macOS that opens a dialog. The dialog path is tested in-process with a scripted prompter, the CLIs against `fakeProxy`.
- Conformance: `test/compliance/ask-first.test.ts` (one row per way around the dialog; add a row for a new one), `test/unit/ask-first.test.ts`, `test/e2e/cli-ask-first.test.ts`.

## Login item (`aquaman service`)

`aquaman service install|uninstall|status` keeps the daemon running across logins: a launchd agent `sh.aquaman.daemon` (`~/Library/LaunchAgents/`) or a systemd user unit `aquaman.service` (`~/.config/systemd/user/`). Files: `service-unit.ts` (unit text and installer, takes its command runner and home directory), `service-consent.ts` (endpoint), `cli/service.ts` (glue).

- No secret is ever written into a unit. The unit carries a `PATH` and `AQUAMAN_CONFIG_DIR` only; `encrypted-file` is refused because its password would have to be stored, and env-only settings in the installing shell are reported by name (`env_not_passed`).
- A person decides. At a terminal the command asks y/N; without one it asks the daemon, which shows a dialog with fixed wording (`LOGIN_ITEM_MESSAGE`, no caller text) through `POST /_service/consent`: Unix socket only, off wherever credential requests are off, sharing `/broker/request`'s limits (one dialog at a time, six per ten minutes, ten-minute cooldown after a decline), no `fix` on `declined`, audited as `rotate`. `init --agent --service` goes through the same dialog. No flag or environment variable answers it.
- Nothing is stopped or written before `approved`. A running daemon is signalled only when the pid file and `/_health` over the socket agree, re-checked after the dialog. A daemon that has already exited when it is signalled counts as stopped; any other failure to stop it undoes the install and returns a fix. For systemd a `$` in the Node or CLI path is refused, because the `$$` escape is not known to apply to the executable word of `ExecStart`.
- `aquaman daemon` treats a pid file as "already running" only when the proxy on the socket reports that pid, so a stale file does not keep a login-started daemon from starting.
- Tests never run `launchctl` or `systemctl`: CLI e2e stops before a yes, and the approved path is covered through `ServiceDeps` with a fake runner. The real tools have not been run by the tests; `status`, `uninstall` and `doctor` do not query the service manager without a unit file.
- Not a boundary against software running as the user, which can write a launch agent itself or answer on the socket (an `it.fails` row). Conformance: `test/compliance/service-consent.test.ts`.

## Audit anchor

A process that writes the audit log (`daemon`, `openclaw start`, `openclaw plugin-mode`) stores `{ v, seq, hash, at, from }` in the credential store at `aquaman_internal/audit_anchor`: the sequence and hash of the newest entry, and `from`, the lowest sequence that is supposed to be on disk. Files: `audit-anchor.ts`, `core/audit/logger.ts`, `cli/audit-commands.ts`, `core/credentials/reserved.ts`.

- Entries carry `seq` (from 1, never restarts, covered by the hash) and the chain continues across rotation; entries without `seq` count by line position and are never rewritten. `verifyChain()` walks the current file and the archives it links to. Pruning never deletes the newest archive.
- **Several processes may write one log**: a daemon and an OpenClaw-hosted proxy on one config directory both do. Every append, WAL recovery, rotation and pruning happens under `write.lock` in the audit directory, an `O_EXCL` file that names its holder's pid, held for one synchronous append and never across a wait. A lock whose pid is not running, or that is older than 5 seconds, is taken over; one still held after 2 seconds fails the write, which the callers treat like any failed audit write (`audit_unavailable`). There is no long-lived writer lock: the process that lost it could be the one that holds the socket.
- Under the lock a writer looks at whether the current file changed since its own last write (inode and size) and, if so, reads only what was added, checks each added entry (next sequence, link, hash) and goes on from the last. `getPosition()` is therefore the log as of this process's own last write, not the log on disk. A log that does not continue from the writer's own last entry (cut short, replaced, a forged append) is not followed: the writer goes on from its own entry, prints `AUDIT FAILURE:` once, and the chain shows the break.
- **Readers never write.** `audit verify`, `audit tail` and what `audit accept` checks before it asks open the log with `readOnly: true`: no directory or file is created and the WAL is left alone (an entry there may belong to a writer in mid-append; only a writer holding the lock replays it). `audit rotate` and the entry `audit accept` writes go through the lock. `verifyChain()` reads again when it found errors and the files changed during the read (three tries), and `verifyAuditLog()` takes a second look before it reports a difference from the anchor, so a proxy that writes, rotates or anchors meanwhile is not reported as tampering.
- `from` is 1 for a log that was whole when the logger first opened it, and the first sequence present for one that already began later. Only `pruneArchives()` raises it, to the first sequence of the oldest archive kept, and it never goes down. `audit verify` fails with `head_missing` and the missing range when the log begins later than `from`. An anchor without `from` (none was released) is not compared on it, and the result says so.
- The anchor is written at most once per `audit.anchorIntervalSeconds` while entries arrive (default 60; 900 for `1password`, `bitwarden`, `keeper`, where a write can prompt; `0` is off), at once after pruning raised `from`, never while idle, and once more at SIGINT/SIGTERM, where `stop()` waits 5 seconds at most and prints `AUDIT FAILURE:` if the store did not answer. It only moves forward: each write first reads the stored anchor from the backend (`CachingStore.getFresh()`, past the daemon's cache), skips when the stored sequence is not lower, and keeps the higher `from`. A failed write prints `AUDIT FAILURE:` and is retried; it never fails a request.
- At start, a log that is behind its anchor, differs from it or begins later than its `from` prints `AUDIT FAILURE:` and anchoring pauses, so the finding is not overwritten. `aquaman audit accept` (terminal, typed yes, no proxy running) sets the anchor to the log as it is, with `from` at the first entry on disk, and records the reset.
- `aquaman audit verify` reads the vault: a vault it cannot read fails the check unless `--chain-only`. A log with no anchor yet passes as "not anchored yet".
- The reserved service holds the anchor, the link approvals (`aquaman_internal/link_approvals`) and the ask-first marks (`aquaman_internal/ask_first`). It is one check, `isReservedService()` in `core/credentials/reserved.ts` (re-exported by `broker-scope.ts`), called by the scope loaders and `check()`, the four `/broker/*` handlers and `/broker/ask-first`, forwarding, the OpenShell driver, `credentials add|delete`, `broker allow|revoke`, link names, `listCredentials()` (which hides both) and the OpenClaw migration (`unstorableServiceReason()` in `migration/openclaw-migrator.ts`: a plugin id from `openclaw.json` that is reserved or is not a service name is skipped and reported, by `openclaw migrate --auto` and by the migration `openclaw setup` runs). A new entry point that takes a service name must call it. Conformance: `test/compliance/audit-anchor-reserved.test.ts`.
- Tests: `test/unit/audit-log-shared.test.ts` (two loggers on one directory, readers, the lock, what is not followed, the cost of a write), `test/e2e/audit-log-processes.test.ts` (two real writer processes and a reader), `test/unit/audit-anchor-from.test.ts`. Not covered by a test: two processes that find the same abandoned lock in the same instant can both take it.

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
- Hermes' own conformance kit is vendored at `packages/hermes/tests/_hermes_conformance.py`; CI runs it against two real hosts: the last PyPI build (`HERMES_PYPI_VERSION`, 0.19.0) and the pinned git tag (`HERMES_REF`, `v0.23.1`; tags are `v0.x.y` since v0.21.6). The tag lane runs inside Hermes's own locked environment (`uv run --project <checkout> --frozen`), because Hermes pins Pillow through `[tool.uv] override-dependencies`, which does not apply when it is someone else's `--with-editable` dependency. Hermes removed PyPI publishing in PR #68217, and `SECRET_SOURCE_API_VERSION` is still 1 as of 0.23.1.
- `plugins.isolation: host` (Hermes 0.22+, opt-in) runs third-party plugins in a separate process. `hermes plugins validate` on v0.23.1 reports our plugin as host-ready (it uses only `register_command`, `register_tool`, `register_hook`, `register_secret_source`), and checks registrations against `provides_tools` / `provides_hooks` in `plugin.yaml`. A live host-mode session was not run.

## OpenShell credential driver (v0.17.0+)

OpenShell (NVIDIA) keeps provider credentials behind driver-owned opaque handles and injects them at egress from its supervisor; the sandbox sees `openshell:resolve:env:...`. `aquaman daemon` serves `openshell.credentials.v1.CredentialDriver` on `<configDir>/openshell.sock` (0600) when `openshell.driver.enabled` (set by `aquaman openshell setup`, env `AQUAMAN_OPENSHELL_DRIVER`). Files: `packages/proxy/src/openshell/{credential-driver,grpc-server,integration}.ts`, protos vendored at `packages/proxy/proto/openshell/` (v0.1.4).

- Reference mode: a submitted value that is an `aquaman://` ref must be declared (broker scope, `uds` caller) and exist in the vault; the ref becomes the handle and nothing is stored. Copy mode: anything else goes to the vault as `openshell/<objectId>.<credentialKey>`.
- A handle's meaning comes from its namespace (`aquaman://openshell/...` = copy), never from metadata the gateway echoes back. References are re-checked on every Resolve, so `aquaman broker revoke` takes effect. Delete on a reference is a no-op.
- Audit: resolves log `read` (agent `openshell`), copy writes and deletes log `rotate`, successful reference validation logs nothing. No values anywhere. A Resolve whose entry cannot be written returns an `internal` error and no value.
- gRPC deps are lazily loaded optional peers (packaging-posture test pins it). protobufjs's install script is not needed at runtime.

Verified against live gateways v0.1.1 through v0.1.4 (2026-10-02, re-run on v0.1.3/v0.1.4 2026-10-14, `scripts/e2e-openshell.sh`, CI `openshell-compat.yml` runs it nightly on latest + previous and was green on v0.1.7/v0.1.8 on 2026-11-14; protos have no non-comment change from v0.1.4 to v0.1.8):

- v0.1.8 (#4886): a static credential without placement metadata resolves only in `Authorization`. `x-api-key`, query and path slots need explicit placement in the provider profile, as the e2e profile has (`auth_style: header`, `header_name`).

- Handshake: extension protocol 1.0, capability `openshell.credentials.contract`; the gateway names itself `openshell/gateway`. External driver config: `credential_drivers = ["aquaman"]` plus `[openshell.credential_drivers.aquaman] transport = "uds"`, `socket_path` (absolute).
- The gateway authenticates nothing on the socket (only `user-agent` metadata); 0600 is the boundary.
- The gateway does not validate the submitted value's format, which is what makes reference mode work with the stock CLI. Driver error messages reach the CLI user verbatim.
- Resolves happen about once per sandbox start, not per request; `ListCredentials` is never called (so no "use an existing vault item" flow upstream yet).
- Injection is placeholder rewrite: it only happens where the client sends the placeholder.
- Local gateway gotchas: TOML schema v2, Docker sandboxes require `[openshell.gateway.gateway_jwt]` with an Ed25519 key, `allow_unauthenticated_users = true` for local CLI use. On macOS, Docker Desktop's VM kernel must have Landlock (4.55.0 does not, 4.93.0 does) and host networking must be on; OpenShell's `doctor check` verifies neither (reported upstream as NVIDIA/OpenShell#4133).

## CLI shape

Run `aquaman --help` (and `aquaman <namespace> --help`) rather than duplicating the surface here. The shape: vault-level commands at the top, then `openclaw`, `coder` and `hermes` namespaces, with `setup`/`doctor`/`status` at every level (top-level is an overview, namespaced goes deep). Doctor exits 1 if any check fails.

Gotchas the help text doesn't tell you:

- `aquaman openclaw plugin-mode` and `aquaman coder hook` are hidden. They are spawned by the plugin and by Claude Code, never run by hand.
- `aquaman coder *` delegates to the separate `aquaman-coder` binary, so it can be missing while the rest of the CLI works.
- `aquaman get <ref>` (v0.16.0) prints a declared credential for host credential-helper slots (`sbx secret set --command`, Codex `auth.command`, Claude Code `apiKeyHelper`, OpenClaw exec providers, Hermes command sources). It only talks to the running daemon, never the vault, so it is scope-checked and audited as `operation: read`; it refuses a TTY without `--show` and prints no trailing newline when piped. It hands the value to the calling process, so it is not isolation, and with the OpenClaw plugin's proxy on the socket it gets `broker_disabled`.
- `--non-interactive` reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AQUAMAN_ENCRYPTION_PASSWORD`, `AQUAMAN_KEEPASS_PASSWORD`, `VAULT_ADDR`, `VAULT_TOKEN`, `BW_SESSION`.
- `aquaman openclaw setup` does far more than the vault wizard: plugin install, openclaw.json merge, SecretRef plus loopback wiring, optional credential migration.
- A command that writes `config.yaml` starts from `loadStoredConfig()` (the file merged with the defaults), never from `loadConfig()`. `loadConfig()` adds values that exist only in the environment (the encryption password, a Vault token, a loopback token, the cache TTL, the broker switch, Bitwarden and Keeper settings), and saving its result would write them to disk. `test/e2e/cli-setup-config-preservation.test.ts` sets every override and checks the file.
- Re-running `aquaman setup` or `aquaman openclaw setup` changes only what setup decides: the backend, a policy preset for a newly stored service that has no policy, the loopback listener being on, and routed channels in `proxiedServices`. The loopback token and port, `broker.allowedRefs`, existing policies and the rest of `proxiedServices` are kept. Doctor recommends these commands, so they must be safe to repeat.
- Secrets typed at a terminal are read by `readHiddenTtyLine()` in raw mode (`credentials add`, both setup wizards, the KeePassXC master password). Do not attach a readline interface to the terminal while a secret is being typed: it echoes every key.
- Errors carry fixes. A proxy 401 returns `{ error, fix: "Run: aquaman credentials add <service> <key>" }`; keep that convention when adding failure paths.

## Credential backends

Eight backends; the list and their trade-offs are in the root README, the internals in OPERATIONS.md. Setup auto-detects: macOS → keychain; Linux → keychain with libsecret, else systemd-creds (systemd ≥ 256), else encrypted-file.

Gotchas:

- `keepassxc` needs `npm i -g kdbxweb argon2`, which are optional peers rather than dependencies (see Dependency posture).
- `keepassxc`, `systemd-creds` and `encrypted-file` keep decrypted data in the daemon's memory with no TTL. `encrypted-file` re-reads when the file's size, mtime or inode changes and writes by rename, so `aquaman credentials add` reaches a running daemon and two processes never drop each other's entries (`test/unit/credentials/store.test.ts`). `keepassxc` invalidates on an `fs.watch` event. `systemd-creds` caches per credential: a new one is found, a rotated one stays stale until the daemon restarts.
- `aquaman-coder exec` skips a binding the daemon answers 404 for (not stored, not declared, or marked ask-first and not allowed), with a warning on stderr naming the variable, and still runs the command. Anything else (daemon unreachable, `broker_disabled`, a backend error) stops it before the command runs. One missing credential must not take down every command in a project.
- `CachingStore` (`core/credentials/caching-store.ts`) is a TTL'd in-memory decorator applied only in daemon contexts, because 1Password prompts biometrics per `op` spawn, Bitwarden spawns `bw`, Keeper spawns Commander (login plus vault sync per run), and Vault does an HTTP round-trip. Default 900 s for `1password`/`bitwarden`/`vault`/`keeper`, off elsewhere; `credentials.cacheTtlSeconds` or `AQUAMAN_CACHE_TTL` overrides, `0` disables. No negative caching, write-through invalidation, errors never cached, memory only, audit stays per-request. Conformance: `test/compliance/cache-residency.test.ts`.
- `keeper` (v0.16.0, issue #67) drives Keeper Commander, not the Secrets Manager SDK, because KSM needs the Business add-on and the requester uses the standard password manager. Records are `aquaman::<service>::<key>` in one folder addressed by UID (`keeperFolderUid` / `AQUAMAN_KEEPER_FOLDER_UID`). Writes go over stdin (`keeper --batch-mode -`) with values as `$BASE64:`, because Commander treats `$GEN`/`$JSON` as macros and folds a leading `=` into the field name. Every write first does a stdin-closed read, since a lapsed login would read the first stdin line as the account email. Verified against Commander v18.1.5 source and `test/helpers/fake-keeper.mjs`, not a live account.
- For zero prompts with 1Password use `OP_SERVICE_ACCOUNT_TOKEN`; doctor prints the hint. `OP_CONNECT_HOST`/`OP_CONNECT_TOKEN` win if both are set.

## Dependency posture

A consumer's `npm audit` of our tarball is a published security signal: it is what flipped the ClawHub scan of 0.14.0 to `suspicious`.

- `kdbxweb` and `argon2` are optional **peer** deps of the proxy, not dependencies. `optionalDependencies` would not work (npm installs those); optional peers are the only form npm skips. Both are lazily imported.
- `openclaw` is an optional peer of the plugin, so `npm i aquaman-plugin` doesn't pull an 86 MB gateway into consumer trees.
- `undici` and `@sinclair/typebox` are exact-pinned in the plugin; Dependabot bumps them. An exact pin means consumers cannot pick up a fixed version on their own: `undici` 7.30.0 collected 8 advisories two weeks after v0.17.0 shipped and stayed in the published plugin until v0.17.1. Merge those bumps and cut a patch promptly.
- `smol-toml` (exact-pinned, zero dependencies) is a dependency of `aquaman-coder` since v0.17.1, to read Codex's `config.toml`.
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

Compliance tests are source-repo only, never shipped, and named for the control they exercise: MITRE ATLAS v5.4.0 (T0055, T0012, T0062, T0090, T0098), NIST SP 800-53 Rev 5 (IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10), BSI TR-02102-1 Version 2026-01 (`bsi/`) and the OWASP Agentic and LLM Top 10 categories aquaman makes a claim under (`owasp-agentic/`). Mapping docs live in `docs/compliance/`. CISA/Five-Eyes and CSA MAESTRO are alignment narratives.

A compliance test tries to break the control, not only to use it: one table row per attack, so the next variant is one line. An attack the code does not stop is an `it.fails` row whose assertion says what should happen and whose name states the limit; it becomes a failure the day the limit is fixed, and the mapping doc states the same limit. Never weaken the assertion to make a row pass.

The audit log's limit, stated once: the chain is an unkeyed SHA-256, and what ties it to something outside the file is the anchor (see "Audit anchor"). `aquaman audit verify` detects an entry altered, inserted or deleted inside the log, and through the anchor a log cut short at its end, emptied, deleted or rebuilt, and one that has lost entries from its beginning (an old archive deleted, the head of the file removed), which pruning alone is allowed to remove. It does not detect the removal of entries written since the last anchor (up to `audit.anchorIntervalSeconds`), a change by software that can write to the credential store (which can move or delete the anchor, or raise its `from`), or missing early entries under an anchor that was written without `from`. Each is an `it.fails` row in `test/compliance/nist/au-9-au-10-tampering.test.ts`. Two things fail verification without anyone having tampered, and both need a person: a process that stopped between pruning and the anchor write that follows it leaves a log that begins later than its anchor says (`aquaman audit accept`), and a writer that sat idle while other writers rotated and pruned the archive holding its last entry breaks the chain at its next write (an `it.fails` row in `test/unit/audit-log-shared.test.ts`; ten rotations by other processes with the defaults). Do not write "tamper-evident" or "tampering is detectable" without those qualifications.

Manual smoke recipes (install paths, all auth modes, policy denials, real-gateway checks, publish pipeline) live in OPERATIONS.md. Run them against isolated `HOME`/`AQUAMAN_CONFIG_DIR` dirs: several would otherwise overwrite your real Keychain entries or config.

## Files to know

| File | Purpose |
|---|---|
| `packages/proxy/src/daemon.ts` | Both listeners, auth modes, broker endpoint |
| `packages/proxy/src/broker-scope.ts` | Declared-ref scope for the broker |
| `packages/proxy/src/request-policy.ts` | Method + path policy, presets, `lintPolicyConfig` |
| `packages/proxy/src/service-registry.ts` | 27 builtin services, host map |
| `packages/proxy/src/cli/index.ts` | The whole CLI |
| `packages/proxy/src/core/credentials/` | Backends, `store.ts`, `caching-store.ts` |
| `packages/proxy/src/core/audit/logger.ts` | Hash-chained audit log, sequence numbers, `verifyChain()` |
| `packages/proxy/src/audit-anchor.ts` | The anchor in the vault: writer, comparison, verify, accept |
| `packages/proxy/src/core/credentials/links.ts`, `linked-store.ts` | Links to existing vault items |
| `packages/proxy/src/ask-first.ts` | Ask-first marks in the vault, the gate before every value, `/broker/ask-first` |
| `packages/proxy/src/route-auth.ts` | Which keys are routable, reading the route token out of Basic auth |
| `packages/proxy/src/sigv4.ts` | AWS SigV4: strict reader of the inbound header, the AWS host, canonical forms, the signer |
| `packages/proxy/src/service-unit.ts`, `service-consent.ts` | Login item for the daemon and the dialog that approves it |
| `packages/proxy/src/openclaw/secretref.ts` | SecretRef + loopback baseUrl wiring |
| `packages/proxy/src/openclaw/integration.ts` | Version gates, detection, launch |
| `packages/proxy/src/hermes/config-writer.ts` | `~/.hermes/.env` block, managed-scope detection |
| `packages/proxy/src/openshell/credential-driver.ts` | OpenShell credential driver core (reference/copy modes) |
| `scripts/e2e-openshell.sh` | Live OpenShell gateway end-to-end (CI: `openshell-compat.yml`) |
| `packages/plugin/index.ts` | Plugin entry the Gateway loads |
| `packages/plugin/openclaw.plugin.json` | Manifest (allowlisted keys) |
| `packages/plugin/secrets-resolver.mjs` | SecretRef exec resolver |
| `packages/plugin/src/proxy-manager.ts` | Spawns the proxy, parses its ready line |
| `packages/coder/src/broker-client.ts` | UDS broker client, typed errors |
| `packages/coder/src/adapters/claude-code/` | Hook protocol + settings writer |
| `packages/hermes/aquaman_hermes/plugin.py` | Python plugin: status surface + secret source |

Tests mirror these names under `test/unit`, `test/e2e` and `test/compliance`.

## Design principles

Credentials never in agent memory. A hash-chained audit entry for every use. Bring your own vault. Follow each host's native patterns rather than fighting them.

## Maintainer resources

Two gitignored companions: **OPERATIONS.md** (runbook: release procedure, smoke recipes, scanner patterns, publish pipeline) and **ROADMAP.md** (planning, competitive research, in-flight investigations, release history). New maintainers should ask for both. Neither holds secrets.
