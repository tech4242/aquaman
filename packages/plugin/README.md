# aquaman-plugin

OpenClaw Gateway plugin for [aquaman](https://github.com/tech4242/aquaman) credential isolation.

## What This Is

`aquaman-plugin` integrates aquaman's credential isolation proxy with the OpenClaw Gateway. When loaded, it routes all LLM and channel API traffic through the aquaman proxy so credentials never enter the Gateway process.

## Installation

```bash
openclaw plugins install aquaman-plugin
npm install -g aquaman-proxy
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "aquaman-plugin": {
        "enabled": true,
        "config": {
          "mode": "proxy",
          "backend": "keychain",
          "services": ["anthropic", "openai"],
          "proxyPort": 8081
        }
      }
    }
  }
}
```

### Config Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | `"embedded"` \| `"proxy"` | `"embedded"` | Isolation mode |
| `backend` | `"keychain"` \| `"1password"` \| `"vault"` \| `"encrypted-file"` | `"keychain"` | Credential store |
| `services` | `string[]` | `["anthropic", "openai"]` | Services to proxy |
| `proxyPort` | `number` | `8081` | Proxy listen port |

> Advanced settings (TLS, audit, vault) are configured in `~/.aquaman/config.yaml`.

## Setup

**1. Add credentials:**

```bash
aquaman credentials add anthropic api_key
```

**2. Register a placeholder key with OpenClaw:**

```bash
mkdir -p ~/.openclaw/agents/main/agent
cat > ~/.openclaw/agents/main/agent/auth-profiles.json << 'EOF'
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "api_key",
      "provider": "anthropic",
      "key": "aquaman-proxy-managed"
    }
  },
  "order": { "anthropic": ["anthropic:default"] }
}
EOF
```

**3. Launch OpenClaw:**

```bash
openclaw
```

The plugin auto-starts the proxy, sets `ANTHROPIC_BASE_URL` to route through it, and intercepts channel API traffic via `globalThis.fetch`.

## How It Works

- **Proxy mode** — Spawns aquaman as a child process. Credentials live in a separate OS process. Even if the agent is compromised, it cannot access keys.
- **Embedded mode** — Credentials loaded in-process. Simpler setup, less isolation. Good for local development.

## Documentation

See the [main README](https://github.com/tech4242/aquaman#readme) for full documentation, architecture details, and manual testing steps.

## License

MIT
