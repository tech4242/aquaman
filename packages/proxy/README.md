# aquaman-proxy

Credential isolation proxy and CLI for [aquaman](https://github.com/tech4242/aquaman).

## How It Works

```
Agent / OpenClaw Gateway              Aquaman Proxy
┌──────────────────────┐              ┌──────────────────────┐
│                      │              │                      │
│  ANTHROPIC_BASE_URL  │══ Unix ════>│  Keychain / 1Pass /  │
│  = aquaman.local     │   Domain    │  Vault / Encrypted   │
│                      │<═ Socket ═══│                      │
│  fetch() interceptor │══ (UDS) ══=>│  + Auth injected:    │
│  redirects channel   │              │    header / url-path │
│  API traffic         │              │    basic / oauth     │
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
                               api.telegram.org
                               slack.com/api  ...
```

This package is the right side. A reverse proxy that listens on a Unix domain socket (`~/.aquaman/proxy.sock`) and injects credentials from secure backends. No TCP port, no network exposure. 23 builtin services, four auth modes.

## Quick Start

With OpenClaw:

```bash
npm install -g aquaman-proxy              # install the proxy CLI
aquaman setup                             # stores keys, installs plugin, configures OpenClaw
openclaw                                  # proxy starts automatically via plugin
```

> `aquaman setup` auto-detects your credential backend. macOS defaults to Keychain,
> Linux defaults to encrypted file. Override with `--backend`:
> `aquaman setup --backend keepassxc`
> Options: `keychain`, `encrypted-file`, `keepassxc`, `1password`, `vault`

Existing plaintext credentials are migrated automatically during setup.
Run again anytime to migrate new credentials: `aquaman migrate openclaw --auto`

Standalone:

```bash
npm install -g aquaman-proxy
aquaman init
aquaman credentials add anthropic api_key
aquaman daemon                               # listens on ~/.aquaman/proxy.sock
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
