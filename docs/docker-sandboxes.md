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

These commands are for a person in their own terminal: `aquaman setup` asks questions, `aquaman credentials add` asks for the value (hidden), and `aquaman daemon` stays running. An agent setting up a coding project uses [`aquaman init --agent`](agent-setup.md) instead.

`sbx` runs that command from a background service without your shell's `PATH`, which is why step 5 stores absolute paths. Repeat steps 4 and 5 per service.

## Good to know

- For a service `sbx` has no built-in definition for, give the secret its destination hosts too: since sbx 0.51 a custom secret without them is not substituted.
- In a script, pass `--force` instead of piping a confirmation (sbx 0.48+).
- `aquaman get` only works for references you allowed, and each read is in `aquaman audit tail`.
- Docker's proxy does the injecting here; aquaman supplies the value. The value is handed to `sbx`, so this path is about where secrets live and who read them, not about hiding them from `sbx`.

More: [main README](../README.md)
