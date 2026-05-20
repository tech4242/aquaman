# 🔱 Aquaman

[![CI](https://github.com/tech4242/aquaman/actions/workflows/ci.yml/badge.svg)](https://github.com/tech4242/aquaman/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tech4242/aquaman/branch/main/graph/badge.svg)](https://codecov.io/gh/tech4242/aquaman)
[![npm version](https://img.shields.io/npm/v/aquaman-proxy?label=aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![npm downloads](https://img.shields.io/npm/dt/aquaman-proxy)](https://www.npmjs.com/package/aquaman-proxy)
[![Security: process isolation](https://img.shields.io/badge/security-process%20isolation-critical)](https://github.com/tech4242/aquaman#security-model)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

API key protection for AI agents. Credentials stay in your vault, never in the agent's memory.

You set up Claude Code (or OpenClaw, or Codex), and now you're staring at a `.env` file with your Anthropic key, GitHub token, and database URL sitting there in plaintext. You read the articles. You know what happens when an agent gets prompt-injected. We get it.

Aquaman fixes this with three layers of defense:

1. **Process isolation** — API keys live in a separate proxy process. The agent never sees them. Even RCE in the agent can't reach credentials — they're in a different address space.
2. **Request policies** — Per-service rules control *which endpoints* an agent can call. Block admin APIs, prevent deletions, allow drafts but deny sends. Denied requests never get real credentials.
3. **Tamper-evident audit** — Every credential use is logged with SHA-256 hash chains. You can prove what was accessed and detect tampering after the fact.

## Pick your path

Aquaman ships as three coordinated npm packages, sharing one vault + one daemon. Install only what you need:

| Package | What it does | When to install |
|---|---|---|
| **[`aquaman-proxy`](packages/proxy/)** | Core: vault, daemon, audit, policy, CLI. The piece everyone needs. | Always. |
| **[`aquaman-plugin`](packages/plugin/)** | OpenClaw Gateway adapter. Spawns the proxy on Gateway startup; intercepts channel traffic; 25 builtin services across 6 auth modes. | If you run an OpenClaw Gateway. Also available at https://clawhub.ai/plugins/aquaman-plugin |
| **[`aquaman-coder`](packages/coder/)** | AI coding-agent adapter. Project-scoped `aquaman://service/key` references resolved per Bash tool call. | If you use Claude Code (today) — Codex / OpenCode / Cursor planned. |

A single `aquaman` CLI surfaces all three: top-level commands for vault and audit, `aquaman openclaw ...` for the OpenClaw integration, `aquaman coder ...` for the coding-agent integration (delegates to `aquaman-coder` under the hood).

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
openclaw                                          # 3. done — proxy starts automatically
```

Troubleshooting: `openclaw aquaman doctor`.

**Using npm directly?** `npm install -g aquaman-proxy && aquaman openclaw setup` does the same — installs the proxy CLI, stores your keys, installs the plugin into `~/.openclaw/extensions/aquaman-plugin/`, and writes the auth-profiles.json placeholder.

The plugin's HTTP interceptor only redirects traffic for services in its `services` config (Anthropic + OpenAI by default). Add more under the plugin config in `openclaw.json` — supported channels include Slack, Discord, Telegram, MS Teams, Matrix, LINE, Twitch, Twilio, BlueBubbles, Mattermost, Nostr, Tlon, Feishu, Google Chat, ElevenLabs, xAI, Cloudflare AI Gateway, Mistral, Hugging Face, and more (25 total).

### 3. AI coding agents (Claude Code today)

```bash
npm install -g aquaman-proxy aquaman-coder        # 1. install daemon + adapter
aquaman setup                                      # 2. vault wizard
aquaman daemon &                                   # 3. start the proxy

aquaman coder project add my-app --path ~/code/my-app \
  --env ANTHROPIC_API_KEY=aquaman://anthropic/api_key \
  --env GITHUB_TOKEN=aquaman://github/token         # 4. declare a project
aquaman coder setup claude-code                    # 5. wire Claude Code hooks
aquaman doctor                                     # 6. verify — should show both vault + coder green
```

**See it for yourself (the 30-second aha):** restart Claude Code, open a new session inside `~/code/my-app`, and ask the agent to run:

```
printenv | grep ANTHROPIC_API_KEY
```

You'll see this in the transcript:

```
ANTHROPIC_API_KEY=[REDACTED:injected-value]

⏺ ANTHROPIC_API_KEY is set and available (injected via aquaman vault). 
```

The *child* process saw the real key (your tests, builds, MCP servers, import scripts — anything that actually needs it works). The *agent* — the thing that decides what code to run on your machine — never sees the value, and so neither does the conversation history, neither does the model provider's logs, neither does anyone who later screenshots your terminal.

When Claude Code runs a Bash tool in `~/code/my-app`, aquaman's hook rewrites the command via `updatedInput.command` to wrap it under `aquaman-coder exec`. That wrapper:

- Resolves each `aquaman://service/key` reference via the broker (`POST /broker/resolve` over UDS) — credentials are materialized for one command, not for the agent's lifetime.
- Pipes stdout/stderr through a redactor that prepends a value-based pattern for each resolved value: **whatever string was injected gets redacted, regardless of shape** (Atlassian tokens, Notion secrets, internal-API keys — none of them need to match a known provider format). Generic shape-based patterns (sk-ant-, ghp_, sk_live_, AKIA…, JWTs, PEM blocks, ATATT3xF…) still run after as defense-in-depth for secrets the child surfaces that we did NOT inject.
- Cleans up when the command exits.

## How It Works

```
Agent / OpenClaw / Coding Agent             Aquaman Proxy
┌──────────────────────┐                    ┌──────────────────────┐
│                      │                    │                      │
│  ANTHROPIC_BASE_URL  │═══════ UDS ═══════>│  Keychain / 1Pass /  │
│  = aquaman.local     │                    │  Vault / Encrypted   │
│                      │<══════════════════ │                      │
│  fetch() interceptor │═══ broker:resolve  │  + Policy enforced   │
│   (channel APIs)     │                    │  + Auth injected:    │
│                      │                    │    header / url-path │
│  No credentials.     │  ~/.aquaman/       │    basic / oauth     │
│  No open ports.      │  proxy.sock        │                      │
│  Nothing to steal.   │  (chmod 0o600)     │                      │
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

1. **Store** — Credentials live in a vault backend (Keychain, 1Password, Vault, Bitwarden, encrypted file, KeePassXC, systemd-creds).
2. **Policy** — Proxy checks method + path rules *before* touching credentials. Denied requests get a `403`, never real auth headers.
3. **Inject** — Proxy looks up the credential and adds the auth header before forwarding. 25 builtin services, 4 auth modes (header, URL-path, HTTP Basic, OAuth).
4. **Broker (coder path)** — `POST /broker/resolve` materializes a credential per tool call, scoped to a single command's env, then expires.
5. **Audit** — Every credential use is logged with SHA-256 hash chains.

The agent only ever sees a sentinel hostname (`aquaman.local`) or a placeholder marker (`aquaman-proxy-managed`). It never sees a real key, and no TCP port is open for other processes to probe.

## Security Model

| Layer | What it does | What it stops |
|---|---|---|
| **Process isolation** | Credentials in separate process, connected via Unix domain socket (`chmod 0o600`) | Compromised agent can't read keys — different address space, no TCP port to probe |
| **Service allowlisting** | `proxiedServices` controls which APIs the agent can reach | Agent can't talk to services you didn't authorize |
| **Request policies** | Method + path rules per service, enforced before credential injection | Agent can reach Anthropic but not its admin API; can draft emails but not send them |
| **Audit trail** | SHA-256 hash-chained logs of every credential use | Post-incident forensics, tamper detection, compliance evidence |
| **Per-tool-call broker (coder)** | `aquaman-coder exec` materializes creds for one command at a time | Credentials don't sprawl across the agent's shell environment |
| **Output redaction (coder)** | `aquaman-coder exec` pipes stdout/stderr through a redactor that scrubs each value it just injected verbatim — plus generic provider patterns as a fallback | Even arbitrary, shape-less credentials never reach the agent transcript |

Detailed model — per-integration specifics (HTTP interceptor scope, auth profiles, scanner findings, ClawScan publisher note) — lives in [`packages/plugin/README.md`](packages/plugin/README.md) and [`packages/coder/README.md`](packages/coder/README.md).

### Compliance posture

Aquaman ships runnable conformance tests under `test/compliance/` mapped to:

- **MITRE ATLAS** v5.3 — techniques AML.T0055, T0012, T0062, T0090 (`test/compliance/atlas/`)
- **NIST SP 800-53 Rev 5** — IA-5, AC-3, AC-6, AU-2/9/10, SC-12/28, SI-10 (`test/compliance/nist/`)

Plus alignment narratives for CISA/Five-Eyes "Careful Adoption of Agentic AI Services" (April 2026), CSA MAESTRO, and OWASP Top 10 for Agentic Applications. The tests run as part of `npm test`. See [`docs/compliance/`](docs/compliance/) for the mappings.


## Request Policies

OAuth scopes can't distinguish between "draft an email" and "send an email" — they're both `gmail.send`. Request policies fill that gap.

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
        path: "/admin.*"
        action: deny
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
- `aquaman setup` applies safe defaults for stored services (`anthropic`, `openai`, `slack`, `gmail`).
- `aquaman policy list` / `aquaman policy test <svc> <method> <path>` for inspection / dry-runs.

## Credential Backends

| Backend | Best For | Setup |
|---|---|---|
| `keychain` | Local dev on macOS (default) | Works out of the box |
| `encrypted-file` | Linux, WSL2, CI/CD | AES-256-GCM, password-protected |
| `keepassxc` | Existing KeePass users | Set `AQUAMAN_KEEPASS_PASSWORD` or key file |
| `1password` | Team credential sharing | `brew install 1password-cli && op signin` |
| `vault` | Enterprise secrets management | Set `VAULT_ADDR` + `VAULT_TOKEN` |
| `systemd-creds` | Linux with systemd ≥ 256 | TPM2-backed, no root required |
| `bitwarden` | Bitwarden users | `bw login && export BW_SESSION=$(bw unlock --raw)` |

`aquaman setup` auto-detects a sensible default (macOS → `keychain`; Linux → `keychain` if libsecret, else `systemd-creds` if systemd ≥ 256, else `encrypted-file`).

`encrypted-file` is a last-resort for headless Linux/CI environments without a native keyring. For better security on Linux, install `libsecret-1-dev` (GNOME Keyring), use `systemd-creds` (TPM2 binding), or use 1Password/Vault.

## Development

```bash
npm install
npm run build                # all packages
npm test                     # ~690 tests
npm run typecheck
npm run lint
```

See [`docs/PACKAGES.md`](docs/PACKAGES.md) for the cross-package import policy and [`CLAUDE.md`](CLAUDE.md) for architecture notes.

## License

MIT — see [LICENSE](LICENSE).
