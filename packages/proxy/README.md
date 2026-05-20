# aquaman-proxy

The vault + daemon + audit core of [aquaman](https://github.com/tech4242/aquaman). API key protection for AI agents — credentials stay in your vault, never in the agent's memory.

This is the **always-on piece**: every other aquaman package (`aquaman-plugin` for OpenClaw, `aquaman-coder` for AI coding agents) talks to it. If you only install one aquaman package, install this one.

```
Agent / OpenClaw / Coding Agent              Aquaman Proxy
┌──────────────────────┐                     ┌──────────────────────┐
│                      │                     │                      │
│  ANTHROPIC_BASE_URL  │═══════ UDS ════════>│  Keychain / 1Pass /  │
│  = aquaman.local     │                     │  Vault / Encrypted   │
│                      │<══════════════════  │                      │
│  fetch() interceptor │═══ broker:resolve ═>│  + Policy enforced   │
│  redirects channel   │                     │  + Auth injected:    │
│  API traffic         │                     │    header / url-path │
│                      │  ~/.aquaman/        │    basic / oauth     │
│  No credentials.     │  proxy.sock         │                      │
│  No open ports.      │  (chmod 0o600)      │                      │
│  Nothing to steal.   │                     │                      │
└──────────────────────┘                     └───┬──────────┬───────┘
                                                │          │
                                                │          ▼
                                                │  ~/.aquaman/audit/
                                                │  (hash-chained log)
                                                ▼
                                      api.anthropic.com
                                      api.mistral.ai
                                      api.telegram.org
                                      slack.com/api  …
```

## Install

```bash
npm install -g aquaman-proxy
aquaman setup           # backend wizard + store keys
aquaman daemon &        # start the proxy on ~/.aquaman/proxy.sock
```

## CLI

The `aquaman` binary surfaces three command surfaces:

### Top-level (vault, agent-agnostic)

| Command | Description |
|---|---|
| `aquaman setup` | Vault-only wizard — backend + credentials. For full OpenClaw bundle: `aquaman openclaw setup`. |
| `aquaman doctor` | Overview health check (vault + integration summaries with soft upsells) |
| `aquaman status` | Proxy daemon overview |
| `aquaman daemon` | Run the proxy in foreground |
| `aquaman stop` | Stop a running daemon |
| `aquaman init` | Low-level config bootstrap (called by `setup`) |
| `aquaman credentials add <svc> <key>` | Store a credential |
| `aquaman credentials list` / `delete` / `guide` | Vault CRUD + setup help |
| `aquaman audit tail` / `verify` / `rotate` | Audit log management |
| `aquaman services list` / `validate` | Service registry inspection |
| `aquaman policy list` / `test <svc> <method> <path>` | Policy inspection + dry-run |

### `aquaman openclaw …` (OpenClaw Gateway integration)

| Command | Description |
|---|---|
| `aquaman openclaw setup` | Full OpenClaw bundle: vault wizard + plugin install + auth-profiles.json |
| `aquaman openclaw doctor` | Deep diagnostic for the OpenClaw integration |
| `aquaman openclaw status` | Plugin lifecycle, sentinel env vars |
| `aquaman openclaw start` | Spawn proxy + launch OpenClaw |
| `aquaman openclaw configure` | Generate env vars for OpenClaw |
| `aquaman openclaw migrate` | Move plaintext credentials from `~/.openclaw/openclaw.json` into the vault |

### `aquaman coder …` (AI coding-agent integration)

Delegates to the [`aquaman-coder`](../coder) binary; install it separately. The proxy never imports coder code (see [`docs/PACKAGES.md`](../../docs/PACKAGES.md)).

| Command | Description |
|---|---|
| `aquaman coder setup <agent>` | Install hooks for an agent (`claude-code` today) |
| `aquaman coder doctor` | Deep diagnostic for the coder integration |
| `aquaman coder status` | Projects, hook wiring, broker connectivity |
| `aquaman coder project list/add/remove` | `~/.aquaman/projects.yaml` CRUD |
| `aquaman coder get <ref>` | Resolve an `aquaman://service/key` reference |
| `aquaman coder exec <cmd>` | Run a command with project env injected + output redacted |

## 25 Builtin Services

| Category | Services |
|----------|----------|
| **Providers** | Anthropic, OpenAI, GitHub, xAI, Cloudflare AI Gateway, Mistral, Hugging Face, ElevenLabs |
| **Channels (header)** | Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, Zalo |
| **Channels (URL-path)** | Telegram |
| **Channels (basic)** | Twilio, BlueBubbles, Nextcloud Talk |
| **Channels (OAuth)** | MS Teams, Feishu, Google Chat |
| **At-rest only** | Nostr, Tlon |

## Security

Four layers of protection:

- **Process isolation** — credentials in a separate address space, connected via UDS (`chmod 0o600`)
- **Service allowlisting** — `proxiedServices` controls which APIs the agent can reach
- **Request policies** — method + path rules per service, checked *before* credential injection ([details in the root README](https://github.com/tech4242/aquaman#request-policies))
- **Audit trail** — SHA-256 hash-chained logs of every credential use

7 credential backends: Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, systemd-creds, encrypted-file.

## Broker endpoint (v0.12.0+)

`POST /broker/resolve` over the UDS — used by `aquaman-coder` to materialize credentials per tool call. Body:

```json
{"service":"anthropic","key":"api_key","ttl_seconds":60}
```

Response: `{"value":"...","expires_at":"2026-05-20T12:34:56Z"}`. Validates service/key names against safe regexes; 4 KB body cap; policy is applied before resolution.

## Documentation

- **[Root README](https://github.com/tech4242/aquaman#readme)** — value prop, three-path Quick Start, security model
- **[`docs/PACKAGES.md`](../../docs/PACKAGES.md)** — package boundary policy
- **[`docs/compliance/`](../../docs/compliance/)** — MITRE ATLAS + NIST SP 800-53 mappings
- **[`CLAUDE.md`](../../CLAUDE.md)** — architecture notes

## License

MIT
