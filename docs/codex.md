# Give Codex a token without a .env file

Codex runs shell commands with whatever is in the environment and can read `.env` files in the workspace. aquaman keeps the secret in your vault and injects it into each command Codex runs, so it is never in a file Codex can read or in the transcript.

## Set up

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app
aquaman init --agent codex --no-hooks
```

That starts the aquaman daemon, installs the `aquaman-credentials` skill in `~/.agents/skills/`, registers the directory as a project and adds a short block to `AGENTS.md`. It writes no `hooks.json`, so there is nothing to trust at startup. Codex then runs the commands that need a key as `aquaman-coder exec -- <command>`. The full list of what it changes, and how to undo it, is in [Your agent asked to use aquaman](approve.md).

One thing only you can do, and `init` lists it:

**Let the sandbox reach the daemon.** Add a permissions profile to `~/.codex/config.toml`, with the socket path for your home directory; `aquaman coder doctor` checks it:

```toml
default_permissions = "aquaman"

[permissions.aquaman]
extends = ":workspace"

[permissions.aquaman.network]
enabled = true
unix_sockets = { "/Users/you/.aquaman/proxy.sock" = "allow" }
```


On Codex 0.169 `enabled = true` gives sandboxed commands outbound network access and every Unix socket, not only this one. Check that against your own policy.

## With the hooks, so commands need no prefix

`aquaman init --agent codex` also writes hooks to `~/.codex/hooks.json` (user level; they act only in directories registered with aquaman). Start `codex` and approve the aquaman hooks in the startup hook review: Codex skips new hooks until you do. Every shell command in the project is then wrapped for you.

## Add a credential

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN
```

A dialog opens and waits 90 seconds for you; you type the token there. Codex gets the reference, not the value. If the token is already an item in your vault, add `--from '<locator>'` and you approve that item instead of typing ([worked example](#worked-example-two-tokens-that-are-already-in-1password)). The commands Codex runs, and the app they start, hold the token while they run; it is kept out of the transcript and your repository. Or add it yourself: `aquaman credentials add github token` (run it in your own terminal; it asks for the value, hidden), then `aquaman coder bind GITHUB_TOKEN=aquaman://github/token`.

Your app does not change: it reads `GITHUB_TOKEN` from its environment as before. aquaman is how the variable gets set on your machine while Codex works. In CI and production the same name is filled from that platform's own secrets.

## Worked example: two tokens that are already in 1Password

`GITHUB_TOKEN` for `npm test` and `NPM_TOKEN` for `npm publish --dry-run`, both already items in 1Password. Nothing is typed again and nothing is copied out of 1Password. Requires aquaman 0.19.0 or later.

Once, in your own terminal, make 1Password aquaman's vault (the `op` CLI has to be signed in; the wizard also offers to store provider keys, press Enter to skip them):

```bash
aquaman setup --backend 1password
```

Then, in the project, you or Codex:

```bash
aquaman init --agent codex --no-hooks
aquaman request aquaman://github/token --env GITHUB_TOKEN --from 'op://Private/GitHub/token'
aquaman request aquaman://npm/token    --env NPM_TOKEN    --from 'op://Private/npm/token'

aquaman-coder exec -- npm test
aquaman-coder exec -- npm publish --dry-run
```

- Each `request` opens an approval dialog that names the reference and the 1Password item. You allow it; nothing is typed. aquaman reads the item only after you agree, and the status is `linked`.
- The locators are yours to give: `op://<vault>/<item>/[<section>/]<field>`. Codex should not guess them, because the dialog shows you exactly what it wrote.
- `aquaman-coder exec` sets both variables for that one command and scrubs their values from its output. npm uses `NPM_TOKEN` only where your `.npmrc` refers to it (`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`).
- aquaman only reads the two items. `aquaman credentials unlink github/token` removes a link and leaves the item as it was.
- With another vault only the locator changes: `bw://GitHub/password` for Bitwarden, `keychain://<service>/<account>` for the Keychain, and so on ([all forms](agent-setup.md#an-item-that-is-already-in-the-vault)).

**Compared with `op run`.** For these two commands `op run --env-file` gives the same protection: the command holds the real value while it runs and its output is masked. If that is all you need and you use 1Password, it is the smaller tool. What aquaman adds:

- Codex can ask for a credential it does not have and you approve it in a dialog, without editing a reference file.
- One audit log of each read (`aquaman audit tail`), shared with the other hosts aquaman serves: Claude Code, Codex, OpenClaw, Hermes, Docker Sandboxes and OpenShell.
- The same commands with a different vault, if 1Password is not where every secret lives.

What it does not add: the command still receives the real value, here as with `op run`. Only a binding made with `--via-proxy` keeps the value out of the program, and that needs an HTTP API whose client accepts a base URL ([guide](app-through-proxy.md)). Reading linked items is tested against a stand-in for the `op` CLI, not against a live 1Password account, and 1Password in desktop-app mode can ask you to unlock when the daemon reads.

## Good to know

- Output of wrapped commands is scrubbed of injected values. Codex gives hooks no way to rewrite other output, so for unwrapped commands aquaman can only warn.
- For the model key of a provider you define in Codex's config, `aquaman get` can be the provider's auth command: see [helper commands](helper-commands.md). Codex refuses an auth command on its built-in `openai` provider.
- If the daemon is not running, the hook refuses shell commands in the project instead of running them without their credentials. `aquaman` commands are never refused. Unless the person has installed the login item (`aquaman service install`, see [autostart](autostart.md)), the daemon is gone after a reboot: run `aquaman init --agent codex --no-hooks` again (it leaves installed hooks in place).
- Codex's own credential masking is under development and off by default (`credential_masking` in its feature list, read 2026-11-16). When it ships it will cover values that are already in environment variables or files; aquaman's part is getting them out of those and into a vault.
- `aquaman coder doctor` checks the hooks, their trust state and the sandbox profile.

More: [aquaman-coder README](../packages/coder/README.md) · [contract for agents](agent-setup.md)
