# Keep provider keys out of the Hermes agent process

Hermes reads provider keys from its environment. With aquaman, Hermes is pointed at a local proxy and given a placeholder; the proxy injects the real key from your vault, so the key is never in the Hermes process.

```bash
npm install -g aquaman-proxy
aquaman setup                              # 1. pick your vault
aquaman credentials add anthropic api_key  # 2. store a provider key
aquaman hermes setup                       # 3. enable the local listener, point Hermes at it
aquaman daemon &                           # 4. start the proxy
aquaman hermes doctor                      # 5. verify
```

## Anthropic and OpenAI

The two providers are set up the same way. Store the key for each one you use:

```bash
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key
```

`aquaman hermes setup` then stores six settings in Hermes by running `hermes config set` for each one. Hermes writes them into its own `.env` (`~/.hermes/.env`, or under `$HERMES_HOME`); aquaman does not edit that file. `aquaman hermes setup --dry-run` prints the settings and stores nothing:

```bash
AQUAMAN_LOOPBACK_URL=http://127.0.0.1:8585
AQUAMAN_LOOPBACK_TOKEN=aqm_lb_...
ANTHROPIC_BASE_URL=http://127.0.0.1:8585/anthropic
ANTHROPIC_API_KEY=aqm_lb_...
OPENAI_BASE_URL=http://127.0.0.1:8585/openai/v1
OPENAI_API_KEY=aqm_lb_...
```

- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set to the listener's access token, not to a key. The token only lets a local process use the proxy. The proxy removes it and adds the real key from your vault.
- The OpenAI base URL ends in `/openai/v1` because the OpenAI client appends `/chat/completions` to it. The Anthropic one ends in `/anthropic` because the Anthropic client appends `/v1/messages`.
- Both pairs are set when both services are in `credentials.proxiedServices` in `~/.aquaman/config.yaml`, which they are by default. A provider whose key is not in the vault answers 401 with the command that adds it.
- Which provider and model Hermes uses is still set in Hermes' own configuration. aquaman sets the base URL and the key variable and nothing else.
- A key that is already an item in your password manager can be linked instead of typed: `aquaman credentials link openai/api_key '<locator>'`, approved by you in a dialog ([locator forms](agent-setup.md#an-item-that-is-already-in-the-vault)).

If the file already holds a real key in `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, setup stops before it changes anything in Hermes, because `hermes config set` would replace that line. Put the key in the vault (`aquaman credentials add openai api_key`), then run `aquaman hermes setup --replace-keys`.

## Profiles and Hermes versions

- **A named profile:** `aquaman hermes setup --profile <name>` runs `hermes -p <name> config set ...`, so the settings land in that profile's `.env`. Without the flag they go to the profile Hermes itself selects: the default one, or the one made active with `hermes profile use`. `status`, `doctor` and `configure` take the same flag. Set up each profile that should use the proxy.
- **Hermes 0.21.4 or later** is needed for setup to store the settings. An earlier Hermes puts the base URLs in `config.yaml` instead of `.env` when asked through `hermes config set`, so setup runs nothing there and tells you to add the lines that `aquaman hermes configure` prints to the `.env` yourself.
- **Without Hermes installed** setup turns the listener on and stores nothing in Hermes. Run it again once Hermes is there.
- **File permissions:** Hermes creates its `.env` readable by you only and keeps the permissions of one that already exists. If other users of the machine can read it, setup says so and `aquaman hermes doctor` fails until you run `chmod 600` on it.
- **What was run:** setup against Hermes 0.23.1 (the settings stored in the default and in a named profile and read back from the file, a real key left alone) and against Hermes 0.19.0 (nothing run). CI repeats both on every change.

## On Linux

`aquaman setup` picks the vault, in this order:

| Vault | Picked when | What it needs |
|---|---|---|
| `keychain` (the Secret Service keyring: GNOME Keyring, KWallet) | `pkg-config` finds `libsecret-1` | The libsecret development package (`libsecret-1-dev` on Debian and Ubuntu) and a keyring that is running and unlocked in your session. A machine without a desktop session may have none |
| `systemd-creds` | Otherwise, when `systemd-creds --version` reports systemd 256 or later | Nothing else, and no root: it uses `systemd-creds --user` with your per-user credential key, and a TPM2 when the machine has one. Credentials are files in `~/.aquaman/creds.d/` |
| `encrypted-file` | Otherwise | A password of 12 characters or more in `AQUAMAN_ENCRYPTION_PASSWORD`, set where `aquaman daemon` starts. The vault is one AES-256-GCM file |

`aquaman setup --backend <name>` chooses one yourself; `1password`, `bitwarden`, `vault`, `keepassxc` and `keeper` work on Linux as on macOS.

- **Linking an existing item** works with the keyring (`keychain://<service>/<account>`), 1Password (`op://...`), Bitwarden (`bw://...`), HashiCorp Vault (`vault://<mount>/<path>#<field>`), KeePassXC and Keeper. `systemd-creds` and `encrypted-file` hold only what aquaman wrote, so with those you add the key with `aquaman credentials add`.
- **Starting at login:** `aquaman service install` adds a systemd user unit. It is refused with `encrypted-file`, because the password would have to be stored on disk. On a machine nobody logs in to, the unit starts at boot only with `loginctl enable-linger <user>`, which aquaman reports and does not run. Details: [Start the aquaman daemon at login](autostart.md).
- **After rotating a key** stored with `systemd-creds`, restart the daemon: it keeps the value it read.

## Inside Hermes

Optional: a `/aquaman-status` command, an `aquaman_status` tool and a secret source for project secrets.

```bash
pip install aquaman-hermes        # or: uv tool install aquaman-hermes
aquaman-hermes install
hermes plugins enable aquaman
```

## Project secrets

Bind them in Hermes' `config.yaml` (`~/.hermes/config.yaml`, or `$HERMES_HOME/config.yaml`):

```yaml
secrets:
  aquaman:
    env:
      GITHUB_TOKEN: aquaman://github/token
```

Store or link the secret (`aquaman credentials add github token`) and declare each reference with `aquaman broker allow aquaman://github/token`. `aquaman hermes doctor` lists bindings that are not declared. These values do enter Hermes' environment; provider keys do not, and the secret source refuses to hand those out. This needs the `aquaman-hermes` plugin above and Hermes 0.18.1 or later.

## If you are an agent

- **Hand the setup to the person.** `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden) and `aquaman daemon` stays running. Give them the commands above; never ask for a key in the conversation.
- **You may run `aquaman hermes doctor`** and report what it says. It checks and changes nothing.
- **Where each credential ends up:** provider keys (Anthropic, OpenAI) are never in the Hermes process. A project secret bound through the secret source, such as a GitHub token, is in Hermes' environment: it is stored in the vault and each read is audited, but it is not isolated from Hermes or its tools.
- **Setup does not replace a real key in Hermes' `.env` by itself.** It stops and names the variable. The person stores the key in the vault and runs `aquaman hermes setup --replace-keys`, and rotates the key if anything they do not trust could have read the file.
- **The daemon does not come back by itself.** `aquaman daemon` is gone after a reboot or logout, and Hermes' provider calls fail until the person starts it again. Tell them. `aquaman service install` makes it start at every login: [Start the aquaman daemon at login](autostart.md).

## Good to know

- The listener is on `127.0.0.1`, off until `aquaman hermes setup`, and every request must carry a per-install token.
- A managed `/etc/hermes/.env` overrides `~/.hermes/.env` and bypasses the proxy; `aquaman hermes doctor` detects it.
- With `gateway.multiplex_profiles`, set up each profile: `aquaman hermes setup --profile <name>`.
- The plugin sends requests to `127.0.0.1`, `localhost` or `::1` only. A base URL or `AQUAMAN_LOOPBACK_URL` that names any other host is refused, no redirect is followed and proxy variables are not used.
- The plugin runs under `plugins.isolation: host` (checked with `hermes plugins validate` on Hermes 0.23.1).

More: [aquaman-hermes README](../packages/hermes/README.md)
