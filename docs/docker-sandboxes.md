# Docker Sandboxes secrets from 1Password, Bitwarden or your keychain

Docker Sandboxes (`sbx`) already keeps credentials out of the sandbox: a proxy on your machine injects them, and the agent in the VM sees a placeholder. By default the values come from your OS keychain. Point `sbx` at aquaman to source them from any vault aquaman supports, with an allow-list and an audit entry for each read.

```bash
npm install -g aquaman-proxy
aquaman setup                                        # 1. pick your vault
aquaman daemon &                                     # 2. start the daemon
aquaman credentials add github token                 # 3. store the secret, if it is not there yet
aquaman broker allow aquaman://github/token          # 4. allow it to be handed out

sbx secret set github \
  --command "$(command -v node) $(command -v aquaman) get aquaman://github/token" \
  --refresh on-demand                                # 5. sbx reads it from aquaman
```

`sbx` runs that command from a background service without your shell's `PATH`, which is why step 5 stores absolute paths. Repeat steps 4 and 5 per service.

## A secret that is already in your vault

If the token is already an item in 1Password, Bitwarden, HashiCorp Vault, the Keychain, KeePassXC or Keeper, do not type it again. Link the reference to the item in place of step 3. Requires aquaman 0.19.0 or later.

With 1Password (`aquaman setup --backend 1password`, the `op` CLI signed in):

```bash
aquaman daemon &                                                   # the daemon shows the approval dialog
aquaman credentials link github/token 'op://Private/GitHub/token'  # you allow it in the dialog
aquaman broker allow aquaman://github/token

sbx secret set github \
  --command "$(command -v node) $(command -v aquaman) get aquaman://github/token" \
  --refresh on-demand
```

With Bitwarden (`aquaman setup --backend bitwarden`, the `bw` CLI logged in):

```bash
export BW_SESSION="$(bw unlock --raw)"                             # unlock; the session exists in this shell only
aquaman daemon &                                                   # started from the same shell, so it has the session
aquaman credentials link github/token 'bw://GitHub/password'       # you allow it in the dialog
aquaman broker allow aquaman://github/token

sbx secret set github \
  --command "$(command -v node) $(command -v aquaman) get aquaman://github/token" \
  --refresh on-demand
```

- **The locator names one field of one item.** 1Password: `op://<vault>/<item>/[<section>/]<field>`. Bitwarden: `bw://<item id or exact item name>/<field>`, where the field is `password`, `username`, `notes` or the name of a custom field. If two Bitwarden items have the same name, use the item id. The forms for the other vaults are in [the agent contract](agent-setup.md#an-item-that-is-already-in-the-vault).
- **`aquaman credentials link` opens a dialog** that names the reference and the item. Nothing in your vault is read before you allow it. Then aquaman reads the item once to check it, and records your approval in the vault. Exit code 0 means linked, 2 means you denied it, 3 means nobody answered, 1 means it was refused or the daemon is not running.
- **aquaman only reads a linked item.** It never changes or deletes it. After you change the value in the item, `sbx` gets the new one once the daemon's cache of the old one has expired (15 minutes by default with 1Password and Bitwarden). `aquaman credentials unlink github/token` removes the link and leaves the item alone.
- **`aquaman broker allow` is a separate step on purpose.** A link alone does not let `aquaman get` hand the value out.
- Reading linked items is tested against stand-ins for the `op` and `bw` CLIs, not against live accounts.

## The Bitwarden session

The Bitwarden backend runs the `bw` CLI, and `bw` only reads a vault that is unlocked. aquaman does not unlock it and never asks for your master password. It takes the session key from `BW_SESSION` in the environment of the process that runs `aquaman daemon`, keeps it in that process's memory and passes it to each `bw` it starts. `aquaman setup --backend bitwarden` stops with the unlock command if the vault is locked and no session is set.

- **Where the session is:** in your shell's environment and in the daemon's. aquaman does not write it to `config.yaml` or anywhere else on disk.
- **How long it lasts:** until `bw lock` or `bw logout`, per Bitwarden's documentation. After that the daemon's reads fail until you unlock again and restart the daemon from a shell that has the new `BW_SESSION`.
- **Values are cached in the daemon's memory for 15 minutes** by default with Bitwarden, so `sbx` asking often does not start `bw` each time. `credentials.cacheTtlSeconds: 0` in `~/.aquaman/config.yaml` turns that off.
- **`aquaman service install` does not carry the session.** A daemon started at login does not inherit your shell, and aquaman writes no secret into the login item. `install` and `aquaman service status` name `BW_SESSION` under `env_not_passed`. With Bitwarden, start the daemon by hand from a shell where the vault is unlocked. The same holds for a HashiCorp Vault token in `VAULT_TOKEN` and a 1Password service account token in `OP_SERVICE_ACCOUNT_TOKEN`. The macOS Keychain needs nothing from the environment, so the login item works with it: [Start the aquaman daemon at login](autostart.md).

## A service sbx has no built-in definition for

`sbx secret set <service>` covers the services Docker lists in its credentials guide (Anthropic, OpenAI, GitHub and others). For any other API, Docker's guide documents `sbx secret set-custom`, which takes the destination hosts, the variable name the sandbox sees, and the same `--command` source. For Stripe:

```bash
aquaman credentials add stripe secret_key                  # or link an existing item, as above
aquaman broker allow aquaman://stripe/secret_key

sbx secret set-custom \
  --host api.stripe.com \
  --env STRIPE_SECRET_KEY \
  --command "$(command -v node) $(command -v aquaman) get aquaman://stripe/secret_key"
```

What is and is not confirmed here: the flags are the ones in [Docker's credentials guide](https://docs.docker.com/ai/sandboxes/configuration/credentials/), read on 2026-11-18, which shows `set-custom` with `--host`, `--env` and `--command`, says custom secrets from a command are resolved on demand by default, and marks custom secrets as experimental ("Behavior, flags, and the placeholder format may change without notice"). The aquaman side (`aquaman get` printing a declared reference) is tested. The `set-custom` command above was not run against `sbx` for this page, so check it with `sbx secret ls --host api.stripe.com` and one request from a sandbox.

## Cloud sandboxes

This page is for sandboxes on your machine. Docker's documentation for cloud sandboxes says the cloud secret commands do not support `--ref` and `--command` sources, so a cloud sandbox cannot read from aquaman this way.

## If you are an agent

- **Hand the setup to the person.** `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden), `aquaman credentials link` opens a dialog for them, and `aquaman daemon` stays running. Give them the commands above; never ask for a secret in the conversation.
- **Use a locator only if the person gave it to you.** Do not guess vault, item or field names: the dialog shows them exactly what you wrote.
- **Where the secret ends up:** `sbx` receives the value and its proxy injects it; the agent in the sandbox sees a placeholder. aquaman decides which references may be read and records each read. It does not hide the value from `sbx`.
- **The daemon does not come back by itself.** `aquaman daemon` is gone after a reboot or logout, and `sbx` cannot read the secret until the person starts it again. Tell them. `aquaman service install` makes it start at every login: [Start the aquaman daemon at login](autostart.md).

## Good to know

- For a service `sbx` has no built-in definition for, give the secret its destination hosts too: since sbx 0.51 a custom secret without them is not substituted.
- In a script, pass `--force` instead of piping a confirmation (sbx 0.48+).
- `aquaman get` only works for references you allowed, and each read is in `aquaman audit tail`.
- Docker's proxy does the injecting here; aquaman supplies the value. The value is handed to `sbx`, so this path is about where secrets live and who read them, not about hiding them from `sbx`.

More: [main README](../README.md)
