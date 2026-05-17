# 🔱🦞 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![npm version](https://img.shields.io/npm/v/aquaman-proxy?label=aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![npm downloads](https://img.shields.io/npm/dt/aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![Security: process isolation](https://img.shields.io/badge/security-process%20isolation-critical)](https://github.com/tech4242/aquaman#security-model)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

API key protection for OpenClaw — credentials stay in your vault, never in the agent's memory. 🔱🦞

You bought a brand new Mac Mini, set up OpenClaw, and now you're staring at your `~/.openclaw/openclaw.json` wondering why your Anthropic API key is sitting there in plaintext. You read the articles. You know what happens when an agent gets prompt-injected. We get it.

Aquaman fixes this with three layers of defense:

1. **Process isolation** — API keys live in a separate proxy process. The agent never sees them. Even RCE in the agent can't reach credentials — they're in a different address space.
2. **Request policies** — Per-service rules control *which endpoints* an agent can call. Block admin APIs, prevent deletions, allow drafts but deny sends. Denied requests never get real credentials.
3. **Tamper-evident audit** — Every credential use is logged with SHA-256 hash chains. You can prove what was accessed and detect tampering after the fact.

No SDK changes required. The proxy is transparent — your agent talks to `aquaman.local`, the proxy injects auth and forwards to the real API.

## Quick Start

```bash
openclaw plugins install aquaman-plugin   # 1. install plugin + proxy
openclaw aquaman setup                    # 2. store your API keys
openclaw                                  # 3. done — proxy starts automatically
```

Troubleshooting: `openclaw aquaman doctor`

> **Using npm?** `npm install -g aquaman-proxy && aquaman setup` does
> the same thing — installs the proxy CLI, stores your keys, and installs
> the plugin. Use this if you prefer managing packages with npm.

### Docker

Single-image deployment — same UDS architecture, containerized.

```bash
git clone https://github.com/tech4242/aquaman.git && cd aquaman
cp docker/.env.example docker/.env
# Edit docker/.env — pick a backend and set credentials
npm run docker:build && npm run docker:run
```

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │══ Unix ════> │  Keychain / 1Pass /  │
│  = aquaman.local     │   Domain     │  Vault / Encrypted   │
│                      │<═ Socket ═══ │                      │
│  fetch() interceptor │══ (UDS) ══=> │  + Policy enforced   │
│  redirects channel   │              │  + Auth injected:    │
│  API traffic         │              │    header / url-path │
│                      │              │    basic / oauth     │
│                      │              │                      │
│  No credentials.     │  ~/.aquaman/ │                      │
│  No open ports.      │  proxy.sock  │                      │
│  Nothing to steal.   │  (chmod 600) │                      │
└──────────────────────┘              └──┬──────────┬────────┘
                                         │          │
                                         │          ▼
                                         │  ~/.aquaman/audit/
                                         │  (hash-chained log)
                                         ▼
                               api.anthropic.com
                               api.telegram.org
                               slack.com/api  ...
```

1. **Store** — Credentials live in a vault backend (Keychain, 1Password, Vault, Bitwarden, encrypted file, KeePassXC, systemd-creds)
2. **Policy** — Proxy checks method + path rules *before* touching credentials. Denied requests get a 403, never real auth headers.
3. **Inject** — Proxy looks up the credential and adds the auth header before forwarding. 25 builtin services, 4 auth modes (header, URL-path, HTTP Basic, OAuth).
4. **Audit** — Every credential use is logged with SHA-256 hash chains.

The agent only sees a sentinel hostname (`aquaman.local`). It never sees a key, and no port is open for other processes to probe.

## Security Model

| Layer | What it does | What it stops |
|-------|-------------|---------------|
| **Process isolation** | Credentials in separate process, connected via Unix domain socket (`chmod 600`) | Compromised agent can't read keys — different address space, no TCP port to probe |
| **Service allowlisting** | `proxiedServices` controls which APIs the agent can reach | Agent can't talk to services you didn't authorize |
| **Request policies** | Method + path rules per service, enforced before credential injection | Agent can reach Anthropic but not its admin API; can draft emails but not send them |
| **Audit trail** | SHA-256 hash-chained logs of every credential use | Post-incident forensics, tamper detection, compliance evidence |

### Proxy process

The plugin spawns the `aquaman` binary from the `aquaman-proxy` npm package, declared as an exact-pinned dependency (no semver range) and published by the same author (`tech4242`). After spawn, the plugin checks the running proxy's reported version against its own and logs a warning if they disagree. The spawn is what triggers `dangerous-exec` in OpenClaw's static scanner — it's intentional and is the whole point of the plugin.

### HTTP interceptor scope

The plugin overrides `globalThis.fetch` to redirect channel API traffic (Slack, Discord, Telegram, …) through the local proxy. Two important constraints:

- **Only services you opted into get intercepted.** As of v0.11.4, the interceptor filters its known-host map by the plugin's `services` config — channels not in `services` keep their normal direct-to-upstream behavior. The 26-entry fallback map is a *catalog* of known services, not a list of what gets intercepted on any given install.
- **Unix Domain Socket only, no network exposure.** The interceptor sends requests through `~/.aquaman/proxy.sock`, never a TCP port.

### Auth profiles

OpenClaw checks `~/.openclaw/agents/<id>/agent/auth-profiles.json` before making API calls — without a placeholder entry, the request never reaches the proxy. To avoid a 6-step onboarding, the plugin auto-writes this file on first load with placeholder entries for `anthropic` and `openai` only (never arbitrary services). The proxy strips the placeholder and injects the real credential.

- The plugin never overwrites an existing `auth-profiles.json`.
- To suppress generation entirely, set `autoGenerateAuthProfiles: false` in the plugin config (v0.11.4+). Operators managing their own auth profiles can opt out cleanly.

### Audit log

Every credential use is recorded in `~/.aquaman/audit/current.jsonl` with a SHA-256 hash chain — local-only, no telemetry. `aquaman doctor` surfaces issues; `aquaman audit tail` shows recent entries. The `policy` config (above) lets operators block specific upstream endpoints *before* credentials are injected; denied requests return `403` with an actionable fix message.

### Scanner findings

`openclaw security audit --deep` reports two expected findings:

- **`dangerous-exec`** on the proxy-manager module — the plugin spawns the proxy as a separate process. This is how aquaman keeps credentials out of the agent.
- **`tools_reachable_permissive_policy`** — OpenClaw warns that plugin tools (like `aquaman_status`) are reachable when no restrictive tool profile is set. This is an environment-level advisory about your agent's tool policy, not a vulnerability in aquaman. If your agents handle untrusted input, set `"tools": { "profile": "coding" }` in `openclaw.json` to restrict which tools agents can call.

ClawHub's ClawScan additionally produces a higher-level review of plugin behavior. The current scan acknowledges credential isolation, proxy spawn, the host map, the auth-profiles generation, and the audit log — see the publisher note on the ClawHub package page for context on each item.

`aquaman setup` adds the plugin to `plugins.allow` automatically so OpenClaw knows you trust it.

## Request Policies

OAuth scopes can't distinguish between "draft an email" and "send an email" — they're both `gmail.send`. Request policies fill that gap: allow the service, then restrict what happens inside it.

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
        action: deny          # block admin API
      - method: DELETE
        path: "/v1/**"
        action: deny          # no deletions
  slack:
    defaultAction: allow
    rules:
      - method: "*"
        path: "/admin.*"
        action: deny          # block Slack admin methods
  gmail:
    defaultAction: allow
    rules:
      - method: POST
        path: "/v1/users/*/messages/send"
        action: deny          # drafts ok, sending blocked
```

- **No policy = allow all** (backward compatible)
- **First match wins** — rules evaluated top-to-bottom, unmatched requests fall through to `defaultAction`
- **Denied before auth** — blocked requests never get real credentials
- **Path globs:** `*` matches within a segment, `**` matches zero or more segments
- **`aquaman setup`** applies safe defaults (blocks admin/billing endpoints for stored services)
- **`aquaman policy list`** shows all configured rules; **`aquaman policy test <svc> <method> <path>`** dry-runs a request
- **`aquaman doctor`** validates your policy config and warns about typos

## Credential Backends

| Backend | Best For | Setup |
|---------|----------|-------|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `keepassxc` | Existing KeePass users | Set `AQUAMAN_KEEPASS_PASSWORD` or key file |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin` |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |
| `systemd-creds` | Linux with systemd ≥ 256 | TPM2-backed, no root required |
| `bitwarden` | Bitwarden users | `bw login && export BW_SESSION=$(bw unlock --raw)` |

**Important:** `encrypted-file` is a last-resort backend for headless Linux/CI environments without a native keyring. For better security, install `libsecret-1-dev` (for GNOME Keyring), use `systemd-creds` (Linux with TPM2), or use 1Password/Vault.

