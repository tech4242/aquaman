# Keep API keys out of Claude Code

Claude Code can read your `.env` files and anything in its shell environment. aquaman keeps the keys in your vault instead and injects them into each command Claude runs, so the keys never enter the conversation, the transcript or a file in your repo.

## Set up

```bash
npm install -g aquaman-proxy aquaman-coder
cd ~/code/my-app
aquaman init --agent claude-code --no-hooks
```

That starts the aquaman daemon, installs the `aquaman-credentials` skill, registers the directory as a project and adds a short block to `CLAUDE.md`. It writes nothing to `~/.claude/settings.json` and aquaman answers no permission prompt. You can also just ask Claude to run it: the command never prompts. The full list of what it changes, and how to undo it, is in [Your agent asked to use aquaman](approve.md).

Claude then runs the commands that need a key as `aquaman-coder exec -- <command>`; the skill and the block in `CLAUDE.md` tell it so. Your `deny` and `ask` rules match the text of a command, so write the ones you care about for the prefixed form as well (`Bash(aquaman-coder exec -- git push:*)`).

## With the hook, so commands need no prefix

```bash
aquaman init --agent claude-code
```

This also installs a `PreToolUse`/`PostToolUse` hook in `~/.claude/settings.json` (user level, so it loads in every project and acts only in ones registered with aquaman). Restart Claude Code afterwards so it loads the hook. Every shell command in the project is then wrapped for you, your `deny` and `ask` rules keep seeing the original command, and secret-shaped strings are scrubbed from every tool's output. The cost: the hook answers the permission prompt for what it wraps (see below).

## Add a credential

Either let Claude ask for it when a task needs one:

```bash
aquaman request aquaman://github/token --env GITHUB_TOKEN
```

A dialog opens and waits 90 seconds for you; you type the token there. Claude gets the reference, not the value. Or add it yourself beforehand:

```bash
aquaman credentials add github token      # run this yourself: it asks for the value, hidden
aquaman coder bind GITHUB_TOKEN=aquaman://github/token
```

Your app does not change: it reads `process.env.GITHUB_TOKEN` as before. aquaman is how the variable gets set on your machine while Claude works. In CI and production the same name is filled from that platform's own secrets.

## See it work

Ask Claude to run `aquaman-coder exec -- printenv GITHUB_TOKEN` in that project (with the hook, plain `printenv GITHUB_TOKEN`). The transcript shows `[REDACTED:injected-value]`: the command had the real token, Claude did not see it.

That is the protection: the commands Claude runs, and the app they start, hold the key while they run; Claude, the transcript and your repository never do.

## What happens under the hood

- The hook rewrites each Bash command to run under `aquaman-coder exec`, which fetches the project's references from the daemon over a Unix socket and sets them for that one command.
- Output is scrubbed of every injected value, plus common secret shapes, before Claude sees it.
- With the hook, your `deny` and `ask` permission rules still apply to the original command. **A command no rule matches runs without a permission prompt in a project that has a binding with a credential behind it**, because the hook answers `allow` for what it wraps. Add `ask` rules for anything you want to keep confirming.
- Each read is written to a hash-chained audit log: `aquaman audit tail`.

## Good to know

- **Sandbox:** Claude Code's sandbox blocks Unix sockets. On macOS the hook setup allowlists the aquaman socket; with `--no-hooks` add it yourself (`aquaman coder doctor` shows the entry). On Linux and WSL2 only `sandbox.network.allowAllUnixSockets: true` works, which opens every socket.
- **If the daemon is not running**, `aquaman-coder exec` stops and says how to start it; in hook mode the hook refuses shell commands in the project instead of running them without their credentials. `aquaman` commands are never refused. The daemon is not a system service: after a reboot, run `aquaman init --agent claude-code --no-hooks` again (it changes nothing else, and leaves an installed hook in place) or `aquaman daemon` in a terminal of your own.
- **If the hook itself cannot start** (for example aquaman was uninstalled), Claude Code runs the command without credentials. `aquaman coder setup claude-code --fail-closed` blocks it instead (Claude Code 2.1.295+).
- **Monitor commands** are not wrapped.
- `aquaman coder doctor` checks all of this.

More: [aquaman-coder README](../packages/coder/README.md) · [contract for agents](agent-setup.md)
