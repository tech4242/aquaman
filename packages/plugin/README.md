# aquaman-plugin

OpenClaw Gateway plugin for [aquaman](https://github.com/tech4242/aquaman) — credential isolation for OpenClaw.

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

This plugin is the left side — it runs inside the Gateway process and routes all LLM and channel API traffic through the aquaman proxy via Unix domain socket. Credentials never enter the agent's address space.

**What it does on load:**
1. Sets `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` to `http://aquaman.local/<service>` (routed to UDS)
2. Spawns the proxy daemon via `ProxyManager`
3. Activates a `globalThis.fetch` interceptor to redirect channel API traffic through the proxy
4. Registers `/aquaman-status` command and `aquaman_status` tool

## Quick Start

```bash
npm install -g aquaman-proxy
aquaman setup                   # stores keys, installs this plugin, applies policy defaults
openclaw                        # proxy starts automatically
```

> **We recommend `aquaman setup`** — it does more than just install the plugin: it stores credentials,
> configures your backend, writes `openclaw.json`, and generates auth profiles. If you prefer to install
> the plugin directly: `openclaw plugins install aquaman-plugin` (on OpenClaw 2026.3.22+, this checks
> [ClawHub](https://clawhub.ai) first, then falls back to npm).

Troubleshooting: `aquaman doctor`

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

See the [main README](https://github.com/tech4242/aquaman#readme) for the full security model, architecture diagrams, and manual testing guides.

## License

MIT
