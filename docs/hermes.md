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

These commands are for a person in their own terminal: `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden), and `aquaman daemon` stays running. An agent setting up a coding project uses [`aquaman init --agent`](agent-setup.md) instead.

Optional, inside Hermes: a `/aquaman-status` command, an `aquaman_status` tool and a secret source for project secrets.

```bash
pip install aquaman-hermes        # or: uv tool install aquaman-hermes
aquaman-hermes install
hermes plugins enable aquaman
```

## Project secrets

Bind them in Hermes' `config.yaml` under `secrets.aquaman.env`, for example `GITHUB_TOKEN: aquaman://github/token`, and declare each one with `aquaman broker allow aquaman://github/token`. These values do enter Hermes' environment; provider keys do not, and the secret source refuses to hand those out.

## Good to know

- The listener is on `127.0.0.1`, off until `aquaman hermes setup`, and every request must carry a per-install token.
- A managed `/etc/hermes/.env` overrides `~/.hermes/.env` and bypasses the proxy; `aquaman hermes doctor` detects it.
- With `gateway.multiplex_profiles`, each profile needs the aquaman block.
- The plugin runs under `plugins.isolation: host` (checked with `hermes plugins validate` on Hermes 0.23.1).

More: [aquaman-hermes README](../packages/hermes/README.md)
