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
aquaman daemon &                                                   # starts with the vault locked, unless this shell has a BW_SESSION
aquaman unlock                                                     # Bitwarden asks for your master password; the daemon gets the session
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

The Bitwarden backend runs the `bw` CLI, and `bw` only reads a vault that is unlocked. aquaman never asks for your master password. The daemon starts with the vault locked, and `aquaman unlock`, run in a terminal, opens it: Bitwarden's own `bw unlock` asks for the master password there, and aquaman hands the session key that comes out to the running daemon over its Unix socket.

- **Where the session is:** in the daemon's memory. aquaman does not write it to `config.yaml`, the keychain, the login item or anywhere else on disk, does not print it, and does not put it into a command's arguments. The daemon passes it to each `bw` it starts, in that process's environment.
- **How long it lasts:** until the daemon stops, until `aquaman lock`, or until Bitwarden ends it. Bitwarden's documentation says a session key is valid until `bw lock` or `bw logout`, and the CLI's help for `bw unlock` says that unlocking ends earlier session keys. After that `aquaman get` fails with the code `vault_locked` and the fix `Run: aquaman unlock`, and `sbx` gets no value until you have run it. The daemon does not have to be restarted.
- **Until you unlock,** `aquaman get` exits non-zero and prints nothing on stdout, so `sbx` is not handed an empty or wrong secret.
- **Values are cached in the daemon's memory for 15 minutes** by default with Bitwarden, so `sbx` asking often does not start `bw` each time. `credentials.cacheTtlSeconds: 0` in `~/.aquaman/config.yaml` turns that off. `aquaman lock` drops the cached values together with the session. A session ended with `bw lock` is noticed at the next read that reaches `bw`, so a value already cached can be served until its 15 minutes are over.
- **A `BW_SESSION` in the shell still works.** A daemon started from a shell where `BW_SESSION` holds a session `bw` accepts starts unlocked, and `aquaman unlock` in such a shell hands that session over without asking for the password again.
- **With `aquaman service install`** the daemon starts at login without a session, because aquaman writes no secret into the login item. Run `aquaman unlock` once after logging in: [Bitwarden: unlock after you log in](autostart.md#bitwarden-unlock-after-you-log-in). A HashiCorp Vault token in `VAULT_TOKEN` and a 1Password service account token in `OP_SERVICE_ACCOUNT_TOKEN` are not carried into the login item either, and for those the daemon is started by hand from a shell that has them. The macOS Keychain needs nothing from the environment.
- **Some commands read the vault themselves,** from your shell and not through the daemon: `aquaman setup`, `aquaman credentials add`, `list`, `delete` and `unlink`, and `aquaman audit verify`. They need a session in that shell. Unlock there first (`export BW_SESSION="$(bw unlock --raw)"`) and then run `aquaman unlock` in the same shell, so the daemon is handed that same session. Unlocking a second time would end the first session, the daemon's with it. `aquaman get`, `aquaman request` and `aquaman credentials link` go through the daemon and need nothing in the shell.

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

Run with `sbx` 0.54.0 and aquaman 0.19.0: `sbx` stored the secret, printed the placeholder it generated for the variable, and listed the command as an on-demand source; aquaman's audit log showed the read `sbx` made to check it. The same run stored a built-in service with `sbx secret set github --command ... --refresh on-demand`, which `sbx` answered with "command resolved successfully". `sbx` calls custom secrets experimental, and says a command source runs from a fresh temporary directory, which is why the command holds absolute paths.

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
