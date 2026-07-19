# aquaman-plugin: API Key Protection for OpenClaw

The [aquaman](https://github.com/tech4242/aquaman) adapter for the [OpenClaw Gateway](https://openclaw.ai). Your API keys and tokens stay in your vault. The agent never sees them. Even a compromised agent can't steal credentials - they live in a separate process.

This plugin **spawns** [`aquaman-proxy`](https://www.npmjs.com/package/aquaman-proxy) (exact-pinned, same author) on Gateway startup, routes channel traffic through a UDS to that proxy, and lets you reach the same vault and policy engine from inside OpenClaw.

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
└──────────────────────┘              └──┬──────────┬────────┘
                                         │          │
                                         │          ▼
                                         │  ~/.aquaman/audit/
                                         │  (hash-chained log)
                                         ▼
                               api.anthropic.com / api.mistral.ai /
                               api.telegram.org / slack.com/api  …
```

## What it does

1. **Bring your own vault**: aquaman has no house vault; secrets stay in the store you already run: Keychain, 1Password, HashiCorp Vault, Bitwarden, KeePassXC, systemd-creds, or encrypted-file.
2. **Agent gets a proxy URL**: requests route through `~/.aquaman/proxy.sock` (UDS, `chmod 0o600`); the proxy injects auth headers on the fly.
3. **Dangerous endpoints blocked**: request policies deny admin APIs, prevent deletions, block sends - *before* credentials are even injected.
4. **Tamper-evident audit log**: every credential use logged with SHA-256 hash chains.

## Quick Start

```bash
openclaw plugins install aquaman-plugin           # 1. install plugin + proxy
openclaw aquaman setup                            # 2. store your API keys, wire up plugin
openclaw                                          # 3. done - proxy starts automatically
```

The `aquaman-proxy` binary is bundled as an exact-pinned npm dependency - no separate download or install needed.

> **Using npm directly?** `npm install -g aquaman-proxy && aquaman openclaw setup` does the same thing - installs the proxy CLI, stores your keys, installs the plugin into `~/.openclaw/extensions/aquaman-plugin/`, and wires the credentials (SecretRef refs on OpenClaw ≥ 2026.6.5, the auth-profiles.json placeholder on older versions).

Troubleshooting: `openclaw aquaman doctor` (or `aquaman openclaw doctor` from a regular shell).

## Security model

Aquaman keeps API credentials out of the agent process by running them in a separate proxy process. The agent never sees the secret - only a sentinel base URL that the proxy intercepts, authenticates, and forwards. See the [architecture diagram in the main README](https://github.com/tech4242/aquaman#how-it-works).

**Proxy process**

- The plugin spawns the `aquaman` binary from the `aquaman-proxy` npm package, declared as an exact-pinned dependency (no semver range) and published by the same author (`tech4242`). After spawn, the plugin checks the running proxy's reported version against its own and logs a warning if they disagree.
- The spawn (`aquaman openclaw plugin-mode`) is what triggers the `dangerous-exec` finding in OpenClaw's static scanner. It's intentional and is the whole point of the plugin.

**HTTP interceptor scope**

- Only services listed in the plugin's `services` config get their traffic redirected to the local proxy. As of v0.11.4, the interceptor filters its known-host map by your `services` list. Channels you didn't opt into keep talking to the upstream directly.
- The interceptor uses a Unix Domain Socket (no TCP, no network exposure). UDS file permissions are `chmod 0o600`, enforced explicitly at proxy startup (v0.12.0+).

**Credential wiring — SecretRef (v0.14.0+, OpenClaw ≥ 2026.6.5)**

- On current OpenClaw, `aquaman openclaw setup` wires the plugin through OpenClaw's canonical **SecretRef** credential surface: the manifest declares an exec resolver (`secretProviderIntegrations.aquaman` → `dist/secrets-resolver.mjs`) and `openclaw.json` gets `models.providers.<svc>.apiKey` refs pointing at it. The resolver returns a static placeholder — real keys stay in your vault; the proxy strips the placeholder and injects the real credential per request.
- No `openclaw doctor --fix` import step, and the wiring survives OpenClaw's plaintext-scrub flows (`openclaw secrets configure --apply`). `aquaman openclaw doctor` reports the wiring state and suggests the upgrade on legacy installs.

**Auth profiles (legacy path, OpenClaw < 2026.6.5)**

- On load the plugin writes `~/.openclaw/agents/<id>/agent/auth-profiles.json` with placeholder API-key entries for `anthropic` and `openai` so OpenClaw doesn't reject requests before they reach the proxy. The proxy strips the placeholder and injects the real credential. Skipped automatically when the SecretRef wiring is present.
- The plugin never overwrites an existing `auth-profiles.json`. To suppress generation entirely, set `autoGenerateAuthProfiles: false` in the plugin config (v0.11.4+).
- **OpenClaw ≥ 2026.6.5 without SecretRef wiring:** provider auth profiles moved into each agent's `openclaw-agent.sqlite` and the runtime read path for `auth-profiles.json` was removed ([openclaw/openclaw#89102](https://github.com/openclaw/openclaw/pull/89102)). The placeholder must be imported into SQLite once with `openclaw doctor --fix` — or better, re-run `aquaman openclaw setup` to get the SecretRef wiring. Run `aquaman openclaw doctor`; it detects the state and prints the exact remediation.

**Audit log**

- Every credential use is recorded in `~/.aquaman/audit/current.jsonl` with a SHA-256 hash chain so tampering is detectable. The log stays local - no telemetry.
- `aquaman openclaw doctor` surfaces audit log issues; `aquaman audit tail` shows recent entries.
- Operators can constrain which upstream endpoints get proxied (and therefore credentialed) via the `policy` config in `~/.aquaman/config.yaml`. Denied requests return 403 before any credential is injected.

### Scanner findings

`openclaw security audit --deep` reports two expected findings:

- **`dangerous-exec`** on the proxy-manager module: the plugin spawns the proxy as a separate process. This is how credential isolation works.
- **`tools_reachable_permissive_policy`**: advisory about your tool policy, not an aquaman vulnerability. Set `"tools": { "profile": "coding" }` in `openclaw.json` if your agents handle untrusted input.

ClawHub's ClawScan additionally produces a higher-level review of plugin behavior. The current scan acknowledges credential isolation, proxy spawn, the host map, the auth-profiles generation, and the audit log. See the publisher note on the package page for context on each item.

`aquaman openclaw setup` adds the plugin to `plugins.allow` automatically so OpenClaw knows you trust it.

## Available commands

All commands work via OpenClaw CLI or your terminal:

| OpenClaw CLI | Terminal | Description |
|---|---|---|
| `openclaw aquaman setup` | `aquaman openclaw setup` | OpenClaw bundle - vault wizard + plugin install + auth-profiles |
| `openclaw aquaman doctor` | `aquaman openclaw doctor` | Deep diagnostic for the OpenClaw integration |
| `openclaw aquaman credentials list` | `aquaman credentials list` | List stored credentials |
| `openclaw aquaman credentials add` | `aquaman credentials add` | Add a credential (interactive) |
| `openclaw aquaman policy-list` | `aquaman policy list` | Show request policy rules |
| `openclaw aquaman audit-tail` | `aquaman audit tail` | Recent audit entries |
| `openclaw aquaman services-list` | `aquaman services list` | List configured services |
| `openclaw aquaman status` | `aquaman openclaw status` | Plugin lifecycle + sentinel env vars |

Slash commands in chat: `/aquaman-status`, `/aquaman list`, `/aquaman doctor`.

## Config options

`aquaman openclaw setup` writes these to `~/.openclaw/openclaw.json` automatically:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` \| `"keepassxc"` \| `"systemd-creds"` \| `"bitwarden"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy (also gates which hostnames the interceptor redirects, v0.11.4+) |
| `autoGenerateAuthProfiles` | `boolean` | `true` | Auto-generate `auth-profiles.json` with placeholder anthropic/openai entries when the file is absent. Set `false` to manage your own (v0.11.4+) |

Advanced settings (audit, vault, request policies) go in `~/.aquaman/config.yaml`. See the [request policy docs](https://github.com/tech4242/aquaman#request-policies).

## Documentation

- **[Root README](https://github.com/tech4242/aquaman#readme)**: value prop, three-path Quick Start, security model
- **[`aquaman-proxy`](../proxy)**: core CLI and daemon
- **[`aquaman-coder`](../coder)**: coding-agent adapter (Claude Code, Codex/OpenCode/Cursor planned)

## License

MIT
