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

- **Process isolation**: credentials live in a separate address space, reached over a Unix socket (`chmod 0o600`) or a token-gated loopback listener (see below)
- **Service allowlisting**: `proxiedServices` controls which APIs the agent can reach
- **Request policies**: method + path rules per service, checked *before* credential injection ([details in the root README](https://github.com/tech4242/aquaman#request-policies))
- **Broker scope** (v0.15.0+): the one endpoint that returns a credential *value* serves only refs you declared, and never runs on an OpenClaw-hosted proxy
- **Audit trail**: SHA-256 hash-chained logs of every credential use

### Transports and access control

| Path | Transport | Access control |
|---|---|---|
| Coding agents, any client that can dial a socket | Unix socket `~/.aquaman/proxy.sock` | File permissions (`0600`): only processes running as you |
| Hermes (v0.13.0+), OpenClaw model and Telegram traffic (v0.15.0+) | Loopback TCP `127.0.0.1:<port>` | Per-install token, constant-time check, loopback bind |

Hermes and OpenClaw each build their own HTTP client and can't dial a socket, so they use the listener. Everything else uses the socket.

The token is a capability to reach the local proxy, not a credential. Generated per install, stored in `~/.aquaman/config.yaml` (`0600`), sent by the host as its provider api key. The proxy checks it, strips it, injects your real key.

The Telegram Bot API has no auth header, so there the token travels in the `/bot<TOKEN>` path segment instead. The proxy accepts it there, strips it before the policy check and the request log, and puts the real bot token back at the same position, which is what keeps `/file/bot<TOKEN>/<path>` downloads working.

Trade-off: any local process can reach a loopback port, including other users, where the socket's `0600` shuts them out. The token is the gate there, so the listener stays off until `aquaman hermes setup` or `aquaman openclaw setup` turns it on.

**Bring your own vault.** Aquaman has no house vault. It injects credentials from the secret store you already run: Keychain, 1Password, HashiCorp Vault, Bitwarden, Keeper, KeePassXC, systemd-creds, or encrypted-file. No new store to adopt, no migration.

## Broker endpoint (v0.12.0+)

`POST /broker/resolve` is the one endpoint that returns a credential *value*. `aquaman-coder` uses it to materialize credentials per tool call, as does the Hermes secret source. Body:

```json
{"service":"anthropic","key":"api_key","ttl_seconds":60}
```

Response: `{"value":"...","expires_at":"2026-05-20T12:34:56Z"}`. Validates service/key names against safe regexes; 4 KB body cap.

Scoped since v0.15.0, because it hands out values rather than injecting them:

- Served by `aquaman daemon` only. A proxy started by the OpenClaw plugin answers `404 broker_disabled`: that path never materializes a credential.
- Only refs you declared resolve: the `env` refs in `~/.aquaman/projects.yaml`, plus anything added with `aquaman broker allow`. Everything else is `404 broker_ref_not_declared`, decided before the vault is consulted, so a refusal reveals nothing about what you store.
- Over the loopback listener the LLM provider keys are never materialized, declared or not (`404 broker_ref_isolated`). They stay on the proxy path.
- Declaring a ref is an explicit opt-in to handing that value to processes running as you. Refusals and resolves are both audited.

`aquaman get <aquaman://service/key>` (v0.16.0+) is the command-line form, for tools that take a command printing a secret: Docker Sandboxes (`sbx secret set <svc> --command`), Codex (`model_providers.<id>.auth.command`), Claude Code (`apiKeyHelper`), OpenClaw exec secret providers and Hermes command secret sources. It only talks to the running daemon, so the same scope applies and every read is audited. It refuses to print to an interactive terminal without `--show`, and prints no trailing newline when another program reads it. The value goes to the program that runs the command.

## Documentation

- **[Root README](https://github.com/tech4242/aquaman#readme)**: value prop, three-path Quick Start, security model
- **[`docs/PACKAGES.md`](../../docs/PACKAGES.md)**: package boundary policy
- **[`docs/compliance/`](../../docs/compliance/)**: MITRE ATLAS + NIST SP 800-53 mappings
- **[`AGENTS.md`](../../AGENTS.md)**: architecture notes

## License

MIT
