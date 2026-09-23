# 🔱 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![npm version](https://img.shields.io/npm/v/aquaman-proxy?label=aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![npm downloads](https://img.shields.io/npm/dt/aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![Security: process isolation](https://img.shields.io/badge/security-process%20isolation-critical)](https://github.com/tech4242/aquaman#security-model)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

🔱 The only independent credential proxy for AI agents: bring-your-own-vault isolation & least-privilege request policies. Your keys stay where you already keep them, never in the agent's memory. Compatible with 1Password, keychain, keepassxc and many others.

You set up Claude Code, Codex, OpenClaw, or Hermes, and now you're staring at `.env` files with your precious API keys sitting there in plaintext. You read the articles. You know what happens when an agent gets prompt-injected. We get it.

Aquaman fixes this with three layers of defense:

1. **Process isolation**: API keys live in a separate proxy process that injects them at egress. The agent holds a marker, never a key, so even RCE in the agent can't read one. Coding agents get only the refs you declare, one command at a time.
2. **Request policies**: Per-service rules control *which endpoints* an agent can call. Block admin APIs, prevent deletions, allow drafts but deny sends. Denied requests never get real credentials.
3. **Tamper-evident audit**: Every credential use is logged with SHA-256 hash chains. You can prove what was accessed and detect tampering after the fact.

## Pick your path

Aquaman ships as four coordinated packages, sharing one vault + one daemon. Install only what you need:

| Package | What it does | When to install |
|---|---|---|
| **[`aquaman-proxy`](packages/proxy/)** | Core: vault, daemon, audit, policy, CLI. The piece everyone needs. | Always. |
| **[`aquaman-plugin`](packages/plugin/)** | OpenClaw Gateway adapter. Spawns the proxy on Gateway startup; routes model and Telegram traffic through it; 25 builtin services across 5 auth modes. | If you run an OpenClaw Gateway. Also available at https://clawhub.ai/plugins/aquaman-plugin |
| **[`aquaman-coder`](packages/coder/)** | AI coding-agent adapter. Project-scoped `aquaman://service/key` references resolved per Bash tool call. | If you use Claude Code or Codex. |
| **[`aquaman-hermes`](packages/hermes/)** | Hermes agent-host plugin (Python, on PyPI). Points Hermes at an opt-in, token-gated loopback listener via its native `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`; adds an in-session `/aquaman-status` command, tool, and health probe. Isolation is proxy-side; the plugin holds no credentials. | If you run the Hermes agent host. `pip install aquaman-hermes` |

A single `aquaman` CLI surfaces all four: top-level commands for vault and audit, `aquaman openclaw ...` for the OpenClaw integration, `aquaman coder ...` for the coding-agent integration (delegates to `aquaman-coder` under the hood) as well as `aquaman hermes ...` for the Hermes Python package.

## Quick Start

`aquaman help`, `aquaman doctor` are your friends.

### 1. Vault only (just the proxy + your secrets)

```bash
npm install -g aquaman-proxy
aquaman setup                                # backend wizard + store keys
aquaman daemon &                             # start the proxy
aquaman credentials list                     # verify
```

The proxy listens on `~/.aquaman/proxy.sock` (UDS, `chmod 0o600`). Point any tool at `http://aquaman.local/<service>/<path>` and the proxy injects auth headers for that service from your chosen vault backend.

### 2. OpenClaw Gateway

```bash
openclaw plugins install aquaman-plugin           # 1. install plugin + proxy
openclaw aquaman setup                            # 2. backend + keys + plugin wire-up
openclaw                                          # 3. done - proxy starts automatically
```

Troubleshooting: `openclaw aquaman doctor`.

**Using npm directly?** `npm install -g aquaman-proxy && aquaman openclaw setup` does the same - installs the proxy CLI, stores your keys, installs the plugin into `~/.openclaw/extensions/aquaman-plugin/`, and wires the credentials (SecretRef refs on OpenClaw ≥ 2026.6.5, the auth-profiles.json placeholder on older versions).

`aquaman openclaw setup` points `models.providers.<svc>.baseUrl` and `channels.telegram.apiRoot` at the proxy's loopback listener, because OpenClaw's model transport and its channels each build their own HTTP client and bypass the fetch interceptor. Channels other than Telegram expose no endpoint override, so their tokens are stored and migrated but not injected at egress (see [`packages/plugin/README.md`](packages/plugin/README.md)). Add channels under the plugin config in `openclaw.json`; supported ones include Slack, Discord, Telegram, MS Teams, Matrix, LINE, Twitch, Twilio, BlueBubbles, Mattermost, Nostr, Tlon, Feishu, Google Chat, ElevenLabs, xAI, Cloudflare AI Gateway, Mistral, Hugging Face, and more (25 total).

### 3. AI coding agents (Claude Code, Codex)

```bash
npm install -g aquaman-proxy aquaman-coder        # 1. install daemon + adapter
aquaman setup                                      # 2. vault wizard
aquaman daemon &                                   # 3. start the proxy

aquaman coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token         # 4. declare a project
aquaman coder setup claude-code                    # 5. wire Claude Code hooks
                                                   #    (or: aquaman coder setup codex)
aquaman doctor                                     # 6. verify - should show both vault + coder green
```

**See it for yourself (the 30-second aha):** restart Claude Code (or Codex), open a new session inside `~/code/my-app`, and ask the agent to run:

```
printenv | grep ANTHROPIC_API_KEY
```

You'll see this in the transcript:

```
ANTHROPIC_API_KEY=[REDACTED:injected-value]

⏺ ANTHROPIC_API_KEY is set and available (injected via aquaman vault). 
```

The *child* process saw the real key (your tests, builds, MCP servers, import scripts - anything that actually needs it works). The *agent* - the thing that decides what code to run on your machine - never sees the value, and so neither does the conversation history, neither does the model provider's logs, neither does anyone who later screenshots your terminal.

**Use it from your own terminal too.** The same wrapper works without the agent. Just `cd` into a covered project and prefix your command:

```bash
cd ~/code/
aquaman-coder exec -- python app/scripts/import.py
```

Same env injection, same redaction on stdout/stderr. Drop it into Makefile targets, shell aliases, or CI runners - anywhere you'd otherwise reach for a `.env` file.

When Claude Code or Codex runs a shell command in `~/code/my-app`, aquaman's hook rewrites the command via `updatedInput.command` to wrap it under `aquaman-coder exec`. That wrapper:

- Resolves each `aquaman://service/key` reference via the broker (`POST /broker/resolve` over UDS). Credentials are materialized for one command, not for the agent's lifetime.
- Pipes stdout/stderr through a redactor that prepends a value-based pattern for each resolved value: **whatever string was injected gets redacted, regardless of shape** (Atlassian tokens, Notion secrets, internal-API keys - none of them need to match a known provider format). Generic shape-based patterns (sk-ant-, ghp_, sk_live_, AKIA…, JWTs, PEM blocks, ATATT3xF…) still run after as defense-in-depth for secrets the child surfaces that we did NOT inject.
- Cleans up when the command exits.

**Claude Code sandbox:** it blocks Unix sockets by default, so `aquaman coder setup claude-code` allowlists the proxy socket on macOS (`sandbox.network.allowUnixSockets`). Linux and WSL2 ignore that list, where the only option is `sandbox.network.allowAllUnixSockets: true`, which opens every Unix socket to sandboxed commands.

**Codex:** approve the aquaman hooks in Codex's startup hook review after setup (Codex skips new hooks until you trust them). Its sandbox also blocks the proxy socket by default; `aquaman coder setup codex` prints the `config.toml` permissions profile that allows it. Codex hooks cannot rewrite shell output, so redaction happens inside `aquaman-coder exec`. Details in [`packages/coder/README.md`](packages/coder/README.md#codex).

### 4. Hermes (agent host)

Hermes is a foreign (Python) host with no transport hook to inject, so isolation is done proxy-side: the proxy exposes an opt-in, token-gated loopback listener and Hermes is pointed at it through its own env vars.

```bash
npm install -g aquaman-proxy                       # 1. install daemon
aquaman setup                                      # 2. vault wizard
aquaman credentials add anthropic api_key sk-ant-... # 3. store a provider key

aquaman hermes setup                               # 4. enable loopback + write ~/.hermes/.env
aquaman daemon &                                   # 5. start the proxy (UDS + loopback)
aquaman hermes doctor                              # 6. verify - listener + env + vault + Hermes
```

`aquaman hermes setup` enables the loopback listener, generates a per-install token, and writes an aquaman-managed block into `~/.hermes/.env` (honoring `HERMES_HOME`): the native `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` plus a placeholder api_key equal to the token. Hermes sends the token as its provider key; the proxy strips it, injects your real vault credential, and forwards upstream. LLM providers only (Anthropic, OpenAI) today.

**Optional in-session sugar** - the Python plugin adds a `/aquaman-status` command, an `aquaman_status` tool, and a session-start health probe inside Hermes (holds no credentials):

```bash
pip install aquaman-hermes            # or: uv tool install aquaman-hermes
aquaman-hermes install                # drops the plugin into ~/.hermes/plugins/aquaman/
hermes plugins enable aquaman
```

The plugin also registers an `aquaman` **secret source** (Hermes ≥ 0.18.1) for project secrets like `GITHUB_TOKEN`. Bind them under `secrets.aquaman.env` in Hermes' `config.yaml`, then declare each ref with `aquaman broker allow aquaman://github/token` (required since v0.15.0; `aquaman hermes doctor` lists any you missed). Unlike the LLM keys above, these values do enter Hermes' env. See [`packages/hermes/README.md`](packages/hermes/README.md).

## How It Works

```
Agent / OpenClaw / Coding Agent             Aquaman Proxy
┌──────────────────────┐                    ┌──────────────────────┐
│                      │                    │                      │
│  ANTHROPIC_BASE_URL  │═══ UDS / HTTP ════>│  Keychain / 1Pass /  │
│  = aquaman.local     │                    │  Vault / Encrypted   │
│                      │<══════════════════ │                      │
│  fetch() interceptor │═══ broker:resolve  │  + Policy enforced   │
│   (channel APIs)     │                    │  + Auth injected:    │
│                      │                    │    header / url-path │
│  No credentials.     │  ~/.aquaman/       │    basic / oauth     │
│  No open ports.      │  proxy.sock        │                      │
│  No keys to read.    │  (chmod 0o600)     │                      │
└──────────────────────┘                    └──┬─────────┬─────────┘
                                               │         │
                                               │         ▼
                                               │  ~/.aquaman/audit/
                                               │  (hash-chained)
                                               ▼
                                     api.anthropic.com
                                     api.telegram.org
                                     slack.com/api …
```

1. **Store**: Credentials live in the vault backend you already run - no house vault (Keychain, 1Password, HashiCorp Vault, Bitwarden, Keeper, KeePassXC, systemd-creds, encrypted-file).
2. **Policy**: Proxy checks method + path rules *before* touching credentials. Denied requests get a `403`, never real auth headers.
3. **Inject**: Proxy looks up the credential and adds the auth header before forwarding. 25 builtin services, 4 injecting auth modes (header, URL-path, HTTP Basic, OAuth); a 5th, `none`, is at-rest-only (proxy rejects traffic).
4. **Broker (coder + Hermes secret source)**: `POST /broker/resolve` materializes a credential per tool call, scoped to a single command's env. Only `aquaman daemon` serves it, and only for refs you declared (`projects.yaml` or `aquaman broker allow`). The OpenClaw plugin's proxy never serves it (v0.15.0+).
5. **Audit**: Every credential use is logged with SHA-256 hash chains.

On the proxy paths the agent sees a local endpoint plus a marker: the `aquaman-proxy-managed` placeholder, or the loopback token, which only works against your local proxy. Never a real key. On the coder path the *child* command gets the declared values and the agent sees redacted output.

## Security Model

| Layer | What it does | What it stops |
|---|---|---|
| **Process isolation** | Credentials in a separate process, reached over a Unix socket (`chmod 0o600`) or a token-gated loopback listener | Compromised agent can't read proxied keys: different address space |
| **Broker scope** | Only `aquaman daemon` hands out values, and only for refs you declared; OpenClaw-hosted proxies never do (v0.15.0+) | An agent can't pull arbitrary vault entries through the socket |
| **Service allowlisting** | `proxiedServices` controls which APIs the agent can reach | Agent can't talk to services you didn't authorize |
| **Request policies** | Method + path rules per service, enforced before credential injection | Agent can reach Anthropic but not its admin API; can draft emails but not send them |
| **Audit trail** | SHA-256 hash-chained logs of every credential use | Post-incident forensics, tamper detection, compliance evidence |
| **Per-tool-call broker (coder)** | `aquaman-coder exec` materializes creds for one command at a time | Credentials don't sprawl across the agent's shell environment |
| **Output redaction (coder)** | `aquaman-coder exec` pipes stdout/stderr through a redactor that scrubs each value it just injected verbatim - plus generic provider patterns as a fallback | Even arbitrary, shape-less credentials never reach the agent transcript |

### Transports and access control

| Path | Transport | Access control |
|---|---|---|
| Coding agents, any client that can dial a socket | Unix socket `~/.aquaman/proxy.sock` | File permissions (`0600`): only processes running as you |
| Hermes (v0.13.0+), OpenClaw model and Telegram traffic (v0.15.0+) | Loopback TCP `127.0.0.1:<port>` | Per-install token, constant-time check, loopback bind |

Hermes and OpenClaw each build their own HTTP client and can't dial a socket, so they use the listener. Everything else uses the socket.

The token is a capability to reach the local proxy, not a credential. Generated per install, stored in `~/.aquaman/config.yaml` (`0600`), sent by the host as its provider api key. The proxy checks it, strips it, injects your real key. Telegram has no auth header, so there the token rides in the `/bot<TOKEN>` path segment instead.

Trade-off: any local process can reach a loopback port, including other users, where the socket's `0600` shuts them out. The token is the gate there, so the listener stays off until `aquaman hermes setup` or `aquaman openclaw setup` turns it on.

### Channel credentials on OpenClaw 2026.7.33+

| Channel | Egress through the proxy |
|---|---|
| Telegram | Yes, since v0.15.0 |
| Everything else | No. Vault storage and migration only |

Each channel builds its own HTTP client per request, so the plugin's `fetch` interceptor no longer sees channel traffic on these versions. Routing a channel needs an endpoint override from the host, and Telegram is the only one that has it: `aquaman openclaw setup` points `channels.telegram.apiRoot` at the proxy and replaces the bot token with the loopback token.

For the rest, your token stays in the vault but OpenClaw uses it directly, so the proxy is not in the path and those calls are not audited. `aquaman openclaw doctor` lists which of your configured channels are in which group. Model providers are unaffected.

**What same-user isolation can't do.** The socket's `0o600` keeps other users out, not other processes running as you. Such a process can send requests through the proxy while it runs (bounded by request policy, recorded in the audit log) and can fetch refs you declared, which is what declaring means. It cannot read the keys the proxy injects. For a harder boundary, run the agent as a different OS user or in a sandbox.

Detailed model - per-integration specifics (HTTP interceptor scope, auth profiles, scanner findings, ClawScan publisher note) - lives in [`packages/plugin/README.md`](packages/plugin/README.md) and [`packages/coder/README.md`](packages/coder/README.md).

### Compliance posture

Aquaman ships runnable conformance tests under `test/compliance/` mapped to:

- **MITRE ATLAS** v5.4.0: techniques AML.T0055, T0012, T0062, T0090, T0098 (`test/compliance/atlas/`)
- **NIST SP 800-53 Rev 5**: IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10 (`test/compliance/nist/`)

Plus alignment narratives for CISA/Five-Eyes "Careful Adoption of Agentic AI Services" (April 2026), CSA MAESTRO, and OWASP Top 10 for Agentic Applications. The tests run as part of `npm test`. See [`docs/compliance/`](docs/compliance/) for the mappings.


## Request Policies

OAuth scopes can't distinguish between "draft an email" and "send an email". They're both `gmail.send`. Request policies fill that gap.

```yaml
# ~/.aquaman/config.yaml
policy:
  anthropic:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/v1/organizations/**"
        action: deny          # block admin/billing API
  openai:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/v1/organization/**"
        action: deny
      - method: DELETE
        path: "/v1/**"
        action: deny          # no deletions
  slack:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/api/admin.*"
        action: deny          # Slack Web API admin methods
  gmail:
    defaultAction: allow
    rules:
      - method: POST
        path: "/gmail/v1/users/*/messages/send"
        action: deny          # drafts ok, sending blocked
```

- **Paths are the upstream API's full path** after the service prefix: Slack's Web API is `/api/<method>`, Gmail's is `/gmail/v1/...`. Presets before v0.15.0 used `/admin.*` and `/v1/users/*/messages/send`, which never matched real traffic. `aquaman doctor` flags those if they're still in your config.
- **No policy = allow all** (backward compatible)
- **First match wins**: rules evaluated top-to-bottom, unmatched requests fall through to `defaultAction`
- **Denied before auth**: blocked requests never get real credentials
- **Path globs:** `*` matches within a segment, `**` matches zero or more segments
- `aquaman setup` applies safe defaults for stored services (`anthropic`, `openai`, `slack`, `gmail`).
- `aquaman policy list` / `aquaman policy test <svc> <method> <path>` for inspection / dry-runs.

## Credential Backends

Bring your own vault - aquaman has no house store. Pick the backend you already run; secrets stay there, and the proxy reads them in place.

| Backend | Best For | Setup |
|---|---|---|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `keepassxc` | Existing KeePass users | `npm i -g kdbxweb argon2` (optional peers since v0.14.1), then set `AQUAMAN_KEEPASS_PASSWORD` or a key file |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin`. For unattended agents use a [service account](https://developer.1password.com/docs/service-accounts/) (`OP_SERVICE_ACCOUNT_TOKEN`) |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |
| `systemd-creds` | Linux with systemd ≥ 256 | TPM2-backed, no root required |
| `bitwarden` | Bitwarden users | `bw login && export BW_SESSION=$(bw unlock --raw)` |
| `keeper` | Keeper password manager users (v0.16.0+) | `pip install keepercommander`, log in once with `keeper shell` and turn on `this-device persistent-login on`, create a folder for aquaman, then `export AQUAMAN_KEEPER_FOLDER_UID=<folder UID>`. Records are titled `aquaman::<service>::<key>` |

`aquaman setup` auto-detects a sensible default (macOS → `keychain`; Linux → `keychain` if libsecret, else `systemd-creds` if systemd ≥ 256, else `encrypted-file`).

`encrypted-file` is a last-resort for headless Linux/CI environments without a native keyring. For better security on Linux, install `libsecret-1-dev` (GNOME Keyring), use `systemd-creds` (TPM2 binding), or use 1Password/Vault.

### Credential caching (v0.13.1+)

Backends with a per-access cost, like `1password` (a biometric prompt per read in desktop-app mode), `bitwarden` (~1-2 s CLI spawn), `keeper` (a Commander spawn that logs in and syncs) and `vault` (an HTTP round-trip), are cached **in the daemon's memory** for 15 minutes by default, so a busy agent session unlocks the vault once per window instead of once per request. The other backends are already fast or cache internally, so caching is off for them by default. Tune with `credentials.cacheTtlSeconds` in `~/.aquaman/config.yaml` (or `AQUAMAN_CACHE_TTL`); `0` disables.

The honest trade-off: a per-access biometric prompt is a user-presence check, and the cache removes per-access presence for the TTL window. For unattended agents that prompt never gets answered, so the vault gets abandoned for a plaintext `.env`, which is strictly worse. The cache does **not** move the isolation boundary: values live only in the proxy process (where they already transit on every request), are never written to disk, and are invalidated immediately when you rotate through `aquaman credentials add`. Writes always go to your vault. Conformance-tested in [`test/compliance/cache-residency.test.ts`](test/compliance/cache-residency.test.ts). For zero prompts with 1Password, use a service account scoped to the `aquaman` vault; `aquaman doctor` will point you there.

## License

MIT - see [LICENSE](LICENSE).
