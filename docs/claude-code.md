# Keep API keys out of Claude Code

Claude Code can read your `.env` files and anything in its shell environment. aquaman keeps the keys in your vault instead and injects them into each command Claude runs, so the keys never enter the conversation, the transcript or a file in your repo.

## Set up

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app
aquaman init --agent claude-code
```

That starts the aquaman daemon, installs a `PreToolUse`/`PostToolUse` hook in `~/.claude/settings.json` (user level, so it loads in every project and acts only in ones registered with aquaman), installs the `aquaman-credentials` skill, registers the directory as a project and adds a short block to `CLAUDE.md`. Restart Claude Code afterwards. You can also just ask Claude to run it: the command never prompts. The full list of what it changes, and how to undo it, is in [Using aquaman from an AI agent](agent-setup.md#what-init-changes).

## Add a credential

Either let Claude ask for it when a task needs one:

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN
```

A dialog opens and waits 90 seconds for you; you type the token there. Claude gets the reference, not the value. Or add it yourself beforehand:

```bash
aquaman credentials add github token
aquaman coder bind GITHUB_TOKEN=aquaman://github/token
```

## See it work

Ask Claude to run `printenv GITHUB_TOKEN` in that project. The transcript shows `[REDACTED:injected-value]`: the command had the real token, Claude did not see it.

That is the protection: the commands Claude runs, and the app they start, hold the key while they run; Claude, the transcript and your repository never do.

## What happens under the hood

- The hook rewrites each Bash command to run under `aquaman-coder exec`, which fetches the project's references from the daemon over a Unix socket and sets them for that one command.
- Output is scrubbed of every injected value, plus common secret shapes, before Claude sees it.
- Your `deny` and `ask` permission rules still apply to the original command. **A command no rule matches runs without a permission prompt in a project that has a binding with a credential behind it**, because the hook answers `allow` for what it wraps. Add `ask` rules for anything you want to keep confirming.
- Each read is written to a hash-chained audit log: `aquaman audit tail`.

## Good to know

- **Sandbox:** Claude Code's sandbox blocks Unix sockets. On macOS setup allowlists the aquaman socket. On Linux and WSL2 only `sandbox.network.allowAllUnixSockets: true` works, which opens every socket.
- **If the daemon is not running**, the hook refuses shell commands in the project instead of running them without their credentials, and says how to start it. `aquaman` commands are never refused. The daemon is not a system service: after a reboot, run `aquaman init --agent claude-code` again (it changes nothing else) or `aquaman daemon` in a terminal of your own.
- **If the hook itself cannot start** (for example aquaman was uninstalled), Claude Code runs the command without credentials. `aquaman coder setup claude-code --fail-closed` blocks it instead (Claude Code 2.1.295+).
- **Monitor commands** are not wrapped.
- `aquaman coder doctor` checks all of this.

More: [aquaman-coder README](../packages/coder/README.md) · [contract for agents](agent-setup.md)
