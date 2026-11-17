# Keep provider keys out of the Hermes agent process

Hermes reads provider keys from its environment. With aquaman, Hermes is pointed at a local proxy and given a placeholder; the proxy injects the real key from your vault, so the key is never in the Hermes process.

```bash
npm install -g aquaman-proxy
aquaman setup                              # 1. pick your vault
aquaman credentials add anthropic api_key  # 2. store a provider key
aquaman hermes setup                       # 3. enable the local listener, write ~/.hermes/.env
aquaman daemon &                           # 4. start the proxy
aquaman hermes doctor                      # 5. verify
```

Optional, inside Hermes: a `/aquaman-status` command, an `aquaman_status` tool and a secret source for project secrets.

```bash
pip install aquaman-hermes        # or: uv tool install aquaman-hermes
aquaman-hermes install
hermes plugins enable aquaman
```

## Project secrets

Bind them in Hermes' `config.yaml` under `secrets.aquaman.env`, for example `GITHUB_TOKEN: aquaman://github/token`, and declare each one with `aquaman broker allow aquaman://github/token`. These values do enter Hermes' environment; provider keys do not, and the secret source refuses to hand those out.

## If you are an agent

- **Hand the setup to the person.** `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden) and `aquaman daemon` stays running. Give them the commands above; never ask for a key in the conversation.
- **You may run `aquaman hermes doctor`** and report what it says. It checks and changes nothing.
- **Where each credential ends up:** provider keys (Anthropic, OpenAI) are never in the Hermes process. A project secret bound through the secret source, such as a GitHub token, is in Hermes' environment: it is stored in the vault and each read is audited, but it is not isolated from Hermes or its tools.
- **Keys that were already in `~/.hermes/.env` are not removed by setup.** The person deletes those lines, and rotates the keys if anything they do not trust could have read the file.
- **The daemon does not come back by itself.** `aquaman daemon` is gone after a reboot or logout, and Hermes' provider calls fail until the person starts it again. Tell them.

## Good to know

- The listener is on `127.0.0.1`, off until `aquaman hermes setup`, and every request must carry a per-install token.
- A managed `/etc/hermes/.env` overrides `~/.hermes/.env` and bypasses the proxy; `aquaman hermes doctor` detects it.
- With `gateway.multiplex_profiles`, each profile needs the aquaman block.
- The plugin runs under `plugins.isolation: host` (checked with `hermes plugins validate` on Hermes 0.23.1).

More: [aquaman-hermes README](../packages/hermes/README.md)
