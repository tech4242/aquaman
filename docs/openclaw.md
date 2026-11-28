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
- For Telegram, `channels.telegram.apiRoot` points at the proxy and `botToken` becomes a SecretRef too, so neither your bot token nor the local token is written in `openclaw.json`.

aquaman does not write `openclaw.json`. It works out these changes and hands them to OpenClaw as one patch (`openclaw config patch --stdin`), so OpenClaw validates the result, keeps its backups and, when a Gateway is running, applies the change itself.

## Model providers, step by step

Two model providers are routed: **Anthropic and OpenAI**. Setup asks for each key with hidden input (press Enter to skip one), stores it in your vault as `anthropic/api_key` or `openai/api_key`, and on OpenClaw 2026.6.5 or later has OpenClaw set this in `~/.openclaw/openclaw.json`, for the providers whose key you entered (for both when you entered none in this run):

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

The rest of the file is OpenClaw's to keep. The port is 8585 unless `loopback.port` in `~/.aquaman/config.yaml` says otherwise.

**When setup does not change the config.** In each of these cases nothing in `openclaw.json` is touched, the change is saved as `~/.aquaman/openclaw-setup.patch.json` (it holds references, no secret), and setup prints the command that applies it, `openclaw config patch --file <path>`:

- the `openclaw` program is not on the PATH;
- `OPENCLAW_CONFIG_READONLY=1` or `OPENCLAW_NIX_MODE=1` is set (put the patch into the source your deployment builds the config from);
- the config uses `$include`: setup reads only the root file, so check the patch against the included files first. Routing also needs the config in one file: see below.

If OpenClaw refuses the patch, setup exits 1 with what OpenClaw said. To decide what to change, setup reads `openclaw.json` as strict JSON. A file with comments or trailing commas stops it, and the file is left as it is.

**The plugin reads the same file.** OpenClaw sends a key to whatever endpoint the config names, so aquaman's plugin answers a key reference with the local proxy token only when it reads `openclaw.json` and sees the proxy as that reference's endpoint. A config it cannot read whole (comments, trailing commas, `$include`, or no file where it looks) gets a placeholder for every reference, and calls routed through the proxy then fail with 401. `aquaman openclaw doctor` reports both cases. Keep the config in one file of standard JSON, which is the form OpenClaw writes itself.

**Profiles.** `aquaman openclaw setup --profile <name>` sets up the OpenClaw profile under `~/.openclaw-<name>` and runs `openclaw --profile <name>`; `aquaman openclaw doctor --profile <name>` checks it. Without the flag, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` are honoured.

**A provider with your own `baseUrl` is left alone.** OpenClaw sends a provider's key to whatever `baseUrl` the provider has, and aquaman's key reference is answered with the local token. So setup writes the reference only together with the proxy as `baseUrl`. Where you set another `baseUrl` (a gateway of your own, a regional endpoint), setup changes nothing for that provider, says so, and removes a reference an earlier version wrote there. The plugin's resolver holds to the same rule: it answers with the token only for a reference whose endpoint in `openclaw.json` is the proxy, and with an inert placeholder otherwise.

What was run: setup against the `openclaw` program in versions 2026.6.10, 2026.10.33 and 2026.11.10 (the patch accepted, the file written by OpenClaw and owner-only, a second run changing nothing, a named profile, a read-only config left alone), and gateways 2026.6.10 and 2026.11.10 with the Telegram token as a reference against a stand-in Bot API, where the calls arrived at the configured root with the local token.

**A key that is already written in `openclaw.json` stays there, and that provider is not routed.** If `models.providers.anthropic.apiKey` holds a key as plain text, setup leaves the entry as it is and prints `Left existing user-set apiKey untouched for: anthropic`. It does not copy that key into the vault and does not remove it. To route the provider:

1. Remove the key for that provider (`openclaw config unset models.providers.anthropic.apiKey`), and its `baseUrl` if you set one: setup keeps a `baseUrl` it did not write and does not route that provider.
2. Run `openclaw aquaman setup` again and enter the key when asked. Running it again is safe: it keeps your other settings.
3. Run `aquaman openclaw doctor`. It fails with "providers not wired" or "the proxy is bypassed" while a provider is not going through the proxy.

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
