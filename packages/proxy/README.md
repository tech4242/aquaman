# aquaman-proxy

Credential isolation proxy and CLI for [aquaman](https://github.com/tech4242/aquaman).

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │──request────>│  Keychain / 1Pass /  │
│  = localhost:8081    │              │  Vault / Encrypted   │
│                      │<─response────│                      │
│  fetch() interceptor │──channel────>│  + Auth injected:    │
│  redirects channel   │   traffic    │    header / url-path │
│  API traffic         │              │    basic / oauth     │
│                      │              │                      │
│  No credentials.     │              │                      │
│  Nothing to steal.   │              │                      │
└──────────────────────┘              └───┬──────────┬───────┘
                                         │          │
                                         │          ▼
                                         │  ~/.aquaman/audit/
                                         │  (hash-chained log)
                                         ▼
                               api.anthropic.com
                               api.telegram.org
                               slack.com/api  ...
```

This package is the right side. A reverse proxy that intercepts API requests and injects credentials from secure backends. 23 builtin services, four auth modes.

## Quick Start

With OpenClaw:

```bash
npm install -g aquaman-proxy              # 1. Install
aquaman setup                             # 2. Store keys, install plugin, configure OpenClaw
aquaman migrate openclaw --auto           # 3. Move existing channel creds to secure store
openclaw                                  # 4. Proxy starts automatically via plugin
```

Standalone:

```bash
npm install -g aquaman-proxy
aquaman init
aquaman credentials add anthropic api_key
aquaman daemon
```

Troubleshooting: `aquaman doctor`

## CLI

| Command | Description |
|---------|-------------|
| `aquaman setup` | Guided onboarding (stores keys, installs plugin) |
| `aquaman doctor` | Diagnose issues with actionable fixes |
| `aquaman credentials add <svc> <key>` | Store a credential |
| `aquaman credentials list` | List stored credentials |
| `aquaman migrate openclaw --auto` | Migrate plaintext secrets to secure store |
| `aquaman daemon` | Run proxy in foreground |
| `aquaman start` | Start proxy + launch OpenClaw |
| `aquaman stop` | Stop running proxy |
| `aquaman status` | Show config and proxy status |
| `aquaman audit tail` | Recent audit entries |
| `aquaman audit verify` | Verify hash chain integrity |

## 23 Builtin Services

| Category | Services |
|----------|----------|
| **LLM / AI** | Anthropic, OpenAI, GitHub, xAI, Cloudflare AI Gateway |
| **Header** | Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, ElevenLabs, Zalo |
| **URL-path** | Telegram |
| **HTTP Basic** | Twilio, BlueBubbles, Nextcloud Talk |
| **OAuth** | MS Teams, Feishu, Google Chat |
| **At-rest only** | Nostr, Tlon |

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for architecture, credential backends, Docker deployment, and configuration.

## License

MIT
