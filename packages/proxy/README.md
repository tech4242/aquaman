# aquaman-proxy

The proxy daemon and CLI for [aquaman](https://github.com/tech4242/aquaman) — API key protection for OpenClaw. Credentials stay in your vault, never in the agent's memory.

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │══ Unix ═════>│  Keychain / 1Pass /  │
│  = aquaman.local     │   Domain     │  Vault / Encrypted   │
│                      │<═ Socket ════│                      │
│  fetch() interceptor │══ (UDS) ════>│  + Policy enforced   │
│  redirects channel   │              │  + Auth injected:    │
│  API traffic         │              │    header / url-path │
│                      │              │    basic / oauth     │
│                      │              │                      │
│  No credentials.     │  ~/.aquaman/ │                      │
│  No open ports.      │  proxy.sock  │                      │
│  Nothing to steal.   │  (chmod 600) │                      │
└──────────────────────┘              └───┬──────────┬───────┘
                                         │          │
                                         │          ▼
                                         │  ~/.aquaman/audit/
                                         │  (hash-chained log)
                                         ▼
                               api.anthropic.com
                               api.mistral.ai
                               api.telegram.org
                               slack.com/api  ...
```

This package is the right side — a reverse proxy on a Unix domain socket that stores credentials in secure backends, enforces request policies, injects auth headers, and logs every access. The agent never sees a key.

## Quick Start

```bash
npm install -g aquaman-proxy              # 1. install the proxy CLI
aquaman setup                             # 2. store your API keys, install plugin
openclaw                                  # 3. done — proxy starts automatically
```

> **Installed via ClawHub?** The proxy is already bundled with the plugin.
> Run `openclaw aquaman setup` to store your keys.

Troubleshooting: `aquaman doctor`

## CLI

| Command | Description |
|---------|-------------|
| `aquaman setup` | Guided onboarding (stores keys, installs plugin, applies policy defaults) |
| `aquaman doctor` | Diagnose issues with actionable fixes |
| `aquaman credentials add <svc> <key>` | Store a credential |
| `aquaman credentials list` | List stored credentials |
| `aquaman migrate openclaw --auto` | Migrate plaintext secrets to secure store |
| `aquaman daemon` | Run proxy in foreground |
| `aquaman start` | Start proxy + launch OpenClaw |
| `aquaman stop` | Stop running proxy |
| `aquaman status` | Show config and proxy status |
| `aquaman policy list` | List configured policy rules |
| `aquaman policy test <svc> <method> <path>` | Dry-run a request against policy rules |
| `aquaman audit tail` | Recent audit entries |
| `aquaman audit verify` | Verify hash chain integrity |

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

The proxy enforces four layers of protection:

- **Process isolation** — credentials in a separate address space, connected via UDS (`chmod 600`)
- **Service allowlisting** — `proxiedServices` controls which APIs the agent can reach
- **Request policies** — method + path rules per service, checked *before* credential injection ([details](https://github.com/tech4242/aquaman#request-policies))
- **Audit trail** — SHA-256 hash-chained logs of every credential use

7 credential backends: Keychain, 1Password, Vault, Bitwarden, KeePassXC, systemd-creds, encrypted-file.

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for the full security model, request policy config, Docker deployment, and architecture diagrams.

## License

MIT
