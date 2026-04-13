# Aquaman — API Key Protection for OpenClaw

Your API keys and tokens stay in your vault. The agent never sees them.
Even a compromised agent can't steal credentials — they live in a
separate process.

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

## What It Does

1. **Secrets stay in your vault** — Keychain, 1Password, HashiCorp Vault, KeePassXC, systemd-creds, Bitwarden, or encrypted file
2. **Agent gets a proxy URL** — requests route through a local proxy that injects auth headers on the fly
3. **Dangerous endpoints blocked** — request policies deny admin APIs, prevent deletions, block sends — before credentials are even injected
4. **Tamper-evident audit log** — every credential use logged with SHA-256 hash chains

## Quick Start

```bash
openclaw plugins install aquaman-plugin   # 1. install plugin + proxy
openclaw aquaman setup                    # 2. store your API keys
openclaw                                  # 3. done — proxy starts automatically
```

The `aquaman` proxy binary is bundled as an npm dependency — no separate download or install needed.

> **Using npm?** `npm install -g aquaman-proxy && aquaman setup` does
> the same thing. Use this if you prefer managing packages with npm.

## Available Commands

All commands work via OpenClaw CLI or your terminal:

| OpenClaw CLI | Terminal | Description |
|---|---|---|
| `openclaw aquaman setup` | `aquaman setup` | Onboarding wizard — stores keys, configures backend |
| `openclaw aquaman doctor` | `aquaman doctor` | Diagnostic checks with actionable fixes |
| `openclaw aquaman credentials list` | `aquaman credentials list` | List stored credentials |
| `openclaw aquaman credentials add` | `aquaman credentials add` | Add a credential (interactive) |
| `openclaw aquaman policy-list` | `aquaman policy list` | Show request policy rules |
| `openclaw aquaman audit-tail` | `aquaman audit tail` | Recent audit entries |
| `openclaw aquaman services-list` | `aquaman services list` | List configured services |
| `openclaw aquaman status` | `aquaman status` | Proxy status |

Slash commands in chat: `/aquaman-status`, `/aquaman list`, `/aquaman doctor`

Troubleshooting: `openclaw aquaman doctor` or `aquaman doctor`

## Config Options

`aquaman setup` writes these to `~/.openclaw/openclaw.json` automatically:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` \| `"keepassxc"` \| `"systemd-creds"` \| `"bitwarden"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy |

> Advanced settings (audit, vault, request policies) go in `~/.aquaman/config.yaml`. See [request policy docs](https://github.com/tech4242/aquaman#request-policies).

## Security Audit

`openclaw security audit --deep` reports two expected findings:

- **`dangerous-exec`** on `proxy-manager.ts` — the plugin spawns the proxy as a separate process. This is how credential isolation works.
- **`tools_reachable_permissive_policy`** — advisory about your tool policy, not an aquaman vulnerability. Set `"tools": { "profile": "coding" }` in `openclaw.json` if your agents handle untrusted input.

`aquaman setup` adds the plugin to `plugins.allow` automatically.

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for the full security model, architecture diagrams, request policy config, and manual testing guides.

## License

MIT
