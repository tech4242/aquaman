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

## Model providers, step by step

Two model providers are routed: **Anthropic and OpenAI**. Setup asks for each key with hidden input (press Enter to skip one), stores it in your vault as `anthropic/api_key` or `openai/api_key`, and on OpenClaw 2026.6.5 or later writes this into `~/.openclaw/openclaw.json`, for the providers whose key you entered (for both when you entered none in this run):

```json
{
  "secrets": {
    "providers": {
      "aquaman": { "source": "exec", "pluginIntegration": { "pluginId": "aquaman-plugin", "integrationId": "aquaman" } }
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": { "source": "exec", "provider": "aquaman", "id": "anthropic/api_key" },
        "baseUrl": "http://127.0.0.1:8585/anthropic"
      },
      "openai": {
        "apiKey": { "source": "exec", "provider": "aquaman", "id": "openai/api_key" },
        "baseUrl": "http://127.0.0.1:8585/openai/v1"
      }
    }
  }
}
```

The rest of the file is kept. The port is 8585 unless `loopback.port` in `~/.aquaman/config.yaml` says otherwise. Setup reads `openclaw.json` as strict JSON, writes it back with these changes and makes no backup copy. If the file does not parse as strict JSON (comments, trailing commas), setup stops, says so and leaves the file as it is: remove the comments and trailing commas, then run it again.

**A key that is already written in `openclaw.json` stays there, and that provider is not routed.** If `models.providers.anthropic.apiKey` holds a key as plain text, setup leaves the entry as it is and prints `Left existing user-set apiKey untouched for: anthropic`. It does not copy that key into the vault and does not remove it. To route the provider:

1. Delete the `apiKey` line for that provider from `openclaw.json` (and its `baseUrl`, if you set one: setup also keeps a `baseUrl` it did not write).
2. Run `openclaw aquaman setup` again and enter the key when asked. Running it again is safe: it keeps your other settings.
3. Run `aquaman openclaw doctor`. It fails with "providers not wired" or "still call the provider directly" while a provider is not going through the proxy.

A key that sat in `openclaw.json` was readable by everything in the gateway, so rotate it at the provider if you are unsure what ran there.

**After you rotate a key**, store the new one under the same name and restart the gateway, so its proxy reads it:

```bash
aquaman credentials add anthropic api_key     # asks for the new value, hidden; replaces the old one
```

Nothing in `openclaw.json` changes: it holds the reference, not the key.

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
- **A model key that is already an item in your vault** can be linked instead of typed (`aquaman credentials link anthropic/api_key '<locator>'`, [locator forms](agent-setup.md#an-item-that-is-already-in-the-vault)). You approve a link in a dialog that `aquaman daemon` shows; the proxy the gateway starts does not show it. So stop the gateway, run `aquaman daemon`, link, stop the daemon and start the gateway again. The proxy the gateway starts then reads the linked item like any stored credential: run with aquaman 0.19.0, a link approved in the daemon's dialog was served by that proxy on the next request, with an audit entry.
- Request policies can deny specific endpoints (for example admin APIs) before a key is ever injected: `aquaman policy list`.
- **The proxy starts with the gateway**, so OpenClaw on its own needs no login item. If you run `aquaman daemon` beside it for coding agents, Hermes or Docker Sandboxes, `aquaman service install` starts that daemon at every login: [Start the aquaman daemon at login](autostart.md).

More: [aquaman-plugin README](../packages/plugin/README.md)
