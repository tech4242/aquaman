# aquaman-proxy

The vault + daemon + audit core of [aquaman](https://github.com/tech4242/aquaman). API key protection for AI agents. Bring your own vault. Credentials stay where you already keep them, never in the agent's memory.

This is the **always-on piece**: every other aquaman package (`aquaman-plugin` for OpenClaw, `aquaman-coder` for AI coding agents) talks to it. If you only install one aquaman package, install this one.

```
Agent / OpenClaw / Coding Agent              Aquaman Proxy
┌──────────────────────┐                     ┌──────────────────────┐
│                      │                     │                      │
│  ANTHROPIC_BASE_URL  │════ UDS / HTTP ════>│  Keychain / 1Pass /  │
│  = aquaman.local     │                     │  Vault / Encrypted   │
│                      │<══════════════════  │                      │
│  fetch() interceptor │═══ broker:resolve ═>│  + Policy enforced   │
│  redirects channel   │                     │  + Auth injected:    │
│  API traffic         │                     │    header / url-path │
│                      │  ~/.aquaman/        │    basic / oauth     │
│  No credentials.     │  proxy.sock         │                      │
│  No open ports.      │  (chmod 0o600)      │                      │
│  No keys to read.    │                     │                      │
└──────────────────────┘                     └──┬──────────┬────────┘
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

`aquaman help`, `aquaman doctor` are your friends.

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

- **Process isolation**: credentials live in a separate address space, reached over a Unix socket (`chmod 0o600`) or a token-gated loopback listener — see below
- **Service allowlisting**: `proxiedServices` controls which APIs the agent can reach
- **Request policies**: method + path rules per service, checked *before* credential injection ([details in the root README](https://github.com/tech4242/aquaman#request-policies))
- **Broker scope** (v0.15.0+): the one endpoint that returns a credential *value* serves only refs you declared, and never runs on an OpenClaw-hosted proxy
- **Audit trail**: SHA-256 hash-chained logs of every credential use

### Transports and access control

| Path | Transport | Access control |
|---|---|---|
| Coding agents (`aquaman-coder`), any UDS-capable client | Unix socket `~/.aquaman/proxy.sock` | File permissions (`0600`) — only processes running as you |
| Hermes (v0.13.0+), OpenClaw model traffic (v0.15.0+) | Loopback TCP `127.0.0.1:<port>` | Per-install token, constant-time check, bound to loopback |

Two transports because two kinds of host. Anything that can dial a Unix socket does. Hermes and OpenClaw cannot: each builds its own HTTP client, Hermes exposes no transport hook, and OpenClaw's model transport neither calls `globalThis.fetch` nor resolves a sentinel hostname. A loopback listener is the only interface they accept.

The token is a capability to reach the local proxy, not a credential. It is generated per install, stored in `~/.aquaman/config.yaml` (`0600`), and handed to the host as the provider "api key" so it travels on every call. The proxy checks it, strips it, and injects the real key from your vault.

The honest difference: any process on the machine can *reach* a loopback port, including other local users, where the socket's `0600` shuts them out. The token is what stops them there. So the listener stays off until a host needs it — `aquaman hermes setup` or `aquaman openclaw setup` turn it on — and the Unix socket remains the default everywhere else. On a single-user machine the two are equivalent in practice; on a shared machine the socket is stricter.

**Bring your own vault.** Aquaman has no house vault. It injects credentials from the secret store you already run: Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, systemd-creds, or encrypted-file. No new store to adopt, no migration.

## Broker endpoint (v0.12.0+)

`POST /broker/resolve` — the one endpoint that returns a credential *value*, used by `aquaman-coder` to materialize credentials per tool call and by the Hermes secret source. Body:

```json
{"service":"anthropic","key":"api_key","ttl_seconds":60}
```

Response: `{"value":"...","expires_at":"2026-05-20T12:34:56Z"}`. Validates service/key names against safe regexes; 4 KB body cap.

Scoped since v0.15.0, because it hands out values rather than injecting them:

- Served by `aquaman daemon` only. A proxy started by the OpenClaw plugin answers `404 broker_disabled` — the OpenClaw path never materializes a credential.
- Only refs you declared resolve: the `env` refs in `~/.aquaman/projects.yaml`, plus anything added with `aquaman broker allow`. Everything else is `404 broker_ref_not_declared`, decided before the vault is consulted, so a refusal reveals nothing about what you store.
- Over the loopback listener the LLM provider keys are never materialized, declared or not (`404 broker_ref_isolated`) — they stay on the proxy path.
- Declaring a ref is an explicit opt-in to handing that value to processes running as you. Refusals and resolves are both audited.

## Documentation

- **[Root README](https://github.com/tech4242/aquaman#readme)**: value prop, three-path Quick Start, security model
- **[`docs/PACKAGES.md`](../../docs/PACKAGES.md)**: package boundary policy
- **[`docs/compliance/`](../../docs/compliance/)**: MITRE ATLAS + NIST SP 800-53 mappings
- **[`CLAUDE.md`](../../CLAUDE.md)**: architecture notes

## License

MIT
