# Give Codex a token without a .env file

Codex runs shell commands with whatever is in the environment and can read `.env` files in the workspace. aquaman keeps the secret in your vault and injects it into each command Codex runs, so it is never in a file Codex can read or in the transcript.

## Set up

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app
aquaman init --agent codex
```

That starts the aquaman daemon, writes hooks to `~/.codex/hooks.json` (user level; they act only in directories registered with aquaman), installs the `aquaman-credentials` skill in `~/.agents/skills/`, registers the directory as a project and adds a short block to `AGENTS.md`. The full list of what it changes, and how to undo it, is in [Using aquaman from an AI agent](agent-setup.md#what-init-changes).

Two things only you can do, and `init` lists them:

1. **Trust the hooks.** Start `codex` and approve the aquaman hooks in the startup hook review. Codex skips new hooks until you do.
2. **Let the sandbox reach the daemon.** Add a permissions profile to `~/.codex/config.toml`; `aquaman coder setup codex` prints it with your paths:

   ```toml
   default_permissions = "aquaman"

   [permissions.aquaman]
   extends = ":workspace"

   [permissions.aquaman.network]
   enabled = true
   unix_sockets = { "/Users/you/.aquaman/proxy.sock" = "allow" }
   ```

   On Codex 0.169 `enabled = true` gives sandboxed commands outbound network access and every Unix socket, not only this one. Check that against your own policy.

## Add a credential

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN
```

A dialog opens and waits 90 seconds for you; you type the token there. Codex gets the reference, not the value. The commands Codex runs, and the app they start, hold the token while they run; Codex, the transcript and your repository never do. Or add it yourself: `aquaman credentials add github token`, then `aquaman coder bind GITHUB_TOKEN=aquaman://github/token`.

## Good to know

- Output of wrapped commands is scrubbed of injected values. Codex gives hooks no way to rewrite other output, so for unwrapped commands aquaman can only warn.
- For Codex's own model key, use `aquaman get` as the provider auth command: `[model_providers.openai.auth] command = "aquaman"`, `args = ["get", "aquaman://openai/api_key"]`.
- If the daemon is not running, the hook refuses shell commands in the project instead of running them without their credentials. `aquaman` commands are never refused. The daemon is not a system service: after a reboot, run `aquaman init --agent codex` again.
- Codex's own credential masking is under development and off by default (`credential_masking` in its feature list, read 2026-11-16). When it ships it will cover values that are already in environment variables or files; aquaman's part is getting them out of those and into a vault.
- `aquaman coder doctor` checks the hooks, their trust state and the sandbox profile.

More: [aquaman-coder README](../packages/coder/README.md) · [contract for agents](agent-setup.md)
