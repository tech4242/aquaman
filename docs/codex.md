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

A dialog opens and waits 90 seconds for you; you type the token there. Codex gets the reference, not the value. The commands Codex runs, and the app they start, hold the token while they run; it is kept out of the transcript and your repository. Or add it yourself: `aquaman credentials add github token` (run it in your own terminal; it asks for the value, hidden), then `aquaman coder bind GITHUB_TOKEN=aquaman://github/token`.

Your app does not change: it reads `GITHUB_TOKEN` from its environment as before. aquaman is how the variable gets set on your machine while Codex works. In CI and production the same name is filled from that platform's own secrets.

## Good to know

- Output of wrapped commands is scrubbed of injected values. Codex gives hooks no way to rewrite other output, so for unwrapped commands aquaman can only warn.
- For Codex's own model key, use `aquaman get` as the provider auth command: `[model_providers.openai.auth] command = "aquaman"`, `args = ["get", "aquaman://openai/api_key"]`.
- If the daemon is not running, the hook refuses shell commands in the project instead of running them without their credentials. `aquaman` commands are never refused. Unless the person has installed the login item (`aquaman service install`, see [autostart](autostart.md)), the daemon is gone after a reboot: run `aquaman init --agent codex --no-hooks` again (it leaves installed hooks in place).
- Codex's own credential masking is under development and off by default (`credential_masking` in its feature list, read 2026-11-16). When it ships it will cover values that are already in environment variables or files; aquaman's part is getting them out of those and into a vault.
- `aquaman coder doctor` checks the hooks, their trust state and the sandbox profile.

More: [aquaman-coder README](../packages/coder/README.md) · [contract for agents](agent-setup.md)
