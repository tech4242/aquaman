# 🔱🦞 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![npm version](https://img.shields.io/npm/v/aquaman-proxy?label=aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![npm downloads](https://img.shields.io/npm/dm/aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![Security: process isolation](https://img.shields.io/badge/security-process%20isolation-critical)](https://github.com/tech4242/aquaman#security-model)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Credential isolation for OpenClaw — secrets stay submerged, agents stay dry.

You bought a brand new Mac Mini, set up OpenClaw, and now you're staring at your `~/.openclaw/openclaw.json` wondering why your Anthropic API key is sitting there in plaintext. You read the articles. You know what happens when an agent gets prompt-injected. We get it.

Aquaman fixes this with three layers of defense:

1. **Process isolation** — API keys live in a separate proxy process. The agent never sees them. Even RCE in the agent can't reach credentials — they're in a different address space.
2. **Request policies** — Per-service rules control *which endpoints* an agent can call. Block admin APIs, prevent deletions, allow drafts but deny sends. Denied requests never get real credentials.
3. **Tamper-evident audit** — Every credential use is logged with SHA-256 hash chains. You can prove what was accessed and detect tampering after the fact.

No SDK changes required. The proxy is transparent — your agent talks to `aquaman.local`, the proxy injects auth and forwards to the real API.

## Quick Start

### Local (macOS / Linux)

```bash
npm install -g aquaman-proxy              # install the proxy CLI
aquaman setup                             # stores keys, installs OpenClaw plugin
openclaw                                  # proxy starts automatically via plugin
```

> `aquaman setup` auto-detects your credential backend. macOS defaults to Keychain,
> Linux defaults to encrypted file. Override with `--backend`:
> `aquaman setup --backend keepassxc`
> Options: `keychain`, `encrypted-file`, `keepassxc`, `1password`, `vault`, `systemd-creds`, `bitwarden`

Existing plaintext credentials are migrated automatically during setup.
The migration detects credentials from channels (Telegram, Slack, etc.)
**and** third-party plugins/skills (any `*token*`, `*key*`, `*secret*`,
`*password*` fields in `openclaw.json` plugin configs). Upstream URLs are
auto-detected from plugin config fields like `endpoint` or `baseUrl`.
Run again anytime to migrate new credentials: `aquaman migrate openclaw --auto`

The plugin starts the proxy for you — no extra steps. To check
everything is wired up correctly:

```bash
aquaman doctor                 # diagnose issues with actionable fixes
aquaman help                   # list all commands
```

### Docker Setup

Single-image deployment — same UDS architecture as local, containerized.

```bash
git clone https://github.com/tech4242/aquaman.git && cd aquaman
cp docker/.env.example docker/.env
# Edit docker/.env — pick a backend and set its credentials
# needless to say instead of .env you should handle your env properly but this is a starting point you can test.
npm run docker:build
npm run docker:run
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

## Security Audit

`openclaw security audit --deep` reports two expected findings:

- **`dangerous-exec`** on `proxy-manager.ts` — the plugin spawns the proxy as a separate process. This is how aquaman keeps credentials out of the agent.
- **`tools_reachable_permissive_policy`** — OpenClaw warns that plugin tools (like `aquaman_status`) are reachable when no restrictive tool profile is set. This is an environment-level advisory about your agent's tool policy, not a vulnerability in aquaman. If your agents handle untrusted input, set `"tools": { "profile": "coding" }` in `openclaw.json` to restrict which tools agents can call.

`aquaman setup` adds the plugin to `plugins.allow` automatically so OpenClaw knows you trust it.
