# aquaman-plugin

OpenClaw Gateway plugin for [aquaman](https://github.com/tech4242/aquaman) credential isolation.

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

This plugin makes the left side work. It routes all LLM and channel API traffic through the aquaman proxy via Unix domain socket so credentials never enter the Gateway process. No TCP port is opened — traffic flows through `~/.aquaman/proxy.sock`.

## Quick Start

```bash
npm install -g aquaman-proxy              # install the proxy CLI
aquaman setup                             # stores keys, installs plugin, configures OpenClaw
openclaw                                  # proxy starts automatically
```

> `aquaman setup` auto-detects your credential backend. macOS defaults to Keychain,
> Linux defaults to encrypted file. Override with `--backend`:
> `aquaman setup --backend keepassxc`
> Options: `keychain`, `encrypted-file`, `keepassxc`, `1password`, `vault`

Existing plaintext credentials are migrated automatically during setup.
Run again anytime to migrate new credentials: `aquaman migrate openclaw --auto`

Troubleshooting: `aquaman doctor`

## Config Options

`aquaman setup` writes these to `~/.openclaw/openclaw.json` automatically:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` \| `"keepassxc"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy |

> Advanced settings (audit, vault) go in `~/.aquaman/config.yaml`.

## Security Audit Note

Running `openclaw security audit --deep` will show a `dangerous-exec` finding for this plugin. That's expected — the plugin spawns the aquaman proxy as a separate process, which is the whole point of credential isolation. `aquaman setup` adds the plugin to your `plugins.allow` trust list automatically.

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for architecture, Docker deployment, and manual testing.

## License

MIT
