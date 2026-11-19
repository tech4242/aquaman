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

## Anthropic and OpenAI

The two providers are set up the same way. Store the key for each one you use:

```bash
aquaman credentials add anthropic api_key
aquaman credentials add openai api_key
```

`aquaman hermes setup` then writes one marked block into `~/.hermes/.env` (or `$HERMES_HOME/.env`), and leaves the other lines of the file as they are. `aquaman hermes setup --dry-run` prints the block and writes nothing:

```bash
# >>> aquaman managed >>>
AQUAMAN_LOOPBACK_URL=http://127.0.0.1:8585
AQUAMAN_LOOPBACK_TOKEN=aqm_lb_...
ANTHROPIC_BASE_URL=http://127.0.0.1:8585/anthropic
ANTHROPIC_API_KEY=aqm_lb_...
OPENAI_BASE_URL=http://127.0.0.1:8585/openai/v1
OPENAI_API_KEY=aqm_lb_...
# <<< aquaman managed <<<
```

- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set to the listener's access token, not to a key. The token only lets a local process use the proxy. The proxy removes it and adds the real key from your vault.
- The OpenAI base URL ends in `/openai/v1` because the OpenAI client appends `/chat/completions` to it. The Anthropic one ends in `/anthropic` because the Anthropic client appends `/v1/messages`.
- Both pairs are written when both services are in `credentials.proxiedServices` in `~/.aquaman/config.yaml`, which they are by default. A provider whose key is not in the vault answers 401 with the command that adds it.
- Which provider and model Hermes uses is still set in Hermes' own configuration. aquaman sets the base URL and the key variable and nothing else.
- A key that is already an item in your password manager can be linked instead of typed: `aquaman credentials link openai/api_key '<locator>'`, approved by you in a dialog ([locator forms](agent-setup.md#an-item-that-is-already-in-the-vault)).

If `~/.hermes/.env` already had an `OPENAI_API_KEY=sk-...` line, delete it: setup adds its block and does not remove yours.

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
- **Keys that were already in `~/.hermes/.env` are not removed by setup.** The person deletes those lines, and rotates the keys if anything they do not trust could have read the file.
- **The daemon does not come back by itself.** `aquaman daemon` is gone after a reboot or logout, and Hermes' provider calls fail until the person starts it again. Tell them. `aquaman service install` makes it start at every login: [Start the aquaman daemon at login](autostart.md).

## Good to know

- The listener is on `127.0.0.1`, off until `aquaman hermes setup`, and every request must carry a per-install token.
- A managed `/etc/hermes/.env` overrides `~/.hermes/.env` and bypasses the proxy; `aquaman hermes doctor` detects it.
- With `gateway.multiplex_profiles`, each profile needs the aquaman block.
- The plugin runs under `plugins.isolation: host` (checked with `hermes plugins validate` on Hermes 0.23.1).

More: [aquaman-hermes README](../packages/hermes/README.md)
