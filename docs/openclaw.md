# Keep API keys out of the OpenClaw gateway process

OpenClaw runs your agents, plugins and channels in one gateway process, so a key in its config or environment is readable by anything that runs there. With aquaman the gateway holds a placeholder: model calls go to a local proxy that injects the real key from your vault.

```bash
openclaw plugins install aquaman-plugin     # 1. plugin + proxy
openclaw aquaman setup                      # 2. pick your vault, store keys, wire OpenClaw
openclaw                                    # 3. the proxy starts with the gateway
```

Using npm directly: `npm install -g aquaman-proxy && aquaman openclaw setup`.

## What setup changes

- `models.providers.<service>.baseUrl` points at a token-gated listener on `127.0.0.1`.
- `models.providers.<service>.apiKey` becomes a SecretRef resolved by the plugin to a local access token. That token only lets a local process use the proxy; it is not your API key.
- For Telegram, `channels.telegram.apiRoot` points at the proxy and the bot token is injected the same way.

## Good to know

- **Other channels** (Discord, Slack, Matrix and so on) are stored in the vault but not routed: their traffic goes straight from the gateway, with the token in the gateway process. `aquaman openclaw doctor` lists which are which.
- **Do not leave provider keys exported** where OpenClaw runs. An exported `OPENAI_API_KEY` wins over the configured reference, so the key is back in the gateway and the proxy answers 401.
- **OpenClaw 2026.11 and later** prints "can't verify where this plugin came from" for the plugin and `openclaw plugins doctor` exits 1. The plugin still loads and routes traffic.
- Request policies can deny specific endpoints (for example admin APIs) before a key is ever injected: `aquaman policy list`.

More: [aquaman-plugin README](../packages/plugin/README.md)
