# aquaman for Hermes

Keeps LLM provider keys out of the Hermes process. The keys stay in a vault you already use (macOS Keychain, 1Password, Bitwarden, HashiCorp Vault, KeePassXC and others), and a local proxy adds them to model requests on the way out. Hermes holds a local token, not the key.

The work is done by the **aquaman proxy**, a separate local daemon that is not a Hermes plugin. This plugin is the part that runs inside Hermes.

## What the plugin adds

- **A secret source named `aquaman`.** Project secrets bound under `secrets.aquaman.env` in Hermes' `config.yaml` are read from your vault at startup, through the proxy.
- **`/aquaman-status`**, a command that shows whether the proxy is reachable and how Hermes is wired to it.
- **`aquaman_status`**, a tool with the same information for the agent.
- **A check at session start** that says so when the proxy is not running.

## Set up

Install the proxy and point Hermes at it. These commands are yours to run: one asks for the key, hidden, and one stays running.

```bash
npm install -g aquaman-proxy
aquaman setup                              # pick your vault
aquaman credentials add anthropic api_key  # or: openai api_key
aquaman hermes setup                       # turns on the local listener, writes ~/.hermes/.env
aquaman daemon &                           # start the proxy
aquaman hermes doctor                      # verify
```

Then install and enable this plugin in Hermes. From the Hermes plugin catalog, install it by name there. From PyPI:

```bash
pip install aquaman-hermes        # or: uv tool install aquaman-hermes
aquaman-hermes install
hermes plugins enable aquaman
```

## Project secrets

Bind them in `~/.hermes/config.yaml` (or `$HERMES_HOME/config.yaml`):

```yaml
secrets:
  aquaman:
    env:
      GITHUB_TOKEN: aquaman://github/token
```

Store the secret and declare the reference to the proxy:

```bash
aquaman credentials add github token
aquaman broker allow aquaman://github/token
```

`aquaman hermes doctor` lists bindings that are not declared.

## What the plugin does and does not do

- It makes HTTP requests to the aquaman proxy on `127.0.0.1` and nowhere else. The address and a per-install token come from `AQUAMAN_LOOPBACK_URL` and `AQUAMAN_LOOPBACK_TOKEN`, which `aquaman hermes setup` writes.
- It reads no credential store, no `.env` file and no other tool's login. The proxy reads the vault.
- It runs no shell commands, starts no process, stores nothing and sends no telemetry.
- It never prompts. If the proxy is not running, Hermes starts as usual and the plugin says what is missing.

## Good to know

- **Provider keys and project secrets are treated differently.** Anthropic and OpenAI keys are never in the Hermes process, and the secret source refuses to hand them out. A project secret bound through the secret source is in Hermes' environment, as with any secret source.
- **The proxy has to be running.** `aquaman daemon` is gone after a reboot or logout; `aquaman service install` makes it start at login.
- **A managed `/etc/hermes/.env`** overrides `~/.hermes/.env` and bypasses the proxy. `aquaman hermes doctor` detects it.
- **With `gateway.multiplex_profiles`** each profile needs the aquaman block that `aquaman hermes setup` writes.
- Keys that were already in `~/.hermes/.env` are not removed by setup. Delete those lines yourself, and rotate the keys if anything you do not trust could have read the file.

Full guide: [aquaman.sh/docs/hermes](https://aquaman.sh/docs/hermes/). Source, security policy and advisories: [github.com/tech4242/aquaman](https://github.com/tech4242/aquaman). Apache-2.0.
