# aquaman-proxy

Credential isolation proxy daemon and CLI for [aquaman](https://github.com/tech4242/aquaman).

## What This Is

`aquaman-proxy` is a reverse proxy that intercepts API requests and injects credentials from secure backends. The agent process never sees the actual API keys.

Supports 21 services out of the box with four auth modes: header injection, URL-path rewriting, HTTP Basic, and OAuth client credentials.

## Installation

```bash
npm install -g aquaman-proxy
```

## Quick Start

```bash
aquaman init                              # Create config + generate TLS certs
aquaman credentials add anthropic api_key # Store credential in vault
aquaman start                             # Start proxy + launch OpenClaw
```

## CLI Reference

**Credentials**
```
aquaman credentials add <service> <key>       Add a credential
aquaman credentials list                      List stored credentials
aquaman credentials delete <service> <key>    Remove a credential
```

**Proxy**
```
aquaman start [--workspace <path>]            Start proxy + launch OpenClaw
aquaman daemon                                Run proxy in foreground
aquaman stop                                  Stop running daemon
aquaman status                                Show config and proxy status
```

**Audit**
```
aquaman audit tail [-n <count>]               Recent audit entries
aquaman audit verify                          Verify hash chain integrity
aquaman audit rotate                          Archive and rotate log
```

**Migration**
```
aquaman migrate openclaw [--config <path>]    Migrate channel creds from openclaw.json
                         [--dry-run]          to secure store
                         [--overwrite]
```

**Setup & Services**
```
aquaman init [--force] [--no-tls]             Initialize config + TLS certs
aquaman configure [--method env|dotenv|shell-rc]  Generate env config
aquaman services list [--builtin] [--custom]  List configured services
aquaman services validate                     Validate services.yaml
```

## Supported Services

| Category | Services |
|----------|----------|
| **LLM / AI** | Anthropic, OpenAI, GitHub |
| **Header auth** | Slack, Discord, Matrix, Mattermost, LINE, Twitch, Telnyx, ElevenLabs, Zalo |
| **URL-path auth** | Telegram |
| **HTTP Basic auth** | Twilio, BlueBubbles, Nextcloud Talk |
| **OAuth** | MS Teams, Feishu, Google Chat |
| **At-rest storage** | Nostr, Tlon |

## Configuration

Standalone config lives at `~/.aquaman/config.yaml`:

```yaml
credentials:
  backend: keychain
  proxyPort: 8081
  proxiedServices:
    - anthropic
    - openai
  tls:
    enabled: true
    autoGenerate: true

audit:
  enabled: true
  logDir: ~/.aquaman/audit
```

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for full documentation, architecture details, and OpenClaw plugin setup.

## License

MIT
