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

## If you are an agent

- **Hand the setup to the person.** `openclaw aquaman setup` asks which vault to use and takes the keys from them. Give them the three commands above; never ask for a key in the conversation.
- **You may run `aquaman openclaw doctor`** and report what it says. It checks and changes nothing.
- **Where each credential ends up:** model provider keys and the Telegram bot token are not in the gateway process, its config or its environment. Tokens for other channels are stored in the vault and used by the gateway directly.
- **What a plugin in the gateway can still do:** it runs as the user, so it can send requests through the proxy. Those requests are limited by the request policies and each one is in the audit log. It cannot read the routed keys from the gateway. aquaman is not a sandbox: for a harder boundary the gateway runs as a different OS user or in a sandbox.
- **Keys that were in `openclaw.json` or exported before setup** were readable by everything in the gateway until then. If the person is worried about a plugin that has already run, they rotate those keys at the provider.

## Good to know

- **Other channels** (Discord, Slack, Matrix and so on) are stored in the vault but not routed: their traffic goes straight from the gateway, with the token in the gateway process. `aquaman openclaw doctor` lists which are which.
- **Do not leave provider keys exported** where OpenClaw runs. An exported `OPENAI_API_KEY` wins over the configured reference, so the key is back in the gateway and the proxy answers 401.
- **OpenClaw 2026.11 and later** prints "can't verify where this plugin came from" for the plugin and `openclaw plugins doctor` exits 1. The plugin still loads and routes traffic.
- Request policies can deny specific endpoints (for example admin APIs) before a key is ever injected: `aquaman policy list`.

More: [aquaman-plugin README](../packages/plugin/README.md)
