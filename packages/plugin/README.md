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

## Security model

Aquaman keeps API credentials out of the agent process by running them in a separate proxy process. The agent never sees the secret — only a sentinel base URL that the proxy intercepts, authenticates, and forwards. See the [architecture diagram in the main README](https://github.com/tech4242/aquaman#architecture-decision-isolation-vs-detection).

**Proxy process**

- The plugin spawns the `aquaman` binary from the `aquaman-proxy` npm package, which is declared as an exact-pinned dependency (no semver range) in the plugin's `package.json` and published by the same author. After spawn the plugin checks the running proxy's reported version against the plugin's own and warns if they disagree.
- The spawn is what triggers the `dangerous-exec` finding in OpenClaw's static scanner — it's intentional and is the whole point of the plugin.

**HTTP interceptor**

- Only services listed in the plugin's `services` config get their traffic redirected to the local proxy. As of v0.11.4, the interceptor filters its known-host map by your `services` list — channels you didn't opt into keep talking to the upstream directly.
- The interceptor uses a Unix Domain Socket (no TCP, no network exposure).

**Auth profiles**

- On load the plugin writes `~/.openclaw/agents/<id>/agent/auth-profiles.json` with placeholder API-key entries for `anthropic` and `openai` so OpenClaw doesn't reject requests before they reach the proxy. The proxy strips the placeholder and injects the real credential.
- The plugin never overwrites an existing `auth-profiles.json`. To suppress the generation entirely, set `autoGenerateAuthProfiles: false` in the plugin config (v0.11.4+).

**Audit log**

- Every credential use is recorded in `~/.aquaman/audit/current.jsonl` with a SHA-256 hash chain so tampering is detectable. The log stays local — no telemetry.
- `aquaman doctor` surfaces audit log issues; `aquaman audit tail` shows recent entries.
- Operators can constrain which upstream endpoints get proxied (and therefore credentialed) via the `policy` config in `~/.aquaman/config.yaml`. Denied requests return 403 before any credential is injected.

### Scanner findings

`openclaw security audit --deep` reports two expected findings:

- **`dangerous-exec`** on the proxy-manager module — the plugin spawns the proxy as a separate process. This is how credential isolation works.
- **`tools_reachable_permissive_policy`** — advisory about your tool policy, not an aquaman vulnerability. Set `"tools": { "profile": "coding" }` in `openclaw.json` if your agents handle untrusted input.

ClawHub's ClawScan additionally produces a higher-level review of plugin behavior. The current scan acknowledges credential isolation, proxy spawn, the host map, the auth-profiles generation, and the audit log — see the publisher note on the package page for context on each item.

`aquaman setup` adds the plugin to `plugins.allow` automatically.

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
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy (also gates which hostnames the interceptor redirects, v0.11.4+) |
| `autoGenerateAuthProfiles` | `boolean` | `true` | Auto-generate `auth-profiles.json` with placeholder anthropic/openai entries when the file is absent. Set `false` to manage your own (v0.11.4+) |

> Advanced settings (audit, vault, request policies) go in `~/.aquaman/config.yaml`. See [request policy docs](https://github.com/tech4242/aquaman#request-policies).

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for the full security model, architecture diagrams, request policy config, and manual testing guides.

## License

MIT
